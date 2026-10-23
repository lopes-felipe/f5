import { randomUUID } from "node:crypto";
import { realpath as fsRealpath } from "node:fs/promises";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import type { ChromeLeaseHolder } from "@t3tools/contracts";
import type { ClaudeChromeRecord } from "@t3tools/shared/providerIntegrationCertification";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ChromeArtifactCache } from "./chromeArtifactCache";
import {
  chromeLaunchDecision,
  type ChromeLaunchDecision,
  type ChromeNativeHostDescriptor,
  type ChromeServerStatus,
} from "./chromeNativeHost";
import {
  ChromeLaunchTimeout,
  ChromeNativeHostTransactions,
  type ChromeNativeHostTransaction,
} from "./chromeNativeHostJournal";
import type { PersistentChromeNativeHostStorage } from "./chromeNativeHostStorage";
import {
  CLAUDE_IN_CHROME_EXTERNAL_CONFLICT,
  CLAUDE_IN_CHROME_START_FAILED,
  classifyClaudeChromeTool,
  type ClaudeChromeToolClass,
} from "./Layers/claudeAgentBrowser";

export interface ChromeRuntimeSession {
  readonly threadId: string;
  readonly generation: string;
  readonly providerHome: string;
  readonly providerInstanceId: string;
}

/** One Chrome tool call, as both the hook and the permission callback see it. */
export interface ChromeInvocation {
  readonly toolName: string;
  readonly input: unknown;
  /** The SDK's reported server provenance, when present. */
  readonly provenance?: { readonly name: string; readonly source: string } | undefined;
  readonly toolUseId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly generation: string;
  /** After an approval wait: never reuse an earlier inspection. */
  readonly fresh?: boolean;
}

export type ChromeBindingState =
  | "preparing"
  | "pending"
  | "connected"
  | "failed"
  | "external-cli-conflict"
  | "retiring";

interface Binding {
  readonly session: ChromeRuntimeSession;
  readonly holder: ChromeLeaseHolder;
  transaction?: ChromeNativeHostTransaction;
  decision: ChromeLaunchDecision;
  state: ChromeBindingState;
  detail?: string;
  /** Advances on every verification change; tool-use reuse is keyed by it. */
  epoch: number;
  readonly inspected: Map<string, number>;
  leaseHeld: boolean;
}

/** Covers a settings read and one IPC round trip to main under load; still fails closed. */
export const CHROME_ADMISSION_DEADLINE_MS = 1_000;

export interface ChromeRuntimeDeps {
  readonly descriptor: ChromeNativeHostDescriptor;
  readonly record: ClaudeChromeRecord;
  readonly storage: PersistentChromeNativeHostStorage;
  readonly profileId: string;
  readonly userHome: string;
  readonly executableRealpath: string;
  readonly acquire: (holder: ChromeLeaseHolder) => Promise<void>;
  readonly release: (holder: ChromeLeaseHolder) => void;
  readonly validate: (holder: ChromeLeaseHolder) => Promise<void>;
  readonly consent: (
    session: ChromeRuntimeSession,
    decision: Extract<ChromeLaunchDecision, { kind: "needs-consent" }>,
  ) => Promise<boolean>;
  readonly paused: (threadId: string) => boolean;
  /** Live per-thread policy (project overrides included). */
  readonly policyEnabled: (threadId: string) => Promise<boolean>;
  /** The broker's current session generation for the thread. */
  readonly currentGeneration: (threadId: string) => string | undefined;
  readonly cache?: ChromeArtifactCache;
  readonly realpath?: (path: string) => Promise<string>;
  readonly launchTimeoutMs?: number;
}

const withDeadline = <A>(promise: Promise<A>, ms: number, fallback: A): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * A certified launch uses this flow rather than invoking journal primitives directly.
 * Consent, registration drift, ownership and restoration remain host-owned; Chrome tools
 * fail closed until the server and registration are verified.
 */
export class ChromeSessionRuntime {
  private readonly sessions = new Map<string, Binding>();
  private readonly transactions: ChromeNativeHostTransactions;
  private readonly cache: ChromeArtifactCache;
  private readonly realpath: (path: string) => Promise<string>;
  constructor(private readonly deps: ChromeRuntimeDeps) {
    this.transactions = new ChromeNativeHostTransactions(deps.storage);
    this.cache = deps.cache ?? new ChromeArtifactCache();
    this.realpath = deps.realpath ?? fsRealpath;
  }
  get toolNames(): ReadonlyArray<string> {
    return this.deps.record.toolNames ?? [];
  }

  private current(threadId: string, generation: string): Binding | undefined {
    const binding = this.sessions.get(threadId);
    return binding?.session.generation === generation ? binding : undefined;
  }

  async prepare(session: ChromeRuntimeSession): Promise<ChromeLaunchDecision> {
    // Never let a late finalizer or prepare overwrite a replacement session.
    if (this.sessions.has(session.threadId)) throw new Error("Chrome session already exists.");
    const holder: ChromeLeaseHolder = {
      profileId: this.deps.profileId,
      threadId: session.threadId,
      sessionGeneration: session.generation,
      provider: this.deps.descriptor.provider,
    };
    const binding: Binding = {
      session,
      holder,
      decision: { kind: "off" },
      state: "preparing",
      epoch: 0,
      inspected: new Map(),
      leaseHeld: false,
    };
    this.sessions.set(session.threadId, binding);
    const live = () => this.sessions.get(session.threadId) === binding;
    try {
      await this.deps.acquire(holder);
      binding.leaseHeld = true;
      await this.deps.validate(holder);
      if (!live()) throw new Error("Chrome setup interrupted.");
      const observed = await this.deps.storage.inspect();
      const targetPath = this.deps.descriptor.expectedTarget(session.providerHome);
      const accepted = (await this.deps.storage.listTransactions(this.deps.descriptor.provider))
        .filter(
          (entry) =>
            entry.profileId === this.deps.profileId &&
            entry.providerInstanceId === session.providerInstanceId &&
            entry.state === "launched" &&
            entry.launchVerified === true &&
            entry.targetPath === targetPath,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      let decision = chromeLaunchDecision({
        enabled: true,
        certified: true,
        descriptor: this.deps.descriptor,
        providerHome: session.providerHome,
        profileId: this.deps.profileId,
        providerInstanceId: session.providerInstanceId,
        registrations: observed,
        ...(accepted
          ? {
              accepted: {
                profileId: accepted.profileId,
                providerInstanceId: accepted.providerInstanceId,
                targetPath: accepted.targetPath,
                acceptedForeign: accepted.acceptedForeign,
              },
            }
          : {}),
      });
      let acceptedForeign = accepted?.acceptedForeign ?? [];
      if (decision.kind === "needs-consent") {
        const approved = await this.deps.consent(session, decision);
        if (!live() || !approved) decision = { kind: "off", detail: "Chrome setup was declined." };
        else {
          acceptedForeign = observed
            .filter(
              (entry) => !entry.shadowed && entry.state === "ok" && entry.targetPath !== targetPath,
            )
            .map((entry) => ({ location: entry.location, sha256: entry.sha256! }));
          decision = { kind: "launch", targetPath };
        }
      }
      if (decision.kind !== "launch") {
        binding.decision = decision;
        binding.state = "failed";
        this.releaseLease(binding);
        return decision;
      }
      // Admission is re-checked after consent and immediately before the spawn: turning
      // the toggle off while the dialog was open cancels setup.
      if (
        !live() ||
        this.deps.paused(session.threadId) ||
        !(await this.deps.policyEnabled(session.threadId))
      )
        throw new Error("Chrome setup interrupted.");
      binding.transaction = await this.transactions.approve({
        provider: this.deps.descriptor.provider,
        profileId: this.deps.profileId,
        providerInstanceId: session.providerInstanceId,
        recordId: this.deps.record.id,
        ...(this.deps.record.evidenceId ? { evidenceId: this.deps.record.evidenceId } : {}),
        ...(this.deps.record.versions.sdkVersion
          ? { sdkVersion: this.deps.record.versions.sdkVersion }
          : {}),
        executablePath: this.deps.executableRealpath,
        providerHome: session.providerHome,
        userHome: this.deps.userHome,
        targetPath,
        wrapperLocation: targetPath,
        observed,
        acceptedForeign,
      });
      if (!live() || !(await this.deps.policyEnabled(session.threadId)))
        throw new Error("Chrome setup interrupted.");
      binding.decision = { kind: "launch", targetPath };
      binding.state = "pending";
      return binding.decision;
    } catch (error) {
      binding.state = "failed";
      this.releaseLease(binding);
      throw error;
    }
  }

  /**
   * The CLI reported `claude-in-chrome` connected: verify server provenance, then wait
   * for the registrations to land. Chrome tools stay denied until both succeed.
   */
  async connected(
    threadId: string,
    generation: string,
    status: ChromeServerStatus | undefined,
  ): Promise<boolean> {
    const binding = this.current(threadId, generation);
    if (!binding || !binding.transaction) return false;
    if (binding.state === "connected") {
      // Live re-check: any provenance mismatch invalidates immediately.
      if (await this.verifyServer(status)) return true;
      this.invalidate(
        threadId,
        generation,
        "failed",
        "Claude in Chrome's connection changed. Reconnect it in F5.",
      );
      return false;
    }
    // Failed and conflicted sessions return only through an explicit reconnect.
    if (binding.state !== "pending") return false;
    const serverOk = await this.verifyServer(status);
    if (this.current(threadId, generation) !== binding) return false;
    if (!serverOk) {
      this.invalidate(
        threadId,
        generation,
        "failed",
        "F5 could not verify the Chrome server's provenance.",
      );
      return false;
    }
    try {
      binding.transaction = await this.transactions.recordLaunch(binding.transaction, {
        verifyWrapper: (bytes) =>
          this.deps.descriptor.verifyWrapper?.(
            bytes,
            this.deps.executableRealpath,
            this.realpath,
          ) ?? Promise.resolve(false),
        allowedOrigins: this.deps.descriptor.allowedOrigins,
        ...(this.deps.launchTimeoutMs !== undefined
          ? { timeoutMs: this.deps.launchTimeoutMs }
          : {}),
      });
    } catch (error) {
      if (error instanceof ChromeLaunchTimeout) binding.transaction = error.transaction;
      this.invalidate(threadId, generation, "failed", CLAUDE_IN_CHROME_START_FAILED);
      return false;
    }
    if (this.current(threadId, generation) !== binding || binding.state !== "pending") return false;
    binding.state = "connected";
    binding.epoch += 1;
    return true;
  }

  /** Live status re-check; any mismatch invalidates verification immediately. */
  verifyServer(status: ChromeServerStatus | undefined): Promise<boolean> {
    return (
      this.deps.descriptor.verifyServer?.(status, {
        executableRealpath: this.deps.executableRealpath,
        toolNames: this.toolNames,
        realpath: this.realpath,
      }) ?? Promise.resolve(false)
    );
  }

  /** Startup never connected (or a later check failed): reconcile and keep restorable. */
  async startupFailed(
    threadId: string,
    generation: string,
    detail = CLAUDE_IN_CHROME_START_FAILED,
  ): Promise<void> {
    const binding = this.current(threadId, generation);
    if (!binding) return;
    this.invalidate(threadId, generation, "failed", detail);
    const transaction = binding.transaction;
    if (transaction)
      binding.transaction = await this.transactions.reconcile(transaction).catch(() => transaction);
  }

  invalidate(
    threadId: string,
    generation: string,
    state: "failed" | "external-cli-conflict",
    detail: string,
  ): void {
    const binding = this.current(threadId, generation);
    if (!binding || binding.state === "retiring") return;
    binding.state = state;
    binding.detail = detail;
    binding.epoch += 1;
    binding.inspected.clear();
  }

  /** Explicit user reconnect: back to pending; nothing is trusted until re-verified. */
  reconnecting(threadId: string, generation: string): void {
    const binding = this.current(threadId, generation);
    if (!binding || binding.state === "retiring" || !binding.transaction) return;
    binding.state = "pending";
    delete binding.detail;
    binding.epoch += 1;
    binding.inspected.clear();
    this.cache.invalidate();
  }

  status(
    threadId: string,
    generation: string,
  ): { state: ChromeBindingState; detail?: string } | undefined {
    const binding = this.current(threadId, generation);
    return binding
      ? { state: binding.state, ...(binding.detail ? { detail: binding.detail } : {}) }
      : undefined;
  }

  classify(
    invocation: Pick<ChromeInvocation, "toolName" | "input" | "provenance">,
    trusted: boolean,
  ): ClaudeChromeToolClass {
    const provenanceOk =
      !invocation.provenance ||
      (invocation.provenance.name === this.deps.record.identity.mcpServerName &&
        invocation.provenance.source === "dynamic");
    return classifyClaudeChromeTool({
      toolName: invocation.toolName,
      toolInput: invocation.input,
      trusted: trusted && provenanceOk,
      toolNames: this.toolNames,
    });
  }

  /** Registration snapshot unchanged since the verified launch; zero reads when unchanged. */
  private async registrationUnchanged(transaction: ChromeNativeHostTransaction): Promise<boolean> {
    for (const entry of transaction.launchSnapshot ?? []) {
      if (entry.shadowed) continue;
      const current = await this.cache.read(entry.location);
      if ((current.sha256 ?? undefined) !== entry.sha256) return false;
    }
    const wrapper = transaction.slots.find((slot) => slot.kind === "wrapper");
    if (wrapper) {
      const current = await this.cache.read(wrapper.location);
      if (!current.sha256 || current.sha256 !== wrapper.postLaunchHash) return false;
    }
    return true;
  }

  /**
   * Per-call admission: live policy, the current non-retiring generation, a verified
   * server and registration, healthy desktop ownership, an unchanged registration
   * snapshot and a recognized operation. Fails closed at a 1 s deadline.
   */
  admit(invocation: ChromeInvocation, threadId: string): Promise<string | undefined> {
    // A timeout resolves with its own message; only a thrown check maps to "changed".
    return withDeadline(
      this.admitNow(invocation, threadId),
      CHROME_ADMISSION_DEADLINE_MS,
      "Chrome control could not be verified in time. Try again.",
    ).catch(() => "Chrome setup changed or failed verification. Reconnect Chrome before using it.");
  }
  private async admitNow(
    invocation: ChromeInvocation,
    threadId: string,
  ): Promise<string | undefined> {
    if (invocation.signal?.aborted) return "Chrome call was cancelled.";
    if (!(await this.deps.policyEnabled(threadId)))
      return "Claude in Chrome is turned off for this project in F5 settings.";
    if (this.deps.paused(threadId)) return "Computer control is paused. Ask the user to resume.";
    const binding = this.current(threadId, invocation.generation);
    if (!binding || this.deps.currentGeneration(threadId) !== invocation.generation)
      return "Chrome integration is unavailable for this session.";
    if (binding.state === "external-cli-conflict") return CLAUDE_IN_CHROME_EXTERNAL_CONFLICT;
    if (binding.state !== "connected" || !binding.transaction?.launchVerified)
      return binding.detail ?? "Claude in Chrome isn't connected yet.";
    const classified = this.classify(invocation, true);
    if (classified.kind === "protocol-drift") {
      this.invalidate(
        threadId,
        invocation.generation,
        "failed",
        "Claude in Chrome changed its tool protocol. Update F5.",
      );
      return "Claude in Chrome changed its tool protocol. Update F5.";
    }
    if (classified.kind === "untrusted")
      return "This Chrome tool isn't from Claude's verified Chrome connection.";
    if (classified.kind === "unsupported")
      return "This Chrome action isn't supported in F5 (unsupported-operation).";
    try {
      await this.deps.validate(binding.holder);
    } catch (error) {
      if (error instanceof ComputerControlError && error.error._tag === "Interrupted")
        return "Chrome control was interrupted. Ask the user to resume.";
      if (error instanceof ComputerControlError && error.error._tag === "Execution")
        return error.error.message;
      return "Chrome control isn't available from the desktop right now.";
    }
    const key = invocation.toolUseId;
    const reuse =
      !invocation.fresh && key !== undefined && binding.inspected.get(key) === binding.epoch;
    if (!reuse) {
      if (!(await this.registrationUnchanged(binding.transaction))) {
        this.invalidate(
          threadId,
          invocation.generation,
          "external-cli-conflict",
          CLAUDE_IN_CHROME_EXTERNAL_CONFLICT,
        );
        return CLAUDE_IN_CHROME_EXTERNAL_CONFLICT;
      }
      if (key !== undefined) {
        if (binding.inspected.size > 256) binding.inspected.clear();
        binding.inspected.set(key, binding.epoch);
      }
    }
    // Pause, policy and generation are re-checked after the awaits above.
    if (this.current(threadId, invocation.generation) !== binding || this.deps.paused(threadId))
      return "Chrome session was interrupted.";
    if (binding.state !== "connected")
      return binding.detail ?? "Chrome integration is unavailable.";
    return undefined;
  }

  /**
   * Launch configuration only. Health (`pending`, `connected`, `failed`, conflicts) is
   * reported live through the session's configured event and never restarts it: a failed
   * startup keeps the session running until the user reconnects.
   */
  fingerprint(threadId: string): string {
    const decision = this.sessions.get(threadId)?.decision;
    return JSON.stringify({
      kind: decision?.kind ?? "off",
      target: decision?.kind === "launch" ? decision.targetPath : undefined,
    });
  }

  private releaseLease(binding: Binding): void {
    if (!binding.leaseHeld) return;
    binding.leaseHeld = false;
    this.deps.release(binding.holder);
  }

  /**
   * Idempotent finalizer: reconciles partial setup writes and settles ownership even
   * when earlier cleanup threw. Main keeps the lease until it observes the CLI exit.
   */
  async finalize(threadId: string, generation: string): Promise<void> {
    const binding = this.current(threadId, generation);
    if (!binding) return;
    binding.state = "retiring";
    this.sessions.delete(threadId);
    try {
      if (binding.transaction) await this.transactions.reconcile(binding.transaction);
    } finally {
      this.releaseLease(binding);
    }
  }

  dispose(): void {
    this.cache.dispose();
  }
}

export function chromeRuntimeHost(input: {
  broker: ComputerAutomationBrokerRuntime;
  descriptor: ChromeNativeHostDescriptor;
  record: ClaudeChromeRecord;
  storage: PersistentChromeNativeHostStorage;
  userHome: string;
  executableRealpath: string;
  policyEnabled: (threadId: string) => Promise<boolean>;
}) {
  const { broker } = input;
  return new ChromeSessionRuntime({
    descriptor: input.descriptor,
    record: input.record,
    storage: input.storage,
    userHome: input.userHome,
    executableRealpath: input.executableRealpath,
    policyEnabled: input.policyEnabled,
    profileId: broker.host.profileId,
    currentGeneration: (threadId) => broker.generation(threadId),
    acquire: async (holder) => {
      await broker.host.correlated(
        { type: "chromeLeaseAcquire", requestId: randomUUID(), holder },
        5000,
        false,
      );
    },
    release: (holder) =>
      broker.host.send({ type: "chromeLeaseRelease", requestId: randomUUID(), holder }),
    validate: async (holder) => {
      if (broker.chromeRecoveryRequired())
        throw new ComputerControlError({
          _tag: "Execution",
          message: "Browser control from an earlier session hasn't stopped yet.",
        });
      await broker.host.correlated(
        { type: "chromeLeaseValidate", requestId: randomUUID(), holder },
        5000,
        false,
      );
    },
    paused: (threadId) => broker.pause.has(threadId),
    consent: (session, decision) =>
      broker.requestChromeSetup(session.threadId, session.generation, {
        provider: input.descriptor.provider,
        previousTargets: decision.previousTargets,
        targetPath: decision.targetPath,
      }),
  });
}
