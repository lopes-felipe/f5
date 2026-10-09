import { randomUUID } from "node:crypto";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import type { ChromeLeaseHolder } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  ChromeNativeHostTransactions,
  chromeLaunchDecision,
  type ChromeNativeHostDescriptor,
  type ChromeNativeHostTransaction,
  type ChromeLaunchDecision,
} from "./chromeNativeHost";
import type { PersistentChromeNativeHostStorage } from "./chromeNativeHostStorage";

export interface ChromeRuntimeSession {
  readonly threadId: string;
  readonly generation: string;
  readonly providerHome: string;
}
interface Binding {
  readonly session: ChromeRuntimeSession;
  readonly holder: ChromeLeaseHolder;
  transaction?: ChromeNativeHostTransaction;
  decision: ChromeLaunchDecision;
  launched: boolean;
  healthy: boolean;
}

/** A certified launch uses this flow rather than invoking transaction primitives
 * directly. Consent, registration drift, leases, and restoration remain host-owned. */
export class ChromeSessionRuntime {
  private readonly sessions = new Map<string, Binding>();
  private readonly transactions: ChromeNativeHostTransactions;
  constructor(
    private readonly input: {
      descriptor: ChromeNativeHostDescriptor;
      storage: PersistentChromeNativeHostStorage;
      profileId: string;
      acquire: (holder: ChromeLeaseHolder) => Promise<void>;
      release: (holder: ChromeLeaseHolder) => void;
      validate?: (holder: ChromeLeaseHolder) => Promise<void>;
      consent: (
        session: ChromeRuntimeSession,
        decision: Extract<ChromeLaunchDecision, { kind: "needs-consent" }>,
      ) => Promise<boolean>;
      paused: (threadId: string) => boolean;
    },
  ) {
    this.transactions = new ChromeNativeHostTransactions(input.storage);
  }

  async prepare(session: ChromeRuntimeSession, enabled: boolean): Promise<ChromeLaunchDecision> {
    if (!enabled || !this.input.descriptor.certified) return { kind: "off" };
    // Never let a late finalizer or prepare overwrite a replacement session.
    if (this.sessions.has(session.threadId)) throw new Error("Chrome session already exists.");
    const holder: ChromeLeaseHolder = {
      profileId: this.input.profileId,
      threadId: session.threadId,
      sessionGeneration: session.generation,
      provider: this.input.descriptor.provider,
    };
    const binding: Binding = {
      session,
      holder,
      decision: { kind: "off" },
      healthy: true,
      launched: false,
    };
    this.sessions.set(session.threadId, binding);
    try {
      await this.input.acquire(holder);
      await this.input.validate?.(binding.holder);
      if (this.sessions.get(session.threadId) !== binding)
        throw new Error("Chrome setup interrupted.");
      const observed = await this.input.storage.inspect();
      const accepted = (await this.input.storage.listTransactions(this.input.descriptor.provider))
        .filter(
          (entry) =>
            entry.profileId === this.input.profileId &&
            entry.state !== "restored" &&
            entry.targetPath === this.input.descriptor.expectedTarget(session.providerHome),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      let decision = chromeLaunchDecision({
        enabled,
        descriptor: this.input.descriptor,
        providerHome: session.providerHome,
        registrations: observed,
        managedTargets: new Set(),
        ...(accepted ? { accepted } : {}),
      });
      if (decision.kind === "needs-consent") {
        const approved = await this.input.consent(session, decision);
        if (this.sessions.get(session.threadId) !== binding || !approved)
          decision = { kind: "off" };
      }
      if (!("targetPath" in decision)) {
        binding.decision = decision;
        this.input.release(holder);
        return decision;
      }
      if (this.sessions.get(session.threadId) !== binding || this.input.paused(session.threadId))
        throw new Error("Chrome setup interrupted.");
      // Even absence/current-profile setup gets a transaction: it must be reversible.
      binding.transaction = await this.transactions.approve({
        provider: this.input.descriptor.provider,
        profileId: this.input.profileId,
        targetPath: decision.targetPath,
        observed,
      });
      binding.decision = { kind: "launch", targetPath: decision.targetPath };
      return binding.decision;
    } catch (error) {
      binding.healthy = false;
      this.input.release(holder);
      throw error;
    }
  }
  fingerprint(threadId: string): string {
    const binding = this.sessions.get(threadId);
    return JSON.stringify({
      kind: binding?.decision.kind ?? "off",
      target: binding?.transaction?.targetPath,
      healthy: binding?.healthy ?? false,
    });
  }
  verifyServer(status: unknown): boolean {
    return this.input.descriptor.verifyServer?.(status) === true;
  }
  markUnhealthy(threadId: string, generation: string): void {
    const binding = this.sessions.get(threadId);
    if (binding?.session.generation === generation) binding.healthy = false;
  }
  async connected(threadId: string, generation: string): Promise<void> {
    const binding = this.sessions.get(threadId);
    if (
      !binding ||
      binding.session.generation !== generation ||
      !binding.transaction ||
      binding.launched
    )
      return;
    try {
      binding.transaction = await this.transactions.recordLaunch(binding.transaction);
      binding.launched = true;
    } catch (error) {
      binding.healthy = false;
      throw error;
    }
  }
  async beforeTool(
    threadId: string,
    generation: string,
    enabled: boolean,
  ): Promise<string | undefined> {
    const binding = this.sessions.get(threadId);
    if (!enabled) return "Chrome integration is turned off in F5 settings.";
    if (this.input.paused(threadId)) return "Computer control is paused. Ask the user to resume.";
    if (
      !binding ||
      binding.session.generation !== generation ||
      !binding.healthy ||
      binding.decision.kind !== "launch" ||
      !binding.transaction
    )
      return "Chrome integration is unavailable for this session.";
    try {
      await this.input.validate?.(binding.holder);
      if (!binding.launched) {
        await this.connected(threadId, generation);
      } else {
        const current = await this.input.storage.inspect();
        if (
          current.some((entry) => entry.state === "unreadable" || entry.state === "malformed") ||
          binding.transaction.registrations.some(
            (entry) =>
              entry.postLaunchHash &&
              current.find((after) => after.location === entry.location)?.sha256 !==
                entry.postLaunchHash,
          )
        )
          throw new Error("Chrome registration changed.");
      }
      if (this.sessions.get(threadId) !== binding || this.input.paused(threadId))
        return "Chrome session was interrupted.";
      return undefined;
    } catch (error) {
      if (error instanceof ComputerControlError && error.error._tag === "Interrupted")
        return "Chrome control was interrupted. Ask the user to resume.";
      binding.healthy = false;
      // Keep the lease until the CLI exits; its native host may still be active.
      return "Chrome setup changed or failed verification. Restart the session before using Chrome.";
    }
  }
  release(threadId: string, generation: string): void {
    const binding = this.sessions.get(threadId);
    if (!binding || binding.session.generation !== generation) return;
    this.sessions.delete(threadId);
    this.input.release(binding.holder);
  }
  async listTransactions() {
    return (await this.input.storage.listTransactions(this.input.descriptor.provider))
      .filter((entry) => entry.profileId === this.input.profileId)
      .map(({ id, provider, targetPath, createdAt, state }) => ({
        id,
        provider,
        targetPath,
        createdAt,
        state,
      }));
  }
  async restore(id: string, stopSessions: () => Promise<void>) {
    const transaction = await this.input.storage.loadTransaction(
      this.input.descriptor.provider,
      id,
    );
    if (!transaction || transaction.profileId !== this.input.profileId)
      throw new Error("Chrome transaction does not belong to this profile.");
    if (transaction.state === "restored") return { transaction, restored: [], skipped: [] };
    await stopSessions();
    const holder: ChromeLeaseHolder = {
      profileId: this.input.profileId,
      threadId: randomUUID(),
      sessionGeneration: randomUUID(),
      provider: this.input.descriptor.provider,
    };
    await this.input.acquire(holder);
    try {
      return await this.transactions.restore(transaction, async () => {});
    } finally {
      this.input.release(holder);
    }
  }
}

export function chromeRuntimeHost(input: {
  broker: ComputerAutomationBrokerRuntime;
  descriptor: ChromeNativeHostDescriptor;
  storage: PersistentChromeNativeHostStorage;
}) {
  const { broker } = input;
  return new ChromeSessionRuntime({
    ...input,
    profileId: broker.host.profileId,
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
