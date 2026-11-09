import type { ComputerAgentProvider } from "@t3tools/shared/agentAutomationSupport";
import {
  selectComputerApp,
  appTier,
  grantAllows,
  computerBackgroundEventAppAllowed,
} from "@t3tools/shared/computerApps";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { createHash, randomUUID } from "node:crypto";
import { Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ThreadId,
  type AgentComputerUseChanged,
  ComputerGrant,
  RememberedComputerGrant,
  ComputerTargetAvailability,
  COMPUTER_LEASE_WAIT_MAX_MS,
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
  type ChromeProcessAdoption,
  ChromeProcessRegistration,
} from "@t3tools/contracts";
import {
  ComputerControlError,
  computerError,
  computerRequestPayload,
  isComputerMutation,
} from "@t3tools/shared/computerControl";
import {
  COMPUTER_CHROME_APP_IDS,
  computerBackgroundOpAllowed,
  computerOpRequiresApp,
  computerBackgroundKeyAllowed,
} from "@t3tools/shared/computerExecution";
import { ServerConfig } from "../config";
import { computerRemainingBudget, computerWithinDeadline } from "./computerDeadline";
import { waitForControl, handoffError, type CodexHandoff } from "./CodexControlHandoff";
import { PerformanceStageProbe } from "../observability/Metrics";

export const COMPUTER_WAIT_POLL_MS = 250;
export const COMPUTER_WAIT_POLL_MAX_MS = 500;
export const COMPUTER_SETTLE_STABLE_MS = 500;
/** The desktop ends a target wait this much before the broker, so its timeout carries a reason. */
export const COMPUTER_TARGET_WAIT_DESKTOP_MARGIN_MS = 500;

export function computerInspectFingerprint(nodes: ComputerInspectResult["nodes"]): string {
  return JSON.stringify(
    nodes.map((node) => [
      node.role,
      node.name ?? "",
      node.value ?? null,
      node.focused ?? false,
      node.enabled ?? true,
      node.bounds,
      node.displayId ?? null,
    ]),
  );
}

/**
 * Electron decides every takeover: its worst case is 300 s consent + 30 s idle window + up to
 * 5 s drain and 1 s readiness per arming attempt, plus a 20 s reservation wait and 2 s
 * transport margin. This sits above that budget and below the tool transport timeout.
 */
export const COMPUTER_TAKEOVER_HOST_TIMEOUT_MS = 380_000;
import { ServerSettingsService } from "../serverSettings";
import { writeFileStringAtomically } from "../atomicWrite";
import { resolveAgentBrowserPolicy, type AgentBrowserPolicy } from "../mcp/browserAccess";
import { AutomationQueue } from "../mcp/automationQueue";
import { AgentControlPause, AgentControlPauseService } from "../mcp/agentControlPause";
import { DesktopComputerHost } from "./DesktopComputerHost";
import { startBrowserOpenBridge } from "../browser/BrowserOpenBridge";
import { browserOpenThreadFor } from "../browser/BrowserOpenThreadToken";
import { browserOpenThreadIsFullAccess } from "../browser/BrowserOpenPreapproval";
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
  /** Pause remains a cancellation even if the user resumes before an await returns. */
  pauseRevision?: number;
  /** The policy last applied to this binding, compared on settings changes. */
  appliedPolicy?: string;
  takeover?: { acquireId: string; approvalId: string; appId: string };
  acquiring?: { requestId: string; turnId: string };
}
export interface ComputerBatchHandle {
  readonly threadId: string;
  readonly binding: ComputerBinding;
  readonly generation: string;
  readonly turnId: string;
  readonly turnRevision: number;
  readonly policyRevision: number;
  readonly grantVersion: number;
  readonly yieldEpoch: number;
  readonly delivery: ComputerDelivery;
  readonly deadline: number;
  readonly controller: AbortController;
  readonly release: () => void;
}
/** Bounded summary of the merged lease state for the WebSocket banner. */
export interface ComputerUseSnapshot {
  readonly hostPlatform?: "darwin" | "win32";
  readonly stopShortcut?: string;
  readonly holders: ReadonlyArray<{
    threadId: string;
    leaseHeld?: boolean;
    backend?: ComputerLeaseHolder["backend"];
    delivery: ComputerDelivery;
    appId?: string;
    appName?: string;
    state: ComputerExecutionState;
    pauseCause?: ComputerPauseCause;
    browser?: "idle" | "working" | "unknown";
  }>;
  readonly pendingTakeover?: {
    threadId: string;
    appId: string;
    appName?: string;
    state: ComputerExecutionState;
  };
  readonly otherProfile: boolean;
}
/** Matches the web banner's `CHROME_BANNER_LINGER_MS` after the owner's last Chrome call. */
export const CHROME_OTHER_PROFILE_LINGER_MS = 3000;
/**
 * How long a preempting acquisition waits for an idle holder to give Chrome up: main sends
 * SIGTERM, SIGKILL after 1 s, and observes the group exit within 5 s.
 */
export const CHROME_PREEMPT_WAIT_MS = 8000;
/** How a Chrome-holding session gives the lease up (see `registerChromeReleaser`). */
export interface ChromeReleaser {
  /** Idle by the session's own account: nothing it runs would die with the release. */
  readonly idle: () => boolean;
  /** Stops what holds Chrome; answers whether it did (it may refuse if work started). */
  readonly release: () => boolean | Promise<boolean>;
}
export type ChromeReleaseOutcome = "released" | "not-holder" | "working" | "timeout";
function chromeCallsKey(threadId: string, generation: string): string {
  return `${threadId}\u0000${generation}`;
}
/** WebSocket shape of the merged snapshot. */
export function agentComputerUsePush(
  snapshot: ComputerUseSnapshot,
): typeof AgentComputerUseChanged.Type {
  return {
    ...(snapshot.hostPlatform ? { hostPlatform: snapshot.hostPlatform } : {}),
    ...(snapshot.stopShortcut ? { stopShortcut: snapshot.stopShortcut } : {}),
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
      data: {
        requestId: string;
        threadId: string;
        allowed: boolean;
        persistence?: "durable" | "session-only";
        persistenceReason?: string;
      };
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
  private initialized = false;
  private readonly bindings = new Map<string, ComputerBinding>();
  private readonly chromeDisabledListeners = new Set<
    (threadId: string, generation: string) => void
  >();
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
      mutation: boolean;
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
  private readonly yieldEpochs = new Map<string, number>();
  private readonly batches = new Map<string, ComputerBatchHandle>();
  private abortBatch(
    threadId: string,
    error = new ComputerControlError({
      _tag: "Interrupted",
      cause: "access-changed",
    }),
  ): void {
    this.batches.get(threadId)?.controller.abort(error);
  }
  private readonly listeners = new Set<(event: ComputerBrokerEvent) => void>();
  private readonly nativePaused = new Set<string>();
  private mainHolders: ReadonlyArray<ComputerLeaseHolder> = [];
  private chromeHolder: ChromeLeaseHolder | null = null;
  /** Whether a browser call runs, per thread and session generation (`reportChromeCalls`). */
  private readonly chromeCalls = new Map<string, boolean>();
  /** How each Chrome-holding session gives the lease up, per thread and generation. */
  private readonly chromeReleasers = new Map<string, ChromeReleaser>();
  private readonly codexHandoffs = new Map<string, CodexHandoff>();
  /** Preemptions waiting for main to report the lease gone. */
  private readonly chromeReleaseWaiters = new Set<() => void>();
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
  /** Holds another profile's Chrome control in the banner briefly after it goes idle. */
  private chromeOtherLinger: ReturnType<typeof setTimeout> | undefined;
  private chromeRecovery = false;
  private hostPlatform: "darwin" | "win32" | undefined;
  private stopShortcut: string | undefined;
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
      performanceStageProbe?: ((stage: string, durationMs: number) => void) | null;
      /** Thread titles for attributing a same-profile `Busy`. */
      threadTitle?: (threadId: string) => Promise<string | undefined>;
    },
  ) {
    this.pause = options.pause ?? new AgentControlPause();
    this.offPause = this.pause.subscribe((threadId, paused) => {
      const binding = this.bindings.get(threadId);
      if (paused && binding) {
        binding.pauseRevision = (binding.pauseRevision ?? 0) + 1;
        this.host.send({ type: "pauseChanged", threadId, paused });
        this.invalidateObservations(threadId);
        this.cancelTurn(threadId, binding.generation, binding.turnId, "paused");
      }
    });
    this.access = new ComputerAccessService({
      platform: options.platform,
      forgotten: (projectId, appId) =>
        this.host.grantForgetCapable()
          ? this.host
              .correlated(
                {
                  type: "grantForget",
                  requestId: randomUUID(),
                  projectId,
                  appId,
                },
                10_000,
                false,
              )
              .then(() => undefined)
          : this.host.send({ type: "grantForget", projectId, appId }),
      backendIncarnation: host.backendIncarnation,
      storage: options.storage,
      mainOwned: () => host.rememberedConsentCapable(),
      remembered: {
        load: async (projectId) =>
          Schema.decodeUnknownSync(Schema.Array(RememberedComputerGrant))(
            await host.correlated(
              {
                type: "grantsRemembered",
                requestId: randomUUID(),
                ...(projectId === undefined ? {} : { projectId }),
              },
              5000,
              false,
            ),
          ),
        forget: async (projectId, appId) => {
          await host.correlated(
            {
              type: "grantForget",
              requestId: randomUUID(),
              projectId,
              appId,
            },
            10_000,
            false,
          );
        },
      },
      request: (request, expiresAtMs) => {
        this.publish({
          channel: "computer.access.requested",
          data: { ...request, backendIncarnation: host.backendIncarnation, expiresAtMs },
        });
        host.send({ type: "accessRequested", request });
      },
      settled: (requestId, threadId, allowed, persistence) => {
        host.send({ type: "cancel", requestId });
        this.publish({
          channel: "computer.access.settled",
          data: {
            requestId,
            threadId,
            allowed,
            ...(persistence?.persistence ? { persistence: persistence.persistence } : {}),
            ...(persistence?.persistenceReason
              ? { persistenceReason: persistence.persistenceReason }
              : {}),
          },
        });
      },
      changed: (threadId) => {
        this.abortBatch(threadId);
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
      if (
        message.type === "targetYielded" &&
        this.host.cooperationCapable() &&
        this.bindings.get(message.threadId)?.generation === message.sessionGeneration
      ) {
        this.yieldEpochs.set(message.threadId, (this.yieldEpochs.get(message.threadId) ?? 0) + 1);
        this.abortBatch(
          message.threadId,
          new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" }),
        );
        this.invalidateObservations(message.threadId);
        const contention = new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
        this.queue.flush(message.threadId, contention);
        for (const [requestId, pending] of this.inFlight)
          if (pending.threadId === message.threadId && !pending.mutation)
            this.host.abandon(requestId, contention);
        this.executionStates.set(message.threadId, {
          state: "waiting-user",
          delivery: message.appId ? "background" : "foreground",
          ...(message.appId ? { appId: message.appId } : {}),
        });
        this.publishUse();
      }
      if (message.type === "chromeLeaseChanged") {
        // A lease that ended takes its call report with it; the session needn't say so.
        const previous = this.chromeHolder;
        if (
          previous &&
          (previous.threadId !== message.holder?.threadId ||
            previous.sessionGeneration !== message.holder.sessionGeneration)
        )
          this.chromeCalls.delete(chromeCallsKey(previous.threadId, previous.sessionGeneration));
        this.chromeHolder = message.holder;
        this.setChromeOtherProfile(message.otherProfile ?? false);
        this.chromeRecovery = message.recoveryRequired ?? false;
        this.publishUse();
        // A waiter that finishes deletes itself; Set iteration tolerates that.
        for (const check of this.chromeReleaseWaiters) check();
      }
      // Reports made before main answered the handshake reach it now.
      if (message.type === "hostCapabilities")
        for (const [key, running] of this.chromeCalls) {
          const [threadId, generation] = key.split("\u0000") as [string, string];
          this.sendChromeCalls(threadId, generation, running);
        }
      if (message.type === "hostCapabilities" && this.initialized)
        void this.access.refreshRemembered().catch(() => undefined);
      if (message.type === "rememberedChanged") {
        for (const session of message.revokedSessions ?? [])
          if (this.bindings.get(session.threadId)?.generation === session.sessionGeneration)
            if (message.backgroundOnly) this.access.revokeBackgroundApproval(session.threadId);
            else this.access.revokeSessionApproval(session.threadId);
        void this.access.refreshRemembered(message.projectId).catch(() => undefined);
      }
      if (
        message.type === "status" &&
        (this.hostPlatform !== message.status.hostPlatform ||
          this.stopShortcut !== message.status.stopShortcut)
      ) {
        this.hostPlatform = message.status.hostPlatform;
        this.stopShortcut = message.status.stopShortcut;
        this.publishUse();
      }
      if (
        message.type === "status" &&
        !message.status.available &&
        message.status.reason === "no-host"
      ) {
        this.mainHolders = [];
        this.chromeHolder = null;
        this.chromeCalls.clear();
        for (const check of this.chromeReleaseWaiters) check();
        this.pendingTakeover = undefined;
        this.executionStates.clear();
        this.nativeOtherProfile = false;
        this.chromeOtherProfile = false;
        this.clearChromeOtherLinger();
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
  private async measureStage<A>(stage: string, operation: () => Promise<A>): Promise<A> {
    const probe = this.options.performanceStageProbe;
    if (!probe) return operation();
    const started = performance.now();
    try {
      return await operation();
    } finally {
      try {
        probe(stage, performance.now() - started);
      } catch {
        /* Diagnostics only. */
      }
    }
  }
  async initialize(): Promise<void> {
    await this.host.handshake();
    if (!this.host.awaitingHandshake()) await this.access.initialize();
    this.initialized = true;
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
        execution.state !== "waiting-user" &&
        execution.state !== "waiting-agent" &&
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
    const hostStatus = this.host.status();
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
        (execution.state === "paused" ||
          execution.state === "recovery" ||
          execution.state === "waiting-user" ||
          execution.state === "waiting-agent")
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
    ) {
      const running = this.chromeCalls.get(
        chromeCallsKey(this.chromeHolder.threadId, this.chromeHolder.sessionGeneration),
      );
      holders.push({
        threadId: this.chromeHolder.threadId,
        delivery: "foreground",
        state: "active",
        browser: running === undefined ? "unknown" : running ? "working" : "idle",
      });
    }
    const pending = this.pendingTakeover;
    const pendingState = pending ? this.executionStates.get(pending.threadId)?.state : undefined;
    return {
      ...(hostStatus.hostPlatform ? { hostPlatform: hostStatus.hostPlatform } : {}),
      ...(hostStatus.stopShortcut ? { stopShortcut: hostStatus.stopShortcut } : {}),
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
        this.nativeOtherProfile ||
        this.chromeOtherProfile ||
        this.chromeOtherLinger !== undefined ||
        this.mainHolders.length > own.length,
    };
  }
  /**
   * Another profile's Chrome control lingers for `CHROME_OTHER_PROFILE_LINGER_MS` after it
   * ends, as the owner's banner does after a call, so back-to-back calls there don't flicker
   * the banner here. Native control isn't delayed.
   */
  private setChromeOtherProfile(next: boolean): void {
    const ended = this.chromeOtherProfile && !next;
    this.chromeOtherProfile = next;
    if (next || ended) this.clearChromeOtherLinger();
    if (!ended) return;
    this.chromeOtherLinger = setTimeout(() => {
      this.chromeOtherLinger = undefined;
      this.publishUse();
    }, CHROME_OTHER_PROFILE_LINGER_MS);
    this.chromeOtherLinger.unref?.();
  }
  private clearChromeOtherLinger(): void {
    if (this.chromeOtherLinger === undefined) return;
    clearTimeout(this.chromeOtherLinger);
    this.chromeOtherLinger = undefined;
  }
  private publishUse(): void {
    this.publish({ channel: "computer.use.changed", data: this.computerUse() });
  }
  /** Background delivery is available end to end for this backend. */
  backgroundStatus(): { available: boolean; reason?: string | undefined } {
    const status = this.host.status();
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
  /**
   * Main adopts a process the provider started (Codex's `node_repl`): it verifies it and
   * its parent, then supervises it like a registered child. Answers what main registered,
   * or the registration that already supervises it for this session (its own token).
   * A timeout doesn't mean main gave up: the caller still stops `launchToken`.
   */
  async adoptIntegrationProcess(
    adoption: Omit<ChromeProcessAdoption, "profileId" | "backendIncarnation">,
  ): Promise<ChromeProcessRegistration> {
    const result = await this.host.correlated(
      {
        type: "chromeProcessAdopt",
        requestId: randomUUID(),
        adoption: {
          ...adoption,
          profileId: this.host.profileId,
          backendIncarnation: this.host.backendIncarnation,
        },
      },
      15_000,
      false,
    );
    const registration = Schema.decodeUnknownOption(ChromeProcessRegistration)(result);
    if (
      Option.isNone(registration) ||
      registration.value.threadId !== adoption.threadId ||
      registration.value.sessionGeneration !== adoption.sessionGeneration ||
      registration.value.integration !== adoption.integration
    )
      throw new ComputerControlError({
        _tag: "Execution",
        message: "The desktop answered the adoption with something else.",
      });
    return registration.value;
  }
  /**
   * Main stops an adopted process; the backend can't signal what it didn't start.
   * `release` (idle) lets the runtime exit gracefully; anything else stops it at once.
   */
  stopIntegrationProcess(launchToken: string, reason?: "release" | "unresponsive"): void {
    this.host.send({ type: "chromeProcessStop", launchToken, ...(reason ? { reason } : {}) });
  }
  /**
   * A session holding (or about to acquire) the Chrome lease reports whether a browser call
   * is running, so the banner doesn't call an idle runtime's lease control. The report
   * ends with the lease; `undefined` withdraws one whose lease was never acquired.
   */
  reportChromeCalls(threadId: string, generation: string, running: boolean | undefined): void {
    const key = chromeCallsKey(threadId, generation);
    if (this.chromeCalls.get(key) === running) return;
    if (running === undefined) this.chromeCalls.delete(key);
    else this.chromeCalls.set(key, running);
    this.sendChromeCalls(threadId, generation, running);
    this.publishUse();
  }
  /**
   * A session holding the Chrome lease registers how to give it up. `idle` says whether
   * it could (its own work, such as background tasks, counts); `release` answers whether
   * it stopped, refusing when work started since.
   */
  registerChromeReleaser(
    threadId: string,
    generation: string,
    releaser: ChromeReleaser,
  ): () => void {
    const key = chromeCallsKey(threadId, generation);
    this.chromeReleasers.set(key, releaser);
    return () => {
      if (this.chromeReleasers.get(key) === releaser) this.chromeReleasers.delete(key);
    };
  }
  registerCodexHandoff(threadId: string, generation: string, handoff: CodexHandoff): () => void {
    const key = chromeCallsKey(threadId, generation);
    this.codexHandoffs.set(key, handoff);
    return () => {
      if (this.codexHandoffs.get(key) === handoff) this.codexHandoffs.delete(key);
    };
  }

  private async handoffCheckpoint(
    threadId: string,
    generation: string,
  ): Promise<() => Promise<void>> {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const revision = binding.policyRevision;
    const turnRevision = binding.turnRevision;
    const pauseRevision = binding.pauseRevision;
    const check = async () => {
      const ctx = await this.context(threadId, generation);
      this.assertRevision(binding, revision, turnRevision);
      if (
        this.bindings.get(threadId) !== binding ||
        ctx.turnId === "observation" ||
        binding.endedTurnId === ctx.turnId
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      if (this.pause.has(threadId) || binding.pauseRevision !== pauseRevision)
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      if (ctx.interactionMode === "plan")
        throw handoffError("Control handoff is unavailable in plan mode.");
      if (this.chromeRecoveryRequired())
        throw handoffError("Browser control requires recovery on the computer running F5.");
    };
    await check();
    return check;
  }

  /** Main confirms the process group exit by removing this exact generation's lease. */
  async waitForChromeRelease(
    threadId: string,
    generation: string,
    deadline: number,
    check: () => Promise<void>,
  ): Promise<void> {
    await waitForControl(
      () =>
        !this.chromeHolder ||
        this.chromeHolder.threadId !== threadId ||
        this.chromeHolder.sessionGeneration !== generation,
      deadline,
      check,
    );
  }

  /** Called outside MCP, since restarting Chrome reloads every MCP connection. */
  async resumeCodexBrowser(threadId: string, generation: string): Promise<unknown> {
    const handoff = this.codexHandoffs.get(chromeCallsKey(threadId, generation));
    if (!handoff) throw handoffError("Chrome control is unavailable for this session.");
    const check = await this.handoffCheckpoint(threadId, generation);
    await handoff.browser(performance.now() + 20_000, check);
    await check();
    return {
      state: "ready",
      resetRequired: true,
      message:
        "Chrome is ready. Recreate browser variables and tab handles; native observations are stale.",
    };
  }

  /** Drain our native calls, release takeover, then reserve Chrome through main's authority. */
  async prepareCodexBrowser(
    threadId: string,
    generation: string,
    deadline: number,
    check: () => Promise<void>,
  ): Promise<void> {
    await waitForControl(
      () =>
        ![...this.inFlight.values()].some(
          (p) => p.threadId === threadId && p.generation === generation,
        ),
      deadline,
      check,
    );
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (binding.acquiring || binding.takeover)
      throw handoffError(
        "A native control request is still pending; finish it before resuming Chrome.",
      );
    this.endTakeover(threadId, binding);
    if (binding.holder) {
      this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder: binding.holder });
      delete binding.holder;
    }
    this.invalidateObservations(threadId);
    const holder = {
      profileId: this.host.profileId,
      threadId,
      sessionGeneration: generation,
      provider: "codex" as const,
    };
    let reserved = false;
    try {
      await waitForControl(
        async () => {
          try {
            await this.acquireChromeLease(
              holder,
              Math.min(5000, computerRemainingBudget(deadline)),
            );
            reserved = true;
            return true;
          } catch (error) {
            if (computerError(error)._tag !== "Busy") throw error;
            return false;
          }
        },
        deadline,
        check,
      );
    } catch (error) {
      if (reserved) this.host.send({ type: "chromeLeaseRelease", requestId: randomUUID(), holder });
      throw error;
    }
  }
  /**
   * Between turns, no Chrome call running, not paused, not recovering, and idle by the
   * session's own account when it registered one.
   */
  chromeHolderIdle(threadId: string, generation: string): boolean {
    const key = chromeCallsKey(threadId, generation);
    if (this.chromeCalls.get(key) === true) return false;
    if (this.pause.has(threadId)) return false;
    if (this.executionStates.get(threadId)?.state === "recovery") return false;
    const binding = this.bindings.get(threadId);
    if (
      binding?.generation === generation &&
      binding.turnId !== undefined &&
      binding.endedTurnId !== binding.turnId
    )
      return false;
    return this.chromeReleasers.get(key)?.idle() ?? true;
  }
  /**
   * Asks this profile's Chrome holder to release when it is idle, and resolves once main
   * reports the lease gone (`released`), the holder isn't this thread or has no way to
   * release (`not-holder`), it is busy or refused (`working`), or it didn't let go within
   * `timeoutMs` (`timeout`).
   */
  async releaseChromeHolderOutcome(
    threadId: string,
    timeoutMs = CHROME_PREEMPT_WAIT_MS,
  ): Promise<ChromeReleaseOutcome> {
    const holder = this.chromeHolder;
    if (!holder || holder.threadId !== threadId || holder.profileId !== this.host.profileId)
      return "not-holder";
    const releaser = this.chromeReleasers.get(
      chromeCallsKey(holder.threadId, holder.sessionGeneration),
    );
    if (!releaser) return "not-holder";
    if (!this.chromeHolderIdle(holder.threadId, holder.sessionGeneration)) return "working";
    const released = () =>
      !this.chromeHolder ||
      this.chromeHolder.threadId !== holder.threadId ||
      this.chromeHolder.sessionGeneration !== holder.sessionGeneration;
    // Watching starts before the release, so a lease change it causes isn't missed.
    let settle: (outcome: ChromeReleaseOutcome) => void = () => {};
    const outcome = new Promise<ChromeReleaseOutcome>((resolve) => (settle = resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (released()) finish("released");
    };
    const finish = (result: ChromeReleaseOutcome) => {
      if (timer) clearTimeout(timer);
      this.chromeReleaseWaiters.delete(check);
      settle(result);
    };
    this.chromeReleaseWaiters.add(check);
    let accepted = false;
    try {
      accepted = await releaser.release();
    } catch {
      accepted = false;
    }
    // A refusal gives up at once; an accepted release waits for main to see the exit.
    if (!accepted) finish("working");
    else {
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      check();
    }
    return outcome;
  }
  async releaseChromeHolder(
    threadId: string,
    timeoutMs = CHROME_PREEMPT_WAIT_MS,
  ): Promise<boolean> {
    return (await this.releaseChromeHolderOutcome(threadId, timeoutMs)) === "released";
  }
  /**
   * Fills in who holds a same-profile `Busy`: the thread's title and whether it is idle.
   * Anything else passes through unchanged.
   */
  async attributeBusy(error: unknown): Promise<unknown> {
    if (!(error instanceof ComputerControlError) || error.error._tag !== "Busy") return error;
    const busy = error.error;
    if (busy.holder !== "same-profile" || !busy.holderThreadId) return error;
    const chrome =
      busy.resource === "chrome" && this.chromeHolder?.threadId === busy.holderThreadId
        ? this.chromeHolder
        : undefined;
    const title =
      busy.threadTitle ??
      (await this.options.threadTitle?.(busy.holderThreadId).catch(() => undefined));
    // Native leases live only inside a turn, so their holder is always working. A Chrome
    // holder this broker hasn't seen yet (main's report in flight) is left unstated.
    const holderIdle =
      busy.resource === "computer"
        ? false
        : chrome
          ? this.chromeHolderIdle(chrome.threadId, chrome.sessionGeneration)
          : undefined;
    return new ComputerControlError({
      ...busy,
      ...(title ? { threadTitle: title.slice(0, 200) } : {}),
      ...(holderIdle !== undefined ? { holderIdle } : {}),
    });
  }
  /**
   * Runs an acquisition that main may refuse because this profile's Chrome holder has the
   * lease. An idle holder is released and the acquisition retried once; otherwise the
   * refusal comes back naming the holder.
   */
  async withChromePreemption<A>(acquire: () => Promise<A>): Promise<A> {
    try {
      return await acquire();
    } catch (error) {
      const holderThreadId =
        error instanceof ComputerControlError &&
        error.error._tag === "Busy" &&
        error.error.holder === "same-profile" &&
        error.error.resource === "chrome"
          ? error.error.holderThreadId
          : undefined;
      if (!holderThreadId || !(await this.releaseChromeHolder(holderThreadId)))
        throw await this.attributeBusy(error);
    }
    try {
      return await acquire();
    } catch (error) {
      throw await this.attributeBusy(error);
    }
  }
  /**
   * Before a native lease that the Chrome lease would block (foreground, takeover, or a
   * registered browser in background), asks an idle Chrome holder in this profile to
   * release. A working holder keeps Chrome and main queues the request behind it.
   *
   * Codex parks its own runtime through its generation's handoff queue. A Claude holder
   * cannot stop its CLI mid-turn: main admits its own native work while Chrome calls are idle.
   */
  async preemptChromeFor(
    threadId: string,
    scope: ComputerLeaseScope,
    deadline = performance.now() + CHROME_PREEMPT_WAIT_MS,
  ): Promise<void> {
    if (scope.kind === "app" && !COMPUTER_CHROME_APP_IDS.includes(scope.appId)) return;
    const generation = this.bindings.get(threadId)?.generation;
    const handoff = generation && this.codexHandoffs.get(chromeCallsKey(threadId, generation));
    if (handoff && generation) {
      const check = await this.handoffCheckpoint(threadId, generation);
      await handoff.native(Math.min(deadline, performance.now() + CHROME_PREEMPT_WAIT_MS), check);
      await check();
    }
    const holder = this.chromeHolder;
    if (!holder || holder.threadId === threadId || holder.profileId !== this.host.profileId) return;
    if (scope.kind === "app" && !COMPUTER_CHROME_APP_IDS.includes(scope.appId)) return;
    await this.releaseChromeHolderOutcome(holder.threadId);
  }
  /** A session's Chrome lease, taken from an idle holder in this profile when needed. */
  acquireChromeLease(holder: ChromeLeaseHolder, timeoutMs = 5000): Promise<void> {
    return this.withChromePreemption(() =>
      this.host
        .correlated(
          { type: "chromeLeaseAcquire", requestId: randomUUID(), holder },
          timeoutMs,
          false,
        )
        .then(() => undefined),
    );
  }
  /** Main hides an idle Chrome lease from other profiles' banners, as this one does. */
  private sendChromeCalls(threadId: string, generation: string, running: boolean | undefined) {
    if (!this.host.chromeCallsCapable()) return;
    this.host.send({
      type: "chromeCallsChanged",
      threadId,
      sessionGeneration: generation,
      running: running ?? null,
    });
  }
  /** Called with each binding whose provider-native Chrome policy is off after a refresh. */
  onChromeDisabled(listener: (threadId: string, generation: string) => void): () => void {
    this.chromeDisabledListeners.add(listener);
    return () => this.chromeDisabledListeners.delete(listener);
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
    const ctx = await this.measureStage("broker.context", () =>
      this.options.resolve(threadId, sessionGeneration, binding.provider),
    );
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
  async beginBatch(
    threadId: string,
    generation: string,
    delivery: ComputerDelivery,
    budgetMs = 15_000,
  ): Promise<ComputerBatchHandle> {
    const yieldEpoch = this.yieldEpochs.get(threadId) ?? 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ComputerControlError({
              _tag: "Execution",
              message: "Batch admission timed out.",
            }),
          ),
        budgetMs,
      );
    });
    let ctx: ComputerInvocationContext;
    try {
      ctx = await Promise.race([
        (async () => {
          await this.admitted();
          return this.context(threadId, generation);
        })(),
        expired,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const binding = this.bindings.get(threadId);
    if (
      !binding ||
      binding.generation !== generation ||
      ctx.turnId === "observation" ||
      binding.endedTurnId === ctx.turnId
    )
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (!ctx.policy.computerUse)
      throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
    const status = this.host.status();
    if (!status.available)
      throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
    if (this.pause.has(threadId))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    if (ctx.interactionMode === "plan")
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Computer control is unavailable in plan mode.",
      });
    binding.turnId = ctx.turnId;
    const revision = binding.policyRevision;
    const turnRevision = binding.turnRevision;
    await this.ensureSessionApproval(threadId, ctx, delivery);
    if (this.batches.has(threadId))
      throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
    let slot: { release: () => void } | undefined;
    let released = false;
    const handle: ComputerBatchHandle = {
      threadId,
      generation,
      binding,
      delivery,
      turnId: ctx.turnId,
      turnRevision,
      policyRevision: revision,
      grantVersion: this.access.version(threadId),
      yieldEpoch,
      controller: new AbortController(),
      deadline: performance.now() + 60_000,
      release: () => {
        if (released) return;
        released = true;
        if (this.batches.get(threadId) === handle) this.batches.delete(threadId);
        slot?.release();
      },
    };
    this.batches.set(threadId, handle);
    try {
      this.assertBatchLive(handle);
      slot = await this.queue.acquire(threadId, handle.controller.signal, 30_000);
      this.assertBatchLive(handle);
      return handle;
    } catch (cause) {
      handle.release();
      throw cause;
    }
  }
  assertBatchLive(handle: ComputerBatchHandle): void {
    const { threadId, binding } = handle;
    if ((this.yieldEpochs.get(threadId) ?? 0) !== handle.yieldEpoch)
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
    if (this.pause.has(threadId))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    if (
      this.batches.get(threadId) !== handle ||
      this.bindings.get(threadId) !== binding ||
      binding.generation !== handle.generation ||
      binding.turnId !== handle.turnId ||
      binding.turnRevision !== handle.turnRevision ||
      binding.endedTurnId === handle.turnId
    )
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (handle.controller.signal.aborted) throw handle.controller.signal.reason;
    if (
      binding.policyRevision !== handle.policyRevision ||
      this.access.version(threadId) !== handle.grantVersion
    )
      throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
  }
  private async ensureSessionApproval(
    threadId: string,
    ctx: ComputerInvocationContext,
    delivery: ComputerDelivery,
  ): Promise<void> {
    // Background control needs one native session approval, including full-access sessions.
    if (delivery === "background" && !this.access.backgroundApproved(threadId)) {
      await this.access.requestAccess(
        threadId,
        ctx.turnId,
        [],
        "Allow this agent session to control apps you approve, while you work elsewhere?",
        {
          kind: "session-actions",
          background: true,
          fullAccess: ctx.runtimeMode === "full-access",
        },
      );
      if (!this.access.backgroundApproved(threadId))
        throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
    } else if (ctx.runtimeMode !== "full-access" && !this.access.actionsApproved(threadId)) {
      await this.access.requestAccess(
        threadId,
        ctx.turnId,
        [],
        "Allow this agent session to control apps you approve?",
        { kind: "session-actions" },
      );
      if (!this.access.actionsApproved(threadId))
        throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
    }
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
      batch?: ComputerBatchHandle;
      deadlineMs?: number;
    },
  ): Promise<unknown> {
    const batch = options?.batch;
    let invokeDeadline = Math.min(
      performance.now() + timeoutMs,
      options?.deadlineMs ?? Infinity,
      batch?.deadline ?? Infinity,
    );
    const remainingBudget = () => computerRemainingBudget(invokeDeadline);
    const bounded = <A>(operation: () => Promise<A>) =>
      computerWithinDeadline(invokeDeadline, operation, options?.signal);
    if (
      batch &&
      this.batches.get(threadId) === batch &&
      batch.delivery === "background" &&
      !this.access.backgroundApproved(threadId)
    )
      throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
    if (batch) this.assertBatchLive(batch);
    const yieldEpoch = batch?.yieldEpoch ?? this.yieldEpochs.get(threadId) ?? 0;
    await bounded(() => this.measureStage("broker.admission", () => this.admitted()));
    const ctx = await bounded(() => this.context(threadId, generation));
    if (batch) {
      this.assertBatchLive(batch);
      if (
        batch.threadId !== threadId ||
        batch.generation !== generation ||
        batch.turnId !== ctx.turnId
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
    }
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
    if (input.op === "status") {
      const handoff = this.codexHandoffs.get(chromeCallsKey(threadId, generation));
      const control = {
        paused: this.pause.has(threadId),
        recoveryRequired: this.chromeRecoveryRequired(),
        ...(handoff ? { chrome: handoff.status() } : {}),
      };
      return ctx.policy.computerUseExecutionMode === "background"
        ? { ...status, background: this.backgroundStatus(), executionMode: "background", control }
        : { ...status, control };
    }
    const mutation = isComputerMutation(input.op);
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const revision = binding.policyRevision;
    const turnRevision = binding.turnRevision;
    if (ctx.turnId !== "observation") binding.turnId = ctx.turnId;
    const appId = typeof input.appId === "string" ? input.appId : undefined;
    const requestedMode = input.executionMode;
    let delivery = this.selectDelivery(ctx, binding, input.op, appId, {
      executionMode: input.executionMode,
      action: input.action,
      chords: input.chords,
      elementRef: input.elementRef,
    });
    delete input.executionMode;
    if (batch && delivery !== batch.delivery)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
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
      if (batch) {
        if (
          (delivery === "background" && !this.access.backgroundApproved(threadId)) ||
          (ctx.runtimeMode !== "full-access" && !this.access.actionsApproved(threadId))
        )
          throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
      } else {
        const consentStarted = performance.now();
        await this.ensureSessionApproval(threadId, ctx, delivery);
        // Ordinary interactive consent has its own budget. Explicit wait/batch deadlines never move.
        if (options?.deadlineMs === undefined) invokeDeadline += performance.now() - consentStarted;
      }
    }
    let requestId = randomUUID();
    let dispatched = false;
    let retrying = false;
    // Queueing, admission and retries share one budget; contention never renews it.
    const retryDeadline = Math.min(
      invokeDeadline - 5000,
      performance.now() + COMPUTER_LEASE_WAIT_MAX_MS,
    );
    const controller = new AbortController();
    const slot =
      mutation && !batch
        ? await this.queue.acquire(threadId, controller.signal, Math.min(60_000, remainingBudget()))
        : { release: () => undefined };
    try {
      for (;;) {
        try {
          const live = await bounded(() => this.context(threadId, generation));
          if (!live.policy.computerUse)
            throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
          // Revision checkpoint after context resolution and queue admission.
          this.assertRevision(binding, revision, turnRevision);
          if (batch) this.assertBatchLive(batch);
          if (options?.signal?.aborted) throw options.signal.reason;
          if (retrying) {
            delivery = this.selectDelivery(live, binding, input.op, appId, {
              executionMode: requestedMode,
              action: input.action,
              chords: input.chords,
              elementRef: input.elementRef,
            });
            if (delivery !== "background")
              throw new ComputerControlError({
                _tag: "ForegroundRequired",
                reason: "unsupported-in-background",
              });
          }
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
          if (
            mutation &&
            live.runtimeMode !== "full-access" &&
            !this.access.actionsApproved(threadId)
          )
            throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
          if (typeof input.appId === "string")
            this.access.require(
              threadId,
              input.appId,
              !mutation
                ? "view"
                : input.action === "setValue" || input.op === "type" || input.op === "key"
                  ? "type"
                  : "click",
            );
          if (
            (input.op === "type" || input.op === "key") &&
            !this.access
              .grants(threadId)
              .some(
                (grant) => grant.tier === "full" || (grant.tier === "click" && grant.allowTyping),
              )
          )
            throw new ComputerControlError({ _tag: "NotGranted", needed: "type" });
          let executionGeneration = binding.holder?.executionGeneration ?? 1;
          if (
            mutation &&
            delivery === "foreground" &&
            binding.holder?.scope.kind === "takeover" &&
            this.executionStates.get(threadId)?.state !== "waiting-user"
          ) {
            // The armed takeover is the lease; every foreground step reuses it.
            executionGeneration = binding.holder.executionGeneration;
          } else if (mutation) {
            const scope: ComputerLeaseScope =
              delivery === "background"
                ? { kind: "app", appId: appId! }
                : binding.holder?.scope.kind === "takeover"
                  ? binding.holder.scope
                  : { kind: "foreground" };
            const acquisitionId = randomUUID();
            const remainingMs = remainingBudget();
            const waitMs = this.host.cooperationCapable()
              ? Math.min(COMPUTER_LEASE_WAIT_MAX_MS, Math.max(0, remainingMs - 5000))
              : 0;
            // Main queues this behind a Chrome holder for up to the wait; an idle one in this
            // profile gives way first, so the queue admits as soon as the lease is gone.
            await bounded(() => this.preemptChromeFor(threadId, scope, invokeDeadline));
            this.assertRevision(binding, revision, turnRevision);
            binding.acquiring = { requestId: acquisitionId, turnId: ctx.turnId };
            let holder: ComputerLeaseHolder;
            const abortAcquire = () => this.host.abandon(acquisitionId, options!.signal!.reason);
            try {
              const acquisition = this.host.correlated(
                {
                  type: "leaseAcquire",
                  requestId: acquisitionId,
                  ...(this.host.cooperationCapable() ? { waitMs } : {}),
                  ...(this.host.cooperationCapable() &&
                  live.runtimeMode === "full-access" &&
                  delivery === "foreground"
                    ? { cooperative: true }
                    : {}),
                  holder: {
                    ...this.authorization(live, executionGeneration),
                    backend: "native",
                    threadTitle: live.threadTitle,
                    scope,
                    policyRevision: revision,
                  },
                },
                Math.min(waitMs + 2000, remainingMs),
                false,
              );
              options?.signal?.addEventListener("abort", abortAcquire, { once: true });
              if (options?.signal?.aborted) abortAcquire();
              holder = Schema.decodeUnknownSync(ComputerLeaseHolder)(
                // A refusal after the queue's wait names who held control.
                await this.measureStage("broker.lease-acquisition", () =>
                  acquisition.catch(async (cause: unknown) => {
                    throw await this.attributeBusy(cause);
                  }),
                ),
              );
            } finally {
              options?.signal?.removeEventListener("abort", abortAcquire);
              if (binding.acquiring?.requestId === acquisitionId) delete binding.acquiring;
            }
            this.host.send({ type: "leaseAccepted", requestId: acquisitionId });
            // Cancellation during acquire must release the exact returned holder.
            if (
              this.bindings.get(threadId) !== binding ||
              this.pause.has(threadId) ||
              binding.endedTurnId === ctx.turnId ||
              binding.policyRevision !== revision ||
              binding.turnRevision !== turnRevision ||
              options?.signal?.aborted
            ) {
              this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder });
              throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
            }
            binding.holder = holder;
            executionGeneration = holder.executionGeneration;
          }
          if (!dispatched && options?.beforeDispatch) await bounded(options.beforeDispatch);
          if (options?.signal?.aborted) throw options.signal.reason;
          // Revision checkpoint immediately before dispatch.
          if (batch) this.assertBatchLive(batch);
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
            deadlineAtMs: Date.now() + Math.min(60_000, remainingBudget()),
            agent: { provider: live.provider, threadTitle: live.threadTitle.slice(0, 200) },
          };
          const payloadHash = createHash("sha256")
            .update(
              computerRequestPayload(envelope as Omit<ComputerAutomationRequest, "payloadHash">),
            )
            .digest("hex");
          const request = Schema.decodeUnknownSync(
            (await import("@t3tools/contracts")).ComputerAutomationRequest,
          )({ ...envelope, payloadHash });
          remainingBudget();
          if (batch) this.assertBatchLive(batch);
          if (options?.signal?.aborted) throw options.signal.reason;
          if (mutation && !dispatched) this.invalidateObservations(threadId, "action");
          if (mutation && (this.yieldEpochs.get(threadId) ?? 0) !== yieldEpoch)
            throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
          if (!dispatched) options?.onDispatch?.(delivery);
          remainingBudget();
          if (batch) this.assertBatchLive(batch);
          dispatched = true;
          this.inFlight.set(requestId, {
            threadId,
            generation,
            turnId: live.turnId,
            epoch: this.observationEpochs.get(threadId) ?? 0,
            mutation,
            ...(options?.suppressActivity ? { suppressActivity: true } : {}),
          });
          const onAbort = () => this.host.abandon(requestId, options!.signal!.reason);
          if (!mutation) options?.signal?.addEventListener("abort", onAbort, { once: true });
          let result: unknown;
          try {
            const pending = this.host.request(request);
            if (!mutation && options?.signal?.aborted) onAbort();
            result = await this.measureStage("broker.desktop-round-trip", () =>
              mutation
                ? pending
                : bounded(() => pending).catch((cause) => {
                    this.host.abandon(
                      requestId,
                      cause instanceof ComputerControlError
                        ? cause
                        : new ComputerControlError(computerError(cause)),
                    );
                    throw cause;
                  }),
            );
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
        } catch (error) {
          if (
            !(error instanceof ComputerControlError) ||
            error.error._tag !== "TargetBlocked" ||
            error.error.kind !== "foreground-busy" ||
            delivery !== "background" ||
            !["elementAction", "type", "openApp"].includes(input.op) ||
            performance.now() + 500 >= retryDeadline
          )
            throw error;
          if (options?.signal?.aborted) throw options.signal.reason;
          // The desktop rejected before any write. Never replay user-contention or unknown outcomes.
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(options!.signal!.reason);
            };
            const timer = setTimeout(() => {
              options?.signal?.removeEventListener("abort", abort);
              resolve();
            }, 500);
            options?.signal?.addEventListener("abort", abort, { once: true });
            if (options?.signal?.aborted) abort();
          });
          retrying = true;
        } finally {
          this.inFlight.delete(requestId);
        }
        requestId = randomUUID();
      }
    } finally {
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
    input: { executionMode?: unknown; action?: unknown; chords?: unknown; elementRef?: unknown },
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
    if (
      (op === "key" || (op === "scroll" && input.elementRef !== undefined)) &&
      !appId &&
      !takeover
    )
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Specify app: the app to act in.",
      });
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
        {
          events:
            this.host.backgroundEventsCapable() &&
            !!appId &&
            computerBackgroundEventAppAllowed(appId, this.options.platform ?? "darwin") &&
            (op === "scroll"
              ? typeof input.elementRef === "string"
              : op === "key" &&
                Array.isArray(input.chords) &&
                input.chords.every((chord) => typeof chord === "string") &&
                computerBackgroundKeyAllowed(input.chords, this.options.platform ?? "darwin")),
        },
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
    input: { executionMode?: unknown; action?: unknown; chords?: unknown; elementRef?: unknown },
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
        {
          kind: "session-actions",
          background: true,
          fullAccess: ctx.runtimeMode === "full-access",
        },
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
    // A takeover excludes Chrome control and main checks Chrome before it reserves: an idle
    // Chrome holder in this profile gives way first instead of the takeover waiting on it.
    await this.preemptChromeFor(threadId, { kind: "foreground" });
    const reservationController = new AbortController();
    const reserved = this.host.takeoverReservationCapable()
      ? this.host.awaitEvent(
          (message) => message.type === "takeoverReserved" && message.requestId === acquireId,
          COMPUTER_LEASE_WAIT_MAX_MS + 2000,
          reservationController.signal,
        )
      : undefined;
    const acquired = this.host.correlated(
      {
        type: "foregroundTakeoverAcquire",
        requestId: acquireId,
        approvalRequestId: approvalId,
        ...(reserved ? { waitMs: COMPUTER_LEASE_WAIT_MAX_MS } : {}),
        ...(this.host.cooperationCapable() && live.runtimeMode === "full-access"
          ? { cooperative: true }
          : {}),
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
      // Busy/cancel before reservation must never create an access request or notification.
      if (reserved)
        await Promise.race([
          reserved,
          acquired.then(() => {
            throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
          }),
        ]);
      this.assertRevision(binding, revision, turnRevision);
      if (binding.takeover?.acquireId !== acquireId || this.pause.has(threadId))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      consent = this.access
        .requestTakeover(
          threadId,
          { requestId: approvalId, appId: app.appId, appName: app.name, turnId: ctx.turnId },
          reason,
          { fullAccess: ctx.runtimeMode === "full-access" },
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
      await acquired.catch(() => undefined);
      if (binding.takeover?.acquireId === acquireId) delete binding.takeover;
      // Main's Busy names only the holder's thread id; say which thread and whether it works.
      throw await this.attributeBusy(error);
    } finally {
      reservationController.abort();
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
    } catch (error) {
      throw await this.attributeBusy(error);
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
    await this.access.requestAccess(threadId, ctx.turnId, candidates, reason, {
      kind: "apps",
      typing,
    });
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
    this.abortBatch(threadId, new ComputerControlError({ _tag: "Interrupted", cause }));
    this.waits.get(threadId)?.cancel(cause);
    if (cancelSetup)
      for (const pending of this.setupConsents.values())
        if (pending.threadId === threadId && pending.generation === generation)
          pending.settle(false);
    this.queue.flush(threadId, new ComputerControlError({ _tag: "Interrupted", cause }));
    if (binding.acquiring && (!turnId || binding.acquiring.turnId === turnId)) {
      const requestId = binding.acquiring.requestId;
      delete binding.acquiring;
      this.host.abandon(requestId, new ComputerControlError({ _tag: "Interrupted", cause }));
    }
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
    if (this.host.cooperationCapable())
      this.host.send({
        type: "computerTurnEnded",
        threadId,
        sessionGeneration: binding.generation,
        turnId,
      });
    if (
      ["waiting-user", "waiting-agent"].includes(this.executionStates.get(threadId)?.state ?? "") &&
      this.executionStates.delete(threadId)
    )
      this.publishUse();
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
    this.yieldEpochs.delete(threadId);
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
    if (this.host.sessionLifecycleCapable())
      this.host.send({ type: "computerSessionClosed", threadId, sessionGeneration: generation });
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
      if (!chromeEnabled) {
        for (const pending of this.setupConsents.values())
          if (pending.threadId === threadId && pending.generation === binding.generation)
            pending.settle(false);
        for (const listener of this.chromeDisabledListeners) {
          try {
            listener(threadId, binding.generation);
          } catch {
            // One integration's failure must not keep the others running.
          }
        }
      }
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
  async waitForTarget(
    threadId: string,
    generation: string,
    input: { app?: string; timeoutMs?: number },
  ): Promise<ComputerTargetAvailability> {
    if (!this.host.cooperationCapable())
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Update F5 to wait for a computer target.",
      });
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
      throw new ComputerControlError({
        _tag: "Execution",
        message: "timeoutMs must be between 100 and 30000.",
      });
    return Schema.decodeUnknownSync(ComputerTargetAvailability)(
      await this.wait(threadId, generation, {
        deadlineMs: performance.now() + timeoutMs,
        target: input,
      }),
    );
  }
  async wait(
    threadId: string,
    generation: string,
    input: {
      deadlineMs: number;
      batch?: ComputerBatchHandle;
      target?: { app?: string };
      settle?: {
        appId: string;
        executionMode?: "foreground" | "background";
        maxNodes: number;
        onPartial: "wait" | "return";
      };
      condition?: {
        appId: string;
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
    available?: boolean;
    reason?: ComputerTargetAvailability["reason"] | "partial-tree";
    detail?: ComputerTargetAvailability["detail"];
    settled?: boolean;
    tree?: ComputerInspectResult;
    requiresFreshObservation?: true;
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
    const abortBatch = () => abort(input.batch!.controller.signal.reason);
    input.batch?.controller.signal.addEventListener("abort", abortBatch, { once: true });
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
    let lastTree: ComputerInspectResult | undefined;
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
        if (input.batch) this.assertBatchLive(input.batch);
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
      if (input.target) {
        let appId: string | undefined;
        if (input.target.app) {
          const apps = selectComputerApp(
            (await race(
              this.invoke(
                threadId,
                generation,
                {
                  op: "resolveApps",
                  queries: [input.target.app],
                },
                Math.max(1, input.deadlineMs - performance.now()),
                {
                  signal: controller.signal,
                  beforeDispatch: validate,
                  suppressActivity: true,
                },
              ),
            )) as ReadonlyArray<ComputerApp>,
            input.target.app,
          );
          if (apps.length !== 1)
            throw new ComputerControlError({
              _tag: "Execution",
              message: "App could not be resolved uniquely; use an appId from computer_list_apps.",
            });
          appId = apps[0]!.appId;
          this.access.require(threadId, appId, "view");
        }
        await validate();
        const requestId = randomUUID();
        // Abandon with the real cause: the deadline sentinel becomes a timeout below, while a
        // turn end, pause or batch abort keeps its own interruption.
        const cancel = () => this.host.abandon(requestId, controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          // The desktop owns the deadline: it answers first with the condition that held.
          const remaining = Math.max(
            100,
            Math.min(
              30_000,
              Math.floor(
                input.deadlineMs - performance.now() - COMPUTER_TARGET_WAIT_DESKTOP_MARGIN_MS,
              ),
            ),
          );
          const outcome = Schema.decodeUnknownSync(ComputerTargetAvailability)(
            await race(
              this.host.correlated(
                {
                  type: "targetWait",
                  requestId,
                  holder: {
                    ...this.authorization(ctx, binding.holder?.executionGeneration ?? 1),
                    backend: "native",
                    threadTitle: ctx.threadTitle,
                    scope: appId
                      ? { kind: "app", appId }
                      : (binding.holder?.scope ?? { kind: "foreground" }),
                    policyRevision: revision,
                    ...(ctx.runtimeMode === "full-access" ? { cooperative: true } : {}),
                  },
                  ...(appId ? { appId } : {}),
                  timeoutMs: remaining,
                },
                remaining + 1000,
                false,
              ),
            ),
          );
          await validate();
          return { ...result(), ...outcome };
        } finally {
          controller.signal.removeEventListener("abort", cancel);
        }
      }
      if (!input.condition && !input.settle) {
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
            {
              signal: controller.signal,
              beforeDispatch: validate,
              suppressActivity: true,
              ...(input.batch ? { batch: input.batch } : {}),
            },
          ),
        );
      let fingerprint: string | undefined;
      let stableSince = 0;
      let attempt = 0;
      while (true) {
        await validate();
        let inspected: ComputerInspectResult | undefined;
        try {
          inspected = (await invoke({
            op: "inspect",
            appId: (input.settle ?? condition)!.appId,
            maxNodes: input.settle?.maxNodes ?? 100,
            ...((input.settle ?? condition)?.executionMode
              ? { executionMode: (input.settle ?? condition)!.executionMode }
              : {}),
          })) as ComputerInspectResult;
        } catch (cause) {
          if (!input.settle) throw cause;
          const error = computerError(cause);
          if (
            !["Execution", "Busy", "StaleElement", "ResultTooLarge"].includes(error._tag) &&
            !(error._tag === "TargetBlocked" && error.kind === "foreground-busy")
          )
            throw cause;
        }
        await validate();
        if (input.settle) {
          if (inspected) lastTree = inspected;
          if (inspected?.truncated) {
            if (input.settle.onPartial === "wait") {
              await cancelled;
              throw deadline;
            }
            this.publish({
              channel: "computer.activity",
              data: { threadId, backend: "native", op: "wait", status: "completed" },
            });
            return { ...result(), settled: false, reason: "partial-tree" };
          }
          if (inspected?.accessible && inspected.nodes.length) {
            const next = computerInspectFingerprint(inspected.nodes);
            if (fingerprint !== next) {
              fingerprint = next;
              stableSince = performance.now();
            } else if (performance.now() - stableSince >= COMPUTER_SETTLE_STABLE_MS) {
              this.publish({
                channel: "computer.activity",
                data: { threadId, backend: "native", op: "wait", status: "completed" },
              });
              return { ...result(), settled: true, tree: inspected };
            }
          } else {
            fingerprint = undefined;
          }
        } else {
          if (!inspected)
            throw new ComputerControlError({
              _tag: "Execution",
              message: "Inspection unavailable.",
            });
          if (!inspected.accessible)
            throw new ComputerControlError({
              _tag: "Execution",
              message: "The app's accessibility tree is unavailable.",
            });
          const matches = inspected.nodes
            .filter(
              (node) =>
                (condition!.role === undefined || node.role === condition!.role) &&
                (condition!.name === undefined || node.name === condition!.name),
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
              tree: inspected,
              snapshotId: inspected.snapshotId,
              elementRefs: matches.map((node) => node.elementRef),
            };
          }
        }
        const delay = Math.min(
          input.settle
            ? COMPUTER_WAIT_POLL_MS
            : Math.min(COMPUTER_WAIT_POLL_MS * ++attempt, COMPUTER_WAIT_POLL_MAX_MS),
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
        if (input.target && started)
          return { ...result(), available: false, timedOut: true, requiresFreshObservation: true };
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
        return {
          ...result(),
          ...(input.condition ? { matched: false, timedOut: true } : {}),
          ...(input.settle
            ? lastTree?.truncated
              ? { settled: false, reason: "partial-tree" as const }
              : { settled: false, timedOut: true, ...(lastTree ? { tree: lastTree } : {}) }
            : {}),
        };
      }
      if (started)
        this.publish({
          channel: "computer.activity",
          data: { threadId, backend: "native", op: "wait", status: "interrupted" },
        });
      throw error;
    } finally {
      clearTimeout(timer);
      input.batch?.controller.signal.removeEventListener("abort", abortBatch);
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
    /** A same-profile `Busy`'s holder, so the card can link to it. */
    heldByThreadId?: string,
  ): void {
    if (this.generation(threadId) !== generation) return;
    this.publish({
      channel: "computer.activity",
      data: {
        source: "tool",
        threadId,
        backend: "native",
        op,
        status: "failed",
        outcome,
        ...(heldByThreadId && heldByThreadId !== threadId ? { heldByThreadId } : {}),
      },
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
    this.clearChromeOtherLinger();
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
    // Register cleanup before starting any profile-local services.
    yield* Effect.addFinalizer(() => Effect.sync(() => host.close()));
    const closeBrowser = yield* Effect.promise(() =>
      startBrowserOpenBridge(config.stateDir, {
        openExternalUrl: (url, options) => host.openExternalUrl(url, options),
        isPreapproved: async (token) => {
          const threadId = browserOpenThreadFor(token);
          return threadId ? run(browserOpenThreadIsFullAccess(threadId)) : false;
        },
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(closeBrowser));
    const pause = yield* Effect.serviceOption(AgentControlPauseService);
    const performanceStageProbe = yield* PerformanceStageProbe;
    const storage = computerAccessStorage({
      exists: () => run(fs.exists(file)),
      read: () => run(fs.readFileString(file)),
      quarantine: (suffix) =>
        run(fs.rename(file, path.join(config.stateDir, `computer-access.${suffix}`))),
      warn: (message) => console.warn(message),
      write: (contents) => run(writeFileStringAtomically({ filePath: file, contents })),
    });
    const broker = new ComputerAutomationBrokerRuntime(host, {
      performanceStageProbe,
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
      threadTitle: async (threadId) => {
        const rows = await run(
          sql<{
            title: string;
          }>`SELECT title FROM projection_threads WHERE thread_id=${threadId}`,
        );
        return rows[0]?.title;
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
    // broker.close owns host.close from here, including initialization failure.
    // The early host finalizer remains safe because close is idempotent.
    yield* Effect.addFinalizer(() => Effect.sync(() => broker.close()));
    yield* Effect.promise(() => broker.initialize());
    return broker;
  }),
);
