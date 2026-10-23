import type { ComputerAgentProvider } from "@t3tools/shared/agentAutomationSupport";
import { selectComputerApp, appTier, grantAllows } from "@t3tools/shared/computerApps";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { createHash, randomUUID } from "node:crypto";
import { Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ThreadId,
  type AgentComputerUseChanged,
  ComputerGrant,
  ComputerLeaseHolder,
  type ComputerDelivery,
  type ComputerElementAction,
  type ComputerExecutionState,
  type ComputerLeaseScope,
  type ComputerPauseCause,
  type ComputerAutomationRequest,
  type ComputerAuthorization,
  type ComputerAccessRequested,
  type ComputerActivity,
  type ComputerToolOutcomeCode,
  type ComputerInspectResult,
  type ComputerApp,
  type DesktopComputerHostMessage,
  type ChromeLeaseHolder,
  type ChromeProcessRegistration,
} from "@t3tools/contracts";
import {
  ComputerControlError,
  computerRequestPayload,
  isComputerMutation,
} from "@t3tools/shared/computerControl";
import {
  computerBackgroundOpAllowed,
  computerOpRequiresApp,
} from "@t3tools/shared/computerExecution";
import { ServerConfig } from "../config";

/**
 * Electron decides every takeover: its worst case is 300 s consent + 30 s idle window + up to
 * 5 s drain and 1 s readiness per arming attempt. This sits well above that and below the
 * tool transport timeout.
 */
export const COMPUTER_TAKEOVER_HOST_TIMEOUT_MS = 360_000;
import { ServerSettingsService } from "../serverSettings";
import { writeFileStringAtomically } from "../atomicWrite";
import { resolveAgentBrowserPolicy, type AgentBrowserPolicy } from "../mcp/browserAccess";
import { AutomationQueue } from "../mcp/automationQueue";
import { AgentControlPause, AgentControlPauseService } from "../mcp/agentControlPause";
import { DesktopComputerHost } from "./DesktopComputerHost";
import { computerAccessStorage } from "./computerAccessStorage";
import { ComputerAccessService } from "./ComputerAccessService";

export interface ComputerInvocationContext {
  readonly threadId: string;
  readonly sessionGeneration: string;
  readonly projectId: string;
  readonly turnId: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly provider: ComputerAgentProvider;
  readonly threadTitle: string;
  readonly policy: AgentBrowserPolicy;
}
interface ComputerBinding {
  generation: string;
  provider: ComputerAgentProvider;
  holder?: ComputerLeaseHolder;
  turnId?: string;
  turnRevision: number;
  endedTurnId?: string;
  /** Monotonic; every policy transition bumps it before any async work. */
  policyRevision: number;
  /** The policy last applied to this binding, compared on settings changes. */
  appliedPolicy?: string;
  takeover?: { acquireId: string; approvalId: string; appId: string };
}
/** Bounded summary of the merged lease state for the WebSocket banner. */
export interface ComputerUseSnapshot {
  readonly holders: ReadonlyArray<{
    threadId: string;
    leaseHeld?: boolean;
    backend?: ComputerLeaseHolder["backend"];
    delivery: ComputerDelivery;
    appId?: string;
    appName?: string;
    state: ComputerExecutionState;
    pauseCause?: ComputerPauseCause;
  }>;
  readonly pendingTakeover?: {
    threadId: string;
    appId: string;
    appName?: string;
    state: ComputerExecutionState;
  };
  readonly otherProfile: boolean;
}
/** WebSocket shape of the merged snapshot. */
export function agentComputerUsePush(
  snapshot: ComputerUseSnapshot,
): typeof AgentComputerUseChanged.Type {
  return {
    holders: snapshot.holders.map((holder) => ({
      ...holder,
      threadId: ThreadId.makeUnsafe(holder.threadId),
    })),
    ...(snapshot.pendingTakeover
      ? {
          pendingTakeover: {
            ...snapshot.pendingTakeover,
            threadId: ThreadId.makeUnsafe(snapshot.pendingTakeover.threadId),
          },
        }
      : {}),
    otherProfile: snapshot.otherProfile,
  };
}
export type ComputerBrokerEvent =
  | {
      channel: "computer.access.requested";
      data: ComputerAccessRequested & { backendIncarnation: string; expiresAtMs?: number };
    }
  | {
      channel: "computer.access.settled";
      data: { requestId: string; threadId: string; allowed: boolean };
    }
  | {
      channel: "computer.access.grantsChanged";
      data: { threadId: string; grants: ReadonlyArray<ComputerGrant>; grantVersion: number };
    }
  | { channel: "computer.activity"; data: ComputerActivity }
  | { channel: "computer.host"; data: DesktopComputerHostMessage }
  /** Observations (screenshots, geometry, app records) for this thread are no longer valid. */
  | { channel: "computer.observations.invalidated"; data: { threadId: string; cause?: "action" } }
  /** The merged lease/execution state changed; republish the banner. */
  | { channel: "computer.use.changed"; data: ComputerUseSnapshot };
export class ComputerAutomationBroker extends ServiceMap.Service<
  ComputerAutomationBroker,
  ComputerAutomationBrokerRuntime
>()("t3/computer/ComputerAutomationBroker") {}
export class ComputerAutomationBrokerRuntime {
  readonly pause: AgentControlPause;
  readonly access: ComputerAccessService;
  private readonly bindings = new Map<string, ComputerBinding>();
  /**
   * Last policy revision per thread, kept after a session is released. Electron's minimum
   * revision per thread only grows, so a replacement session must continue from here.
   */
  private readonly threadRevisions = new Map<string, number>();
  /** Admission barrier: while closed, new invocations wait for the policy transition. */
  private admissionsClosed = 0;
  private admissionsReopened: Promise<void> = Promise.resolve();
  private reopenAdmissions: () => void = () => {};
  private readonly executionStates = new Map<
    string,
    {
      state: ComputerExecutionState;
      appId?: string;
      delivery?: ComputerDelivery;
      pauseCause?: ComputerPauseCause;
    }
  >();
  private pendingTakeover: { threadId: string; appId: string } | undefined;
  private readonly appNames = new Map<string, string>();
  private readonly queue = new AutomationQueue<ComputerControlError>({
    capacity: 16,
    busy: () => new ComputerControlError({ _tag: "Busy", holder: "same-profile" }),
    cancelled: () => new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }),
    expired: () =>
      new ComputerControlError({
        _tag: "Execution",
        message: "Computer request expired before execution.",
      }),
  });
  private readonly inFlight = new Map<
    string,
    {
      threadId: string;
      generation: string;
      turnId: string;
      epoch: number;
      suppressActivity?: boolean;
    }
  >();
  private readonly waits = new Map<
    string,
    {
      generation: string;
      turnId?: string;
      cancel: (cause: "paused" | "turn-ended" | "policy-changed") => void;
    }
  >();
  private readonly observationEpochs = new Map<string, number>();
  private readonly listeners = new Set<(event: ComputerBrokerEvent) => void>();
  private readonly nativePaused = new Set<string>();
  private mainHolders: ReadonlyArray<ComputerLeaseHolder> = [];
  private chromeHolder: ChromeLeaseHolder | null = null;
  private readonly setupConsents = new Map<
    string,
    {
      threadId: string;
      generation: string;
      settle: (allowed: boolean) => void;
      session: boolean;
    }
  >();
  /** In-memory per-generation grants for proxied integrations. */
  private readonly sessionConsents = new Set<string>();
  private readonly sessionConsentRequests = new Map<string, Promise<boolean>>();
  private nativeOtherProfile = false;
  private chromeOtherProfile = false;
  private chromeRecovery = false;
  private readonly offHost: () => void;
  private readonly offPause: () => void;
  constructor(
    readonly host: DesktopComputerHost,
    private readonly options: {
      resolve: (
        threadId: string,
        sessionGeneration: string,
        provider: ComputerAgentProvider,
      ) => Promise<ComputerInvocationContext>;
      storage: ConstructorParameters<typeof ComputerAccessService>[0]["storage"];
      platform: "darwin" | "win32";
      pause?: AgentControlPause;
    },
  ) {
    this.pause = options.pause ?? new AgentControlPause();
    this.offPause = this.pause.subscribe((threadId, paused) => {
      const binding = this.bindings.get(threadId);
      if (paused && binding) {
        this.host.send({ type: "pauseChanged", threadId, paused });
        this.invalidateObservations(threadId);
        this.cancelTurn(threadId, binding.generation, binding.turnId, "paused");
      }
    });
    this.access = new ComputerAccessService({
      platform: options.platform,
      forgotten: (projectId, appId) => this.host.send({ type: "grantForget", projectId, appId }),
      backendIncarnation: host.backendIncarnation,
      storage: options.storage,
      request: (request, expiresAtMs) => {
        this.publish({
          channel: "computer.access.requested",
          data: { ...request, backendIncarnation: host.backendIncarnation, expiresAtMs },
        });
        host.send({ type: "accessRequested", request });
      },
      settled: (requestId, threadId, allowed) => {
        host.send({ type: "cancel", requestId });
        this.publish({
          channel: "computer.access.settled",
          data: { requestId, threadId, allowed },
        });
      },
      changed: (threadId) => {
        this.waits.get(threadId)?.cancel("policy-changed");
        this.invalidateObservations(threadId);
        const binding = this.bindings.get(threadId);
        if (!binding) return;
        this.pushGrants(
          threadId,
          binding.generation,
          binding.turnId ?? "observation",
          binding.holder?.executionGeneration ?? 1,
        );
        this.publish({
          channel: "computer.access.grantsChanged",
          data: {
            threadId,
            grants: this.access.grants(threadId),
            grantVersion: this.access.version(threadId),
          },
        });
      },
    });
    this.offHost = host.onMessage((message) => {
      if (
        message.type === "killSwitch" &&
        !this.matchesTurn(message.threadId, message.sessionGeneration, message.turnId)
      )
        return;
      if (message.type === "leaseChanged") {
        this.mainHolders = message.holder ? [message.holder] : [];
        this.nativeOtherProfile = message.otherProfile ?? false;
        this.leasesUpdated();
      }
      if (message.type === "leasesChanged") {
        this.mainHolders = message.holders;
        this.nativeOtherProfile = message.otherProfile;
        this.pendingTakeover = message.pendingTakeover;
        this.leasesUpdated();
      }
      if (message.type === "executionStateChanged") {
        const binding = this.bindings.get(message.threadId);
        if (binding?.generation === message.sessionGeneration) {
          if (message.state === null) this.executionStates.delete(message.threadId);
          else
            this.executionStates.set(message.threadId, {
              state: message.state,
              ...(message.appId ? { appId: message.appId } : {}),
              ...(message.delivery ? { delivery: message.delivery } : {}),
              ...(message.pauseCause ? { pauseCause: message.pauseCause } : {}),
            });
          if (message.state === "paused" || message.state === "recovery")
            this.invalidateObservations(message.threadId);
          this.publishUse();
        }
      }
      if (message.type === "chromeLeaseChanged") {
        this.chromeHolder = message.holder;
        this.chromeOtherProfile = message.otherProfile ?? false;
        this.chromeRecovery = message.recoveryRequired ?? false;
        this.publishUse();
      }
      if (
        message.type === "status" &&
        !message.status.available &&
        message.status.reason === "no-host"
      ) {
        this.mainHolders = [];
        this.chromeHolder = null;
        this.pendingTakeover = undefined;
        this.executionStates.clear();
        this.nativeOtherProfile = false;
        this.chromeOtherProfile = false;
        for (const [threadId, binding] of this.bindings)
          this.releaseSession(threadId, binding.generation);
        this.publish({ channel: "computer.host", data: { type: "leaseChanged", holder: null } });
        this.publishUse();
      }
      if (message.type === "accessAnswer") {
        const setup = this.setupConsents.get(message.answer.requestId);
        if (setup && message.answer.backendIncarnation === this.host.backendIncarnation)
          setup.settle(
            this.generation(setup.threadId) === setup.generation &&
              (setup.session
                ? message.answer.allowChromeSession === true
                : message.answer.allowChromeSetup === true),
          );
        else void this.access.answerFromHost(message.answer).catch(() => undefined);
      }
      if (message.type === "pauseChanged") {
        if (message.paused) this.nativePaused.add(message.threadId);
        else this.nativePaused.delete(message.threadId);
        this.pause.set(message.threadId, message.paused);
        const binding = this.bindings.get(message.threadId);
        if (binding && message.paused)
          this.cancelTurn(message.threadId, binding.generation, binding.turnId, "paused");
      }
      if (message.type === "activity") {
        const { thumbnailDataUrl, source: _untrustedSource, ...activity } = message.activity;
        const pending = activity.requestId ? this.inFlight.get(activity.requestId) : undefined;
        const current =
          !!pending &&
          pending.threadId === activity.threadId &&
          pending.generation === activity.sessionGeneration &&
          this.generation(activity.threadId) === pending.generation &&
          pending.epoch === (this.observationEpochs.get(activity.threadId) ?? 0);
        if (pending?.suppressActivity) return;
        // Legacy peers may publish summaries, but cannot prove an image is current.
        this.publish({
          channel: "computer.activity",
          data: {
            ...activity,
            ...(thumbnailDataUrl && current && this.host.supportsActivityCorrelation()
              ? { thumbnailDataUrl }
              : {}),
          },
        });
      } else if (message.type !== "response" && message.type !== "accessAnswer")
        this.publish({ channel: "computer.host", data: message });
    });
  }
  initialize(): Promise<void> {
    return this.access.initialize();
  }
  bindSession(threadId: string, generation: string, provider: ComputerAgentProvider): void {
    if (provider !== "claude" && provider !== "codex" && !this.host.supportsAgentIdentity())
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Update F5 to use computer control with this agent.",
      });
    const previous = this.bindings.get(threadId);
    if (previous?.generation === generation) return;
    if (previous) this.releaseSession(threadId, previous.generation);
    const policyRevision = Math.max(1, this.threadRevisions.get(threadId) ?? 0);
    this.bindings.set(threadId, { generation, provider, policyRevision, turnRevision: 0 });
    this.invalidateObservations(threadId);
  }
  /** Lease holders changed on the desktop: track takeovers and clear stale observations. */
  private leasesUpdated(): void {
    for (const [threadId, binding] of this.bindings) {
      const held = this.mainHolders.find((holder) => holder.threadId === threadId);
      // A holder removed by the desktop (sweep, stop, kill switch) is no longer ours.
      if (
        binding.holder &&
        (!held || held.executionGeneration !== binding.holder.executionGeneration)
      ) {
        if (binding.holder.scope.kind !== "app") this.invalidateObservations(threadId);
        delete binding.holder;
      }
    }
    // Ordinary release ends control: only states the user must act on outlive the lease.
    for (const [threadId, execution] of this.executionStates)
      if (
        !this.mainHolders.some((holder) => holder.threadId === threadId) &&
        execution.state !== "paused" &&
        execution.state !== "recovery" &&
        this.pendingTakeover?.threadId !== threadId
      )
        this.executionStates.delete(threadId);
    this.publishUse();
  }
  private invalidateObservations(threadId: string, cause?: "action"): void {
    this.observationEpochs.set(threadId, (this.observationEpochs.get(threadId) ?? 0) + 1);
    this.publish({
      channel: "computer.observations.invalidated",
      data: { threadId, ...(cause ? { cause } : {}) },
    });
  }
  /** Merged native and Chrome holders; other profiles stay anonymous. */
  computerUse(): ComputerUseSnapshot {
    const own = this.mainHolders.filter((holder) => holder.profileId === this.host.profileId);
    const holders: Array<ComputerUseSnapshot["holders"][number]> = own.map((holder) => {
      const execution = this.executionStates.get(holder.threadId);
      const appId = holder.scope.kind === "foreground" ? undefined : holder.scope.appId;
      const appName = appId ? this.appNames.get(appId) : undefined;
      return {
        threadId: holder.threadId,
        leaseHeld: true,
        backend: holder.backend,
        delivery: holder.scope.kind === "app" ? ("background" as const) : ("foreground" as const),
        ...(appId ? { appId } : {}),
        ...(appName ? { appName } : {}),
        state: execution?.state ?? "active",
        ...(execution?.pauseCause ? { pauseCause: execution.pauseCause } : {}),
      };
    });
    // Paused and recovering threads keep their banner state after the lease is released.
    for (const [threadId, execution] of this.executionStates)
      if (
        !holders.some((holder) => holder.threadId === threadId) &&
        (execution.state === "paused" || execution.state === "recovery")
      )
        holders.push({
          threadId,
          leaseHeld: false,
          backend: "native",
          delivery: execution.delivery ?? "foreground",
          ...(execution.appId ? { appId: execution.appId } : {}),
          ...(execution.appId && this.appNames.get(execution.appId)
            ? { appName: this.appNames.get(execution.appId)! }
            : {}),
          state: execution.state,
          ...(execution.pauseCause ? { pauseCause: execution.pauseCause } : {}),
        });
    if (
      this.chromeHolder &&
      !holders.some((holder) => holder.threadId === this.chromeHolder!.threadId)
    )
      holders.push({
        threadId: this.chromeHolder.threadId,
        delivery: "foreground",
        state: "active",
      });
    const pending = this.pendingTakeover;
    const pendingState = pending ? this.executionStates.get(pending.threadId)?.state : undefined;
    return {
      holders,
      ...(pending
        ? {
            pendingTakeover: {
              threadId: pending.threadId,
              appId: pending.appId,
              ...(this.appNames.get(pending.appId)
                ? { appName: this.appNames.get(pending.appId)! }
                : {}),
              state:
                pendingState === "waiting-idle"
                  ? ("waiting-idle" as const)
                  : ("pending-consent" as const),
            },
          }
        : {}),
      otherProfile:
        this.nativeOtherProfile || this.chromeOtherProfile || this.mainHolders.length > own.length,
    };
  }
  private publishUse(): void {
    this.publish({ channel: "computer.use.changed", data: this.computerUse() });
  }
  /** Background delivery is available end to end for this backend. */
  backgroundStatus(): { available: boolean; reason?: string | undefined } {
    const status = this.host.status();
    if (this.options.platform !== "darwin")
      return { available: false, reason: "unsupported-platform" };
    if (!this.host.backgroundCapable()) return { available: false, reason: "peer-capability" };
    if (!status.available) return { available: false, reason: "permissions" };
    return status.background ?? { available: false, reason: "peer-capability" };
  }
  /** Wait while a policy transition holds admissions closed. */
  private async admitted(): Promise<void> {
    while (this.admissionsClosed > 0) await this.admissionsReopened;
  }
  /**
   * Policy admission barrier: close admissions and bump every binding's revision synchronously,
   * cancel pending consent/takeover and execution, revoke host scopes and await their drain,
   * then apply the change and reopen. Electron rejects older revisions from then on.
   */
  async policyTransition<A>(
    apply: () => Promise<A>,
    /** Projects whose threads the change affects; every thread when omitted. */
    affectsProject?: (projectId: string | undefined) => boolean,
  ): Promise<A> {
    if (this.admissionsClosed++ === 0)
      this.admissionsReopened = new Promise((resolve) => {
        this.reopenAdmissions = resolve;
      });
    try {
      // revokeBinding bumps each revision synchronously before its first await.
      await Promise.all(
        [...this.bindings]
          .filter(([threadId]) => affectsProject?.(this.access.projectId(threadId)) ?? true)
          .map(([threadId, binding]) => this.revokeBinding(threadId, binding)),
      );
      const result = await apply();
      await this.refreshPolicies();
      return result;
    } finally {
      if (--this.admissionsClosed === 0) this.reopenAdmissions();
    }
  }
  generation(threadId: string): string | undefined {
    return this.bindings.get(threadId)?.generation;
  }
  matchesTurn(threadId: string, generation: string, turnId: string): boolean {
    const binding = this.bindings.get(threadId);
    return (
      binding?.generation === generation &&
      binding.turnId === turnId &&
      binding.endedTurnId !== turnId
    );
  }
  snapshot() {
    return {
      holders: this.mainHolders,
      computerUse: this.computerUse(),
      chromeHolder: this.chromeHolder,
      otherProfile: this.nativeOtherProfile || this.chromeOtherProfile,
      pausedThreads: this.pause.list(),
      pending: this.access
        .pendingRequests()
        .map((request) => ({ ...request, backendIncarnation: this.host.backendIncarnation })),
      grants: [...this.bindings.keys()].map((threadId) => ({
        threadId,
        grants: this.access.grants(threadId),
        grantVersion: this.access.version(threadId),
      })),
    };
  }
  requestChromeSetup(
    threadId: string,
    generation: string,
    setup: NonNullable<ComputerAccessRequested["chromeSetup"]>,
  ): Promise<boolean> {
    return this.requestIntegrationConsent(threadId, generation, {
      kind: "chrome-setup",
      chromeSetup: setup,
      reason:
        "Allow this provider to replace the browser's native messaging host? F5 can restore the original setup while its registration is unchanged.",
    });
  }
  /** One dialog per session generation; the grant lives in memory only. */
  requestChromeSession(
    threadId: string,
    generation: string,
    integration: "codex-chrome" | "codex-computer",
  ): Promise<boolean> {
    const key = `${threadId}\0${generation}\0${integration}`;
    if (this.sessionConsents.has(key)) return Promise.resolve(true);
    const pending = this.sessionConsentRequests.get(key);
    if (pending) return pending;
    const request = this.requestIntegrationConsent(threadId, generation, {
      kind: "chrome-session",
      chromeSession: { integration },
      reason: "Allow this provider integration for this session?",
    }).then((allowed) => {
      this.sessionConsentRequests.delete(key);
      if (allowed && this.generation(threadId) === generation) this.sessionConsents.add(key);
      return allowed && this.generation(threadId) === generation;
    });
    this.sessionConsentRequests.set(key, request);
    return request;
  }
  /** desktop main stops and observes registered children without this server. */
  registerIntegrationProcess(registration: ChromeProcessRegistration): Promise<void> {
    return this.host
      .correlated(
        { type: "chromeProcessRegister", requestId: randomUUID(), registration },
        5000,
        false,
      )
      .then(() => undefined);
  }
  reportIntegrationExit(launchToken: string): void {
    this.host.send({ type: "chromeProcessExited", launchToken });
  }
  chromeRecoveryRequired(): boolean {
    return this.chromeRecovery;
  }
  private requestIntegrationConsent(
    threadId: string,
    generation: string,
    input: Pick<ComputerAccessRequested, "kind" | "chromeSetup" | "chromeSession" | "reason">,
  ): Promise<boolean> {
    if (this.generation(threadId) !== generation || !this.host.hasHost())
      return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), 300_000);
      const settle = (allowed: boolean) => {
        if (!this.setupConsents.delete(requestId)) return;
        clearTimeout(timer);
        this.host.send({ type: "cancel", requestId });
        this.publish({
          channel: "computer.access.settled",
          data: { threadId, requestId, allowed },
        });
        resolve(allowed);
      };
      this.setupConsents.set(requestId, {
        threadId,
        generation,
        settle,
        session: input.kind === "chrome-session",
      });
      const request: ComputerAccessRequested = {
        threadId,
        requestId,
        apps: [],
        ...input,
      };
      this.publish({
        channel: "computer.access.requested",
        data: {
          ...request,
          backendIncarnation: this.host.backendIncarnation,
          expiresAtMs: Date.now() + 300_000,
        },
      });
      this.host.send({ type: "accessRequested", request });
    });
  }
  async context(threadId: string, sessionGeneration: string): Promise<ComputerInvocationContext> {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== sessionGeneration)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const turnRevision = binding.turnRevision;
    const ctx = await this.options.resolve(threadId, sessionGeneration, binding.provider);
    if (this.bindings.get(threadId) !== binding || binding.turnRevision !== turnRevision)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    this.access.bind(threadId, ctx.projectId, sessionGeneration);
    binding.appliedPolicy ??= JSON.stringify({
      computerEnabled: ctx.policy.computerUse,
      mode: ctx.policy.computerUseExecutionMode ?? "foreground",
      passwordMasking: ctx.policy.computerUsePasswordMasking ?? "fast",
    });
    return ctx;
  }
  private authorization(
    ctx: ComputerInvocationContext,
    executionGeneration: number,
  ): ComputerAuthorization {
    return {
      profileId: this.host.profileId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      sessionGeneration: ctx.sessionGeneration,
      turnId: ctx.turnId,
      executionGeneration,
      grantVersion: this.access.version(ctx.threadId),
      grants: this.access.grants(ctx.threadId),
    };
  }
  private pushGrants(
    threadId: string,
    generation: string,
    turnId: string,
    executionGeneration: number,
  ): void {
    this.host.send({
      type: "grantsChanged",
      authorization: {
        profileId: this.host.profileId,
        ...(this.access.projectId(threadId) ? { projectId: this.access.projectId(threadId)! } : {}),
        threadId,
        sessionGeneration: generation,
        turnId,
        executionGeneration,
        grantVersion: this.access.version(threadId),
        grants: this.access.grants(threadId),
      },
    });
  }
  async invoke(
    threadId: string,
    generation: string,
    input: Record<string, unknown> & { op: ComputerAutomationRequest["op"] },
    timeoutMs = 30_000,
    options?: {
      signal?: AbortSignal;
      beforeDispatch?: () => Promise<void>;
      suppressActivity?: boolean;
      onDispatch?: (delivery: ComputerDelivery) => void;
    },
  ): Promise<unknown> {
    await this.admitted();
    const ctx = await this.context(threadId, generation);
    if (!ctx.policy.computerUse)
      throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
    const status = this.host.status();
    if (!status.available) {
      if (input.op === "status") return status;
      throw new ComputerControlError({
        _tag: "Unavailable",
        reason: status.reason,
        ...(status.missing ? { missing: status.missing } : {}),
      });
    }
    if (input.op === "status")
      return ctx.policy.computerUseExecutionMode === "background"
        ? { ...status, background: this.backgroundStatus(), executionMode: "background" }
        : status;
    const mutation = isComputerMutation(input.op);
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const revision = binding.policyRevision;
    const turnRevision = binding.turnRevision;
    if (ctx.turnId !== "observation") binding.turnId = ctx.turnId;
    const appId = typeof input.appId === "string" ? input.appId : undefined;
    const delivery = this.selectDelivery(ctx, binding, input.op, appId, {
      executionMode: input.executionMode,
      action: input.action,
    });
    delete input.executionMode;
    if (delivery === "background") {
      input.delivery = "background";
      if (computerOpRequiresApp(input.op) && !appId)
        throw new ComputerControlError({
          _tag: "Execution",
          message: "Specify app: the app to act in.",
        });
    }
    if (this.pause.has(threadId) && !["status", "listApps", "resolveApps"].includes(input.op))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    if (mutation) {
      if (ctx.turnId === "observation" || binding.endedTurnId === ctx.turnId)
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      if (this.pause.has(threadId))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      if (ctx.interactionMode === "plan")
        throw new ComputerControlError({
          _tag: "Execution",
          message: "Computer control is unavailable in plan mode.",
        });
      // Background control needs one native session approval, including full-access sessions.
      if (delivery === "background" && !this.access.backgroundApproved(threadId)) {
        await this.access.requestAccess(
          threadId,
          ctx.turnId,
          [],
          "Allow this agent session to control apps you approve, while you work elsewhere?",
          "session-actions",
          false,
          true,
        );
        if (!this.access.backgroundApproved(threadId))
          throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
      } else if (ctx.runtimeMode !== "full-access" && !this.access.actionsApproved(threadId)) {
        await this.access.requestAccess(
          threadId,
          ctx.turnId,
          [],
          "Allow this agent session to control apps you approve?",
          "session-actions",
        );
        if (!this.access.actionsApproved(threadId))
          throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
      }
    }
    const requestId = randomUUID();
    const controller = new AbortController();
    const slot = mutation
      ? await this.queue.acquire(threadId, controller.signal, Math.min(60_000, timeoutMs))
      : { release: () => undefined };
    try {
      const live = await this.context(threadId, generation);
      if (!live.policy.computerUse)
        throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
      // Revision checkpoint after context resolution and queue admission.
      this.assertRevision(binding, revision, turnRevision);
      if (
        mutation &&
        delivery === "background" &&
        live.policy.computerUseExecutionMode !== "background"
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
      if (this.pause.has(threadId) && !["status", "listApps", "resolveApps"].includes(input.op))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      if (
        mutation &&
        (this.pause.has(threadId) ||
          live.turnId !== ctx.turnId ||
          binding.endedTurnId === ctx.turnId)
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      if (mutation && live.interactionMode === "plan")
        throw new ComputerControlError({
          _tag: "Execution",
          message: "Computer control is unavailable in plan mode.",
        });
      if (mutation && live.runtimeMode !== "full-access" && !this.access.actionsApproved(threadId))
        throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
      if (typeof input.appId === "string")
        this.access.require(
          threadId,
          input.appId,
          !mutation
            ? "view"
            : input.action === "setValue" || input.op === "type"
              ? "type"
              : "click",
        );
      if (
        (input.op === "type" || input.op === "key") &&
        !this.access
          .grants(threadId)
          .some((grant) => grant.tier === "full" || (grant.tier === "click" && grant.allowTyping))
      )
        throw new ComputerControlError({ _tag: "NotGranted", needed: "type" });
      let executionGeneration = binding.holder?.executionGeneration ?? 1;
      if (mutation && delivery === "foreground" && binding.holder?.scope.kind === "takeover") {
        // The armed takeover is the lease; every foreground step reuses it.
        executionGeneration = binding.holder.executionGeneration;
      } else if (mutation) {
        const scope: ComputerLeaseScope =
          delivery === "background" ? { kind: "app", appId: appId! } : { kind: "foreground" };
        const acquisitionId = randomUUID();
        const holder = Schema.decodeUnknownSync(ComputerLeaseHolder)(
          await this.host.correlated(
            {
              type: "leaseAcquire",
              requestId: acquisitionId,
              holder: {
                ...this.authorization(live, executionGeneration),
                backend: "native",
                threadTitle: live.threadTitle,
                scope,
                policyRevision: revision,
              },
            },
            2000,
            false,
          ),
        );
        this.host.send({ type: "leaseAccepted", requestId: acquisitionId });
        // Cancellation during acquire must release the exact returned holder.
        if (
          this.bindings.get(threadId) !== binding ||
          this.pause.has(threadId) ||
          binding.endedTurnId === ctx.turnId ||
          binding.policyRevision !== revision ||
          binding.turnRevision !== turnRevision
        ) {
          this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder });
          throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        }
        binding.holder = holder;
        executionGeneration = holder.executionGeneration;
      }
      await options?.beforeDispatch?.();
      if (options?.signal?.aborted) throw options.signal.reason;
      // Revision checkpoint immediately before dispatch.
      this.assertRevision(binding, revision, turnRevision);
      this.pushGrants(threadId, generation, live.turnId, executionGeneration);
      const { passwordMasking: _callerMasking, ...payloadInput } = input;
      const currentStatus = this.host.status();
      const envelope = {
        ...payloadInput,
        // Only resolved user policy can select masking. Legacy peers strip unknown envelope
        // fields before checking hashes, so send it only to a helper that advertises support.
        ...(currentStatus.available && currentStatus.passwordMaskingSupported
          ? { passwordMasking: live.policy.computerUsePasswordMasking ?? "fast" }
          : {}),
        requestId,
        authorization: this.authorization(live, executionGeneration),
        deadlineAtMs: Date.now() + Math.min(60_000, Math.max(1, Math.floor(timeoutMs))),
        agent: { provider: live.provider, threadTitle: live.threadTitle.slice(0, 200) },
      };
      const payloadHash = createHash("sha256")
        .update(computerRequestPayload(envelope as Omit<ComputerAutomationRequest, "payloadHash">))
        .digest("hex");
      const request = Schema.decodeUnknownSync(
        (await import("@t3tools/contracts")).ComputerAutomationRequest,
      )({ ...envelope, payloadHash });
      if (mutation) this.invalidateObservations(threadId, "action");
      options?.onDispatch?.(delivery);
      this.inFlight.set(requestId, {
        threadId,
        generation,
        turnId: live.turnId,
        epoch: this.observationEpochs.get(threadId) ?? 0,
        ...(options?.suppressActivity ? { suppressActivity: true } : {}),
      });
      const onAbort = () => this.host.abandon(requestId, options!.signal!.reason);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      let result: unknown;
      try {
        const pending = this.host.request(request);
        if (options?.signal?.aborted) onAbort();
        result = await pending;
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
      }
      // A late observation from before a settings/session change must not restore old pixels.
      // Confirmed actions retain their result even when their optional capture was cancelled.
      if (!mutation) {
        if (this.bindings.get(threadId) !== binding)
          throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        this.assertRevision(binding, revision, turnRevision);
      } else if (
        (this.bindings.get(threadId) !== binding ||
          binding.policyRevision !== revision ||
          binding.turnRevision !== turnRevision) &&
        result &&
        typeof result === "object" &&
        "screenshot" in result
      ) {
        // A result can beat the desktop's cancellation receipt. Keep the successful action,
        // but never deliver its old-policy image after the user changed masking.
        const { screenshot: _oldCapture, ...action } = result;
        result = { ...action, screenshotError: "Interrupted" };
      }
      if ((input.op === "listApps" || input.op === "resolveApps") && Array.isArray(result))
        for (const app of result as ReadonlyArray<{ appId?: unknown; name?: unknown }>)
          if (typeof app.appId === "string" && typeof app.name === "string") {
            if (this.appNames.size >= 500) this.appNames.clear();
            this.appNames.set(app.appId, app.name.slice(0, 200));
          }
      return result;
    } finally {
      this.inFlight.delete(requestId);
      slot.release();
    }
  }
  private assertRevision(binding: ComputerBinding, revision: number, turnRevision: number): void {
    if (binding.turnRevision !== turnRevision)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (binding.policyRevision !== revision)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
  }
  /**
   * Background when the policy prefers it, every peer negotiated it and no takeover is armed
   * for this thread; foreground when a takeover is armed and the call targets its app; legacy
   * foreground under the foreground preference. Classification happens before any display or
   * screenshot preparation.
   */
  selectDelivery(
    ctx: ComputerInvocationContext,
    binding: ComputerBinding,
    op: ComputerAutomationRequest["op"],
    appId: string | undefined,
    input: { executionMode?: unknown; action?: unknown },
    classifyOnly = false,
  ): ComputerDelivery {
    if (op === "status" || op === "listApps" || op === "resolveApps") return "foreground";
    if (ctx.policy.computerUseExecutionMode !== "background") return "foreground";
    const background = this.backgroundStatus();
    if (!background.available)
      throw new ComputerControlError({
        _tag: "Execution",
        message: `Background computer control is unavailable (${background.reason ?? "unknown"}); set Computer use to foreground mode in Settings.`,
      });
    const takeover = binding.holder?.scope.kind === "takeover" ? binding.holder.scope : undefined;
    if (input.executionMode === "background") {
      if (takeover && !classifyOnly) this.endTakeover(ctx.threadId, binding);
    } else if (takeover && (appId === undefined || appId === takeover.appId)) return "foreground";
    else if (takeover && appId !== takeover.appId && isComputerMutation(op))
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "other-app" });
    else if (input.executionMode === "foreground")
      throw new ComputerControlError({
        _tag: "ForegroundRequired",
        reason: "unsupported-in-background",
      });
    if (
      isComputerMutation(op) &&
      !computerBackgroundOpAllowed(
        op,
        typeof input.action === "string" ? (input.action as ComputerElementAction) : undefined,
      )
    )
      throw new ComputerControlError({
        _tag: "ForegroundRequired",
        reason: "unsupported-in-background",
      });
    return "background";
  }
  /** Classify a tool call before geometry; exposed for the MCP tool layer. */
  async classify(
    threadId: string,
    generation: string,
    op: ComputerAutomationRequest["op"],
    appId: string | undefined,
    input: { executionMode?: unknown; action?: unknown },
  ): Promise<ComputerDelivery> {
    await this.admitted();
    const ctx = await this.context(threadId, generation);
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation || !ctx.policy.computerUse)
      return "foreground";
    // Classification never ends a takeover; the invocation itself does.
    return this.selectDelivery(ctx, binding, op, appId, input, true);
  }
  /** Ending a takeover revokes its receipt, drains it and clears observations. */
  private endTakeover(threadId: string, binding: ComputerBinding): void {
    if (binding.holder?.scope.kind !== "takeover") return;
    this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder: binding.holder });
    delete binding.holder;
    this.invalidateObservations(threadId);
  }
  /**
   * Explicit, natively approved foreground takeover of one app until the turn ends, the agent
   * returns to background, or a stop/policy event. Separate from `invoke`: it holds no queue
   * slot and no action deadline while the user decides and finishes their input.
   */
  async requestForeground(
    threadId: string,
    generation: string,
    query: string,
    reason: string,
  ): Promise<unknown> {
    await this.admitted();
    const ctx = await this.context(threadId, generation);
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (!ctx.policy.computerUse)
      throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
    if (ctx.turnId === "observation" || binding.endedTurnId === ctx.turnId)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (ctx.interactionMode === "plan")
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Computer control is unavailable in plan mode.",
      });
    if (this.pause.has(threadId))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    if (ctx.policy.computerUseExecutionMode !== "background")
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Foreground mode is already in effect; no takeover is needed.",
      });
    const background = this.backgroundStatus();
    if (!background.available)
      throw new ComputerControlError({
        _tag: "Execution",
        message: `Background computer control is unavailable (${background.reason ?? "unknown"}).`,
      });
    const turnRevision = binding.turnRevision;
    binding.turnId = ctx.turnId;
    const resolved = (await this.invoke(threadId, generation, {
      op: "resolveApps",
      queries: [query],
    })) as ReadonlyArray<import("@t3tools/contracts").ComputerApp>;
    const matches = selectComputerApp(resolved, query);
    if (matches.length !== 1)
      throw new ComputerControlError({
        _tag: "Execution",
        message: "App could not be resolved uniquely; use an appId from computer_list_apps.",
      });
    const app = matches[0]!;
    this.access.require(threadId, app.appId, "click");
    // A first action may be a click: ask for the session approval here rather than dead-ending
    // the agent, which has no other tool that grants it.
    if (!this.access.backgroundApproved(threadId)) {
      await this.access.requestAccess(
        threadId,
        ctx.turnId,
        [],
        "Allow this agent session to control apps you approve, while you work elsewhere?",
        "session-actions",
        false,
        true,
      );
      if (!this.access.backgroundApproved(threadId))
        throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
    }
    this.assertRevision(binding, binding.policyRevision, turnRevision);
    if (binding.holder?.scope.kind === "takeover" && binding.holder.scope.appId === app.appId)
      return { foreground: true, appId: app.appId, name: app.name };
    const revision = binding.policyRevision;
    // Same pre-consent behaviour as requestAccess: cancel and drain this thread's execution
    // without ending the turn or discarding its denial history.
    this.cancelTurn(threadId, generation, ctx.turnId, "paused", false, false);
    const acquireId = randomUUID();
    const approvalId = randomUUID();
    binding.takeover = { acquireId, approvalId, appId: app.appId };
    const live = await this.context(threadId, generation);
    const acquired = this.host.correlated(
      {
        type: "foregroundTakeoverAcquire",
        requestId: acquireId,
        approvalRequestId: approvalId,
        holder: {
          ...this.authorization(live, binding.holder?.executionGeneration ?? 1),
          backend: "native",
          threadTitle: live.threadTitle,
          scope: { kind: "takeover", appId: app.appId, approvalReceipt: approvalId },
          policyRevision: revision,
        },
      },
      COMPUTER_TAKEOVER_HOST_TIMEOUT_MS,
      false,
    );
    let consent: Promise<void>;
    try {
      consent = this.access
        .requestTakeover(
          threadId,
          { requestId: approvalId, appId: app.appId, appName: app.name, turnId: ctx.turnId },
          reason,
        )
        .then((allowed) => {
          if (!allowed)
            this.host.abandon(
              acquireId,
              new ComputerControlError({ _tag: "NotGranted", needed: "click" }),
            );
        });
    } catch (error) {
      this.host.abandon(acquireId, error as ComputerControlError);
      if (binding.takeover?.acquireId === acquireId) delete binding.takeover;
      throw error;
    }
    try {
      const holder = Schema.decodeUnknownSync(ComputerLeaseHolder)(await acquired);
      await consent.catch(() => undefined);
      this.host.send({ type: "leaseAccepted", requestId: acquireId });
      // Re-validate revision, turn, grant version and session for the exact holder.
      const current = await this.context(threadId, generation).catch(() => undefined);
      if (
        this.bindings.get(threadId) !== binding ||
        binding.takeover?.acquireId !== acquireId ||
        binding.policyRevision !== revision ||
        current?.turnId !== holder.turnId ||
        this.access.version(threadId) !== holder.grantVersion ||
        this.pause.has(threadId) ||
        binding.endedTurnId === holder.turnId ||
        binding.turnRevision !== turnRevision
      ) {
        this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder });
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      }
      binding.holder = holder;
      this.invalidateObservations(threadId);
      this.pushGrants(threadId, generation, holder.turnId, holder.executionGeneration);
      return {
        foreground: true,
        appId: app.appId,
        name: app.name,
        note: "Take a fresh computer_screenshot before coordinate actions.",
      };
    } finally {
      if (binding.takeover?.acquireId === acquireId) delete binding.takeover;
      this.access.cancelRequest(approvalId);
    }
  }
  async requestAccess(
    threadId: string,
    generation: string,
    queries: ReadonlyArray<string>,
    reason: string,
    typing = false,
  ): Promise<unknown> {
    const ctx = await this.context(threadId, generation);
    const binding = this.bindings.get(threadId)!;
    const turnRevision = binding.turnRevision;
    const apps = (await this.invoke(threadId, generation, {
      op: "resolveApps",
      queries,
    })) as ReadonlyArray<import("@t3tools/contracts").ComputerApp>;
    this.assertRevision(binding, binding.policyRevision, turnRevision);
    const before = this.access.grants(threadId);
    const resolutions = queries.map((query) => {
      const matches = selectComputerApp(apps, query);
      const app = matches.length === 1 ? matches[0] : undefined;
      return { query, matches, app };
    });
    const candidates = resolutions.flatMap(({ app }) => (app ? [app] : []));
    // User interaction with a consent dialog must not race continuing native input.
    // Keep this turn's denial history, while cancelling queued/in-flight execution.
    this.cancelTurn(threadId, generation, ctx.turnId, "paused", false, false);
    await this.access.requestAccess(threadId, ctx.turnId, candidates, reason, "apps", typing);
    const grants = this.access.grants(threadId);
    return {
      grants: grants.map((grant) => ({
        ...grant,
        // The stored flag is an extra click-tier permission, not the full tier's rights.
        typingAllowed: grantAllows(grant.tier, grant.allowTyping, "type"),
      })),
      apps: resolutions.map(({ query, matches, app }) => ({
        query,
        ...(app ? { appId: app.appId, name: app.name } : {}),
        status: !matches.length
          ? "not-found"
          : !app
            ? "ambiguous"
            : app.tier === "blocked" || appTier(app.appId, this.options.platform) === "blocked"
              ? "blocked"
              : before.some(
                    (grant) =>
                      grant.appId === app.appId &&
                      (!typing ||
                        grant.tier === "full" ||
                        (grant.tier === "click" && grant.allowTyping)),
                  )
                ? "already-granted"
                : grants.some(
                      (grant) =>
                        grant.appId === app.appId &&
                        (!typing ||
                          grant.tier === "full" ||
                          (grant.tier === "click" && grant.allowTyping)),
                    )
                  ? "allowed"
                  : "denied",
        ...(!app && matches.length
          ? { matches: matches.map(({ appId, name }) => ({ appId, name })) }
          : {}),
      })),
    };
  }
  assertRemoteResumeAllowed(threadId: string): void {
    if (
      this.nativePaused.has(threadId) ||
      this.mainHolders.some((holder) => holder.threadId === threadId) ||
      this.pendingTakeover?.threadId === threadId ||
      this.chromeHolder?.threadId === threadId
    )
      throw new Error("Resume computer control on the computer running F5.");
  }
  setPaused(threadId: string, paused: boolean): void {
    if (paused) {
      this.invalidateObservations(threadId);
      this.pause.set(threadId, true);
      this.host.send({ type: "pauseChanged", threadId, paused });
      const binding = this.bindings.get(threadId);
      if (binding) this.cancelTurn(threadId, binding.generation, binding.turnId, "paused");
    } else {
      this.assertRemoteResumeAllowed(threadId);
      this.pause.set(threadId, false);
    }
  }
  private cancelTurn(
    threadId: string,
    generation: string,
    turnId: string | undefined,
    cause: "paused" | "turn-ended",
    cancelSetup = true,
    finishAccessTurn = true,
  ): void {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation || (turnId && binding.turnId !== turnId))
      return;
    this.waits.get(threadId)?.cancel(cause);
    if (cancelSetup)
      for (const pending of this.setupConsents.values())
        if (pending.threadId === threadId && pending.generation === generation)
          pending.settle(false);
    this.queue.flush(threadId, new ComputerControlError({ _tag: "Interrupted", cause }));
    // A pending takeover (consent or idle wait) ends with the turn, a pause or a policy change.
    if (binding.takeover) {
      const { acquireId, approvalId } = binding.takeover;
      delete binding.takeover;
      this.host.abandon(acquireId, new ComputerControlError({ _tag: "Interrupted", cause }));
      this.access.cancelRequest(approvalId);
    }
    if (
      cause === "paused" ||
      [...this.inFlight.values()].some(
        (pending) =>
          pending.threadId === threadId &&
          pending.generation === generation &&
          (!turnId || pending.turnId === turnId),
      )
    )
      this.invalidateObservations(threadId);
    for (const [requestId, pending] of this.inFlight)
      if (
        pending.threadId === threadId &&
        pending.generation === generation &&
        (!turnId || pending.turnId === turnId)
      )
        this.host.send({ type: "cancel", requestId });
    if (binding.holder) {
      this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder: binding.holder });
      delete binding.holder;
    }
    if (turnId && finishAccessTurn) this.access.endTurn(threadId, turnId);
  }
  /** Pin lifecycle ownership before tool context resolution; retain no completed-turn history. */
  beginTurn(threadId: string, turnId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.turnId === turnId || binding.endedTurnId === turnId) return;
    if (binding.turnId) this.cancelTurn(threadId, binding.generation, binding.turnId, "turn-ended");
    binding.turnId = turnId;
    ++binding.turnRevision;
  }
  endTurn(threadId: string, turnId: string, generation?: string): void {
    const binding = this.bindings.get(threadId);
    if (
      !binding ||
      (generation && binding.generation !== generation) ||
      (binding.turnId && binding.turnId !== turnId) ||
      binding.endedTurnId === turnId
    )
      return;
    binding.endedTurnId = turnId;
    ++binding.turnRevision;
    // Startup waiters are pinned to the lifecycle turn before resolving context.
    const waiter = this.waits.get(threadId);
    if (waiter?.generation === binding.generation && (!waiter.turnId || waiter.turnId === turnId))
      waiter.cancel("turn-ended");
    if (binding.turnId === turnId)
      this.cancelTurn(threadId, binding.generation, turnId, "turn-ended");
  }
  releaseSession(threadId: string, generation: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation) return;
    this.cancelTurn(threadId, generation, undefined, "turn-ended");
    // Chrome owns a provider-session lease, not this native-tool binding.
    // Its adapter releases only after the CLI closes; disposing native tools
    // earlier must not expose an active native host to another profile.
    automationEventSanitizer.clear(threadId);
    this.nativePaused.delete(threadId);
    for (const key of this.sessionConsents)
      if (key.startsWith(`${threadId}\0${generation}\0`)) this.sessionConsents.delete(key);
    if (this.executionStates.delete(threadId)) this.publishUse();
    const grantVersion = this.access.version(threadId) + 1;
    this.host.send({
      type: "grantsChanged",
      authorization: {
        profileId: this.host.profileId,
        ...(this.access.projectId(threadId) ? { projectId: this.access.projectId(threadId)! } : {}),
        threadId,
        sessionGeneration: generation,
        turnId: binding.turnId ?? "observation",
        executionGeneration: binding.holder?.executionGeneration ?? 1,
        grantVersion,
        grants: [],
      },
    });
    this.publish({
      channel: "computer.access.grantsChanged",
      data: { threadId, grantVersion, grants: [] },
    });
    this.access.clearSession(threadId, generation);
    this.threadRevisions.delete(threadId);
    this.threadRevisions.set(threadId, binding.policyRevision);
    if (this.threadRevisions.size > 4096)
      this.threadRevisions.delete(this.threadRevisions.keys().next().value!);
    this.invalidateObservations(threadId);
    this.bindings.delete(threadId);
    this.observationEpochs.delete(threadId);
  }
  async refreshPolicies(): Promise<void> {
    for (const [threadId, binding] of this.bindings) {
      let computerEnabled = false;
      let chromeEnabled = false;
      let mode = "foreground";
      let passwordMasking = "fast";
      try {
        const context = await this.options.resolve(threadId, binding.generation, binding.provider);
        computerEnabled = context.policy.computerUse;
        chromeEnabled =
          (binding.provider === "claude" && context.policy.claudeInChrome) ||
          (binding.provider === "codex" && context.policy.codexChrome);
        mode = context.policy.computerUseExecutionMode ?? "foreground";
        passwordMasking = context.policy.computerUsePasswordMasking ?? "fast";
      } catch {
        /* An unreadable policy removes execution permission. */
      }
      if (this.bindings.get(threadId) !== binding) continue;
      if (!chromeEnabled)
        for (const pending of this.setupConsents.values())
          if (pending.threadId === threadId && pending.generation === binding.generation)
            pending.settle(false);
      const applied = JSON.stringify({ computerEnabled, mode, passwordMasking });
      const changed = binding.appliedPolicy !== undefined && binding.appliedPolicy !== applied;
      binding.appliedPolicy = applied;
      if (changed) await this.revokeBinding(threadId, binding);
      if (!computerEnabled) {
        this.cancelTurn(threadId, binding.generation, undefined, "turn-ended", false);
        this.access.policyChanged(threadId);
      }
    }
  }
  /**
   * Per-binding transition for a native-to-native mode change: no provider restart, but every
   * earlier revision is vetoed, observations are cleared and host scopes drained first.
   */
  private async revokeBinding(threadId: string, binding: ComputerBinding): Promise<void> {
    this.waits.get(threadId)?.cancel("policy-changed");
    ++binding.policyRevision;
    this.access.revokeBackgroundApproval(threadId);
    this.cancelTurn(threadId, binding.generation, undefined, "turn-ended", false, false);
    this.invalidateObservations(threadId);
    if (this.host.backgroundCapable())
      await this.host
        .correlated(
          {
            type: "observationInvalidate",
            requestId: randomUUID(),
            threadId,
            policyRevision: binding.policyRevision,
          },
          6000,
          false,
        )
        .catch(() => undefined);
  }
  /** A single monotonic budget covers resolution, IPC and the backoff sleeps. */
  async wait(
    threadId: string,
    generation: string,
    input: {
      deadlineMs: number;
      condition?: {
        app: string;
        role?: string;
        name?: string;
        executionMode?: "foreground" | "background";
      };
    },
  ): Promise<{
    waitedMs: number;
    matched?: boolean;
    timedOut?: boolean;
    snapshotId?: string;
    elementRefs?: string[];
  }> {
    if (this.waits.has(threadId))
      throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
    const startedAt = performance.now();
    const controller = new AbortController();
    const deadline = Symbol("wait-deadline");
    let rejectCancellation!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    // The handler is installed before any asynchronous context resolution.
    const abort = (reason: unknown) => {
      controller.abort(reason);
      rejectCancellation(reason);
    };
    const waiter: {
      generation: string;
      turnId?: string;
      cancel: (cause: "paused" | "turn-ended" | "policy-changed") => void;
    } = {
      generation,
      ...(this.bindings.get(threadId)?.turnId
        ? { turnId: this.bindings.get(threadId)!.turnId! }
        : {}),
      cancel: (cause: "paused" | "turn-ended" | "policy-changed") =>
        abort(new ComputerControlError({ _tag: "Interrupted", cause })),
    };
    this.waits.set(threadId, waiter);
    const timer = setTimeout(
      () => abort(deadline),
      Math.max(0, input.deadlineMs - performance.now()),
    );
    const race = <A>(work: Promise<A>) => Promise.race([work, cancelled]);
    const result = () => ({ waitedMs: Math.max(0, Math.round(performance.now() - startedAt)) });
    let started = false;
    try {
      const ctx = await race(this.context(threadId, generation));
      const binding = this.bindings.get(threadId);
      if (
        !binding ||
        binding.generation !== generation ||
        ctx.turnId === "observation" ||
        binding.endedTurnId === ctx.turnId
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      binding.turnId = ctx.turnId;
      waiter.turnId = ctx.turnId;
      const revision = binding.policyRevision;
      const grants = this.access.version(threadId);
      const validate = async () => {
        if (this.pause.has(threadId))
          throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
        if (
          this.bindings.get(threadId) !== binding ||
          binding.turnId !== ctx.turnId ||
          binding.endedTurnId === ctx.turnId
        )
          throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        if (binding.policyRevision !== revision || this.access.version(threadId) !== grants)
          throw new ComputerControlError({ _tag: "Interrupted", cause: "policy-changed" });
        const live = await race(this.context(threadId, generation));
        if (controller.signal.aborted) throw controller.signal.reason;
        if (
          this.bindings.get(threadId) !== binding ||
          binding.turnId !== ctx.turnId ||
          binding.endedTurnId === ctx.turnId
        )
          throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        if (live.turnId !== ctx.turnId)
          throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        if (!live.policy.computerUse)
          throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
        if (binding.policyRevision !== revision || this.access.version(threadId) !== grants)
          throw new ComputerControlError({ _tag: "Interrupted", cause: "policy-changed" });
      };
      await validate();
      this.publish({
        channel: "computer.activity",
        data: { threadId, backend: "native", op: "wait", status: "started" },
      });
      started = true;
      if (!input.condition) {
        await cancelled;
        throw deadline;
      }
      const condition = input.condition;
      const invoke = (request: Record<string, unknown> & { op: ComputerAutomationRequest["op"] }) =>
        race(
          this.invoke(
            threadId,
            generation,
            request,
            Math.max(1, input.deadlineMs - performance.now()),
            { signal: controller.signal, beforeDispatch: validate, suppressActivity: true },
          ),
        );
      const apps = selectComputerApp(
        (await invoke({
          op: "resolveApps",
          queries: [condition.app],
        })) as ReadonlyArray<ComputerApp>,
        condition.app,
      );
      if (apps.length !== 1)
        throw new ComputerControlError({
          _tag: "Execution",
          message: "App could not be resolved uniquely; use an appId from computer_list_apps.",
        });
      let attempt = 0;
      while (true) {
        await validate();
        const inspected = (await invoke({
          op: "inspect",
          appId: apps[0]!.appId,
          maxNodes: 100,
          ...(condition.executionMode ? { executionMode: condition.executionMode } : {}),
        })) as ComputerInspectResult;
        await validate();
        if (!inspected.accessible)
          throw new ComputerControlError({
            _tag: "Execution",
            message: "The app's accessibility tree is unavailable.",
          });
        const matches = inspected.nodes
          .filter(
            (node) =>
              (condition.role === undefined || node.role === condition.role) &&
              (condition.name === undefined || node.name === condition.name),
          )
          .slice(0, 10);
        if (matches.length) {
          await validate();
          this.publish({
            channel: "computer.activity",
            data: { threadId, backend: "native", op: "wait", status: "completed" },
          });
          return {
            ...result(),
            matched: true,
            snapshotId: inspected.snapshotId,
            elementRefs: matches.map((node) => node.elementRef),
          };
        }
        const delay = Math.min(
          [250, 500, 1000][Math.min(attempt++, 2)]!,
          Math.max(0, input.deadlineMs - performance.now()),
        );
        let sleep: ReturnType<typeof setTimeout> | undefined;
        try {
          await race(
            new Promise<void>((resolve) => {
              sleep = setTimeout(resolve, delay);
            }),
          );
        } finally {
          if (sleep) clearTimeout(sleep);
        }
      }
    } catch (error) {
      if (error === deadline) {
        if (!started)
          throw new ComputerControlError({
            _tag: "Execution",
            message: "Computer wait could not start within its deadline.",
          });
        if (started)
          this.publish({
            channel: "computer.activity",
            data: { threadId, backend: "native", op: "wait", status: "completed" },
          });
        return { ...result(), ...(input.condition ? { matched: false, timedOut: true } : {}) };
      }
      if (started)
        this.publish({
          channel: "computer.activity",
          data: { threadId, backend: "native", op: "wait", status: "interrupted" },
        });
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.waits.get(threadId) === waiter) this.waits.delete(threadId);
    }
  }
  reportToolCompleted(
    threadId: string,
    generation: string,
    op: string,
    appName?: string,
    delivery?: ComputerDelivery,
  ): void {
    if (
      this.generation(threadId) !== generation ||
      ["status", "listApps", "resolveApps"].includes(op)
    )
      return;
    this.publish({
      channel: "computer.activity",
      data: {
        source: "tool",
        threadId,
        backend: "native",
        op,
        status: "completed",
        ...(delivery ? { delivery } : {}),
        ...(appName ? { appName: appName.slice(0, 200) } : {}),
      },
    });
  }
  reportToolFailure(
    threadId: string,
    generation: string,
    op: string,
    outcome: ComputerToolOutcomeCode,
  ): void {
    if (this.generation(threadId) !== generation) return;
    this.publish({
      channel: "computer.activity",
      data: { source: "tool", threadId, backend: "native", op, status: "failed", outcome },
    });
  }
  subscribe(listener: (event: ComputerBrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(event: ComputerBrokerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* UI failure never widens access. */
      }
    }
  }
  close(): void {
    for (const [threadId, binding] of this.bindings)
      this.releaseSession(threadId, binding.generation);
    this.offHost();
    this.offPause();
    this.access.close();
    this.host.close();
  }
}

export const ComputerAutomationBrokerLive = Layer.effect(
  ComputerAutomationBroker,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    type Dependencies =
      | FileSystem.FileSystem
      | Path.Path
      | SqlClient.SqlClient
      | ServerSettingsService;
    const services = yield* Effect.services<Dependencies>();
    const run = <A, E>(effect: Effect.Effect<A, E, Dependencies>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services)));
    const file = path.join(config.stateDir, "computer-access.json");
    const host = DesktopComputerHost.fromEnvironment(config.profile?.id ?? "default");
    const pause = yield* Effect.serviceOption(AgentControlPauseService);
    const storage = computerAccessStorage({
      exists: () => run(fs.exists(file)),
      read: () => run(fs.readFileString(file)),
      quarantine: (suffix) =>
        run(fs.rename(file, path.join(config.stateDir, `computer-access.${suffix}`))),
      warn: (message) => console.warn(message),
      write: (contents) => run(writeFileStringAtomically({ filePath: file, contents })),
    });
    const broker = new ComputerAutomationBrokerRuntime(host, {
      ...(Option.isSome(pause) ? { pause: pause.value } : {}),
      platform: process.platform === "win32" ? "win32" : "darwin",
      storage: {
        save: storage.save,
        load: async () => {
          const stored = await storage.load();
          const verified = [];
          for (const projectId of new Set(stored.map((grant) => grant.projectId))) {
            try {
              const result = await host.correlated(
                {
                  type: "grantsValidate",
                  requestId: randomUUID(),
                  projectId,
                  grants: stored.filter((grant) => grant.projectId === projectId),
                },
                2000,
                false,
              );
              const grants = Schema.decodeUnknownSync(Schema.Array(ComputerGrant))(result);
              verified.push(...grants.map((grant) => ({ ...grant, projectId })));
            } catch {
              /* Missing host/receipts means fresh consent, never a file grant. */
            }
          }
          return verified;
        },
      },
      resolve: async (threadId, sessionGeneration, provider) => {
        const rows = await run(
          sql<{
            projectId: string;
            title: string;
            runtimeMode: string;
            interactionMode: string;
            turnId: string | null;
          }>`SELECT t.project_id AS "projectId", t.title, t.runtime_mode AS "runtimeMode", t.interaction_mode AS "interactionMode", s.active_turn_id AS "turnId" FROM projection_threads t LEFT JOIN projection_thread_sessions s ON s.thread_id=t.thread_id WHERE t.thread_id=${threadId}`,
        );
        const row = rows[0];
        if (!row) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        return {
          threadId,
          sessionGeneration,
          provider,
          projectId: row.projectId,
          threadTitle: row.title,
          turnId: row.turnId ?? "observation",
          runtimeMode: row.runtimeMode,
          interactionMode: row.interactionMode,
          policy: await run(
            resolveAgentBrowserPolicy(threadId as import("@t3tools/contracts").ThreadId),
          ),
        };
      },
    });
    yield* Effect.promise(() => broker.initialize());
    yield* Effect.addFinalizer(() => Effect.sync(() => broker.close()));
    return broker;
  }),
);
