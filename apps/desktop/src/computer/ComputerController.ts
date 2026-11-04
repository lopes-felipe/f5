import { createHash } from "node:crypto";
import type {
  ComputerAutomationRequest,
  ComputerAuthorization,
  ComputerDelivery,
  ComputerDisplay,
  ComputerExecutionState,
  ComputerLeaseHolder,
  ComputerLeaseScope,
  ComputerActivity,
  ComputerPauseCause,
  ComputerScreenshot,
  ComputerInspectResult,
  ComputerTargetAvailability,
} from "@t3tools/contracts";
import {
  ComputerControlError,
  computerError,
  computerRequestPayload,
  isComputerMutation,
} from "@t3tools/shared/computerControl";
import {
  COMPUTER_CHROME_APP_IDS,
  computerScopeAllows,
  computerScopeDelivery,
  computerBackgroundKeyAllowed,
} from "@t3tools/shared/computerExecution";
import { computerBackgroundEventAppAllowed } from "@t3tools/shared/computerApps";
import { computerModelToNative } from "@t3tools/shared/computerGeometry";
import {
  COMPUTER_BACKGROUND_CAPABILITY,
  COMPUTER_SHARED_APP_CAPABILITY,
  COMPUTER_BACKGROUND_EVENTS_CAPABILITY,
} from "@t3tools/contracts";
import { ComputerLeaseAuthority, sameComputerHolder } from "./ComputerLeaseAuthority";
import type { ComputerHelper } from "./ComputerHelperClient";
import { ComputerCooperation } from "./ComputerCooperation";
import { ComputerAdmissionQueue, type ComputerAdmission } from "./ComputerAdmissionQueue";
import { ComputerSharedAppState } from "./ComputerSharedAppState";

interface Admission {
  owner: string;
  sessionGeneration: string;
  mutation: boolean;
  hash: string;
  generation: number;
  promise?: Promise<unknown> | undefined;
  bytes?: number | undefined;
  result?: unknown;
  error?: unknown;
}
interface Job {
  request: ComputerAutomationRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
  /** queued → sent (helper may have acted) → terminal; confirmed success survives later failure. */
  phase: "queued" | "sent" | "terminal";
  cancellation: Promise<void>;
  cancel: () => void;
}
export interface ComputerOverlaySurface {
  show(holder: ComputerLeaseHolder): void;
  clear(): void;
  action(
    request: ComputerAutomationRequest,
    displays: ReadonlyArray<ComputerDisplay>,
    target?: ComputerOverlayTarget,
  ): Promise<void>;
  windowIds(): ReadonlyArray<number>;
  waiting?(holder: ComputerLeaseHolder, seconds?: number): void;
}
export interface ComputerOverlayTarget {
  appName?: string;
  displayId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface ComputerExecutionStateUpdate {
  threadId: string;
  sessionGeneration: string;
  state: ComputerExecutionState | null;
  appId?: string;
  delivery?: ComputerDelivery;
  pauseCause?: ComputerPauseCause;
}
const STOP_CAUSE: Record<
  ComputerPauseCause,
  "paused" | "user-input" | "kill-switch" | "access-changed" | "permit-expired"
> = {
  paused: "paused",
  "kill-switch": "kill-switch",
  "user-input": "user-input",
  "permit-expired": "permit-expired",
  "target-active": "user-input",
  activation: "paused",
  "outcome-unknown": "paused",
  "access-changed": "access-changed",
};
const isForegroundHolder = (holder: ComputerLeaseHolder) => holder.scope.kind !== "app";
export class ComputerController {
  readonly cooperation: ComputerCooperation;
  readonly admission: ComputerAdmissionQueue;
  private admissionCheck: ((holder: ComputerLeaseHolder) => void) | undefined;
  private readonly availabilityListeners = new Set<() => void>();
  private readonly endedTurns = new Map<string, { sessionGeneration: string; turnId: string }>();
  private readonly availabilityWaiters = new Map<
    string,
    { holder: ComputerLeaseHolder; cancel: () => void }
  >();
  private readonly paused = new Set<string>();
  private readonly pauseCauses = new Map<string, ComputerPauseCause>();
  private readonly controlled = new Map<string, ComputerLeaseHolder>();
  private readonly grants = new Map<string, ComputerAuthorization>();
  private readonly admitted = new Map<string, Admission>();
  private cacheBytes = 0;
  private cachedCount = 0;
  /** One active mutation per execution generation; 32 queued across all generations. */
  private readonly mutationQueues = new Map<number, Job[]>();
  private queuedMutations = 0;
  private readonly activeMutations = new Map<number, Job>();
  private readonly observationQueue: Job[] = [];
  private readonly activeObservations = new Set<Job>();
  private physicalInputAt = -Infinity;
  private recentlyStopped: Array<{ holder: ComputerLeaseHolder; at: number }> = [];
  /** Generations the helper currently holds a permit for, keyed by execution generation. */
  private readonly permitted = new Map<number, ComputerLeaseHolder>();
  private overlayHolder: ComputerLeaseHolder | undefined;
  /** Background targets whose last mutation had an unknown outcome, per thread + app. */
  private readonly quarantined = new Set<string>();
  /** Set while a takeover drains other threads' background work before arming. */
  private takeoverDraining = false;
  /**
   * Mutations the helper may still be executing. Releasing or cancelling a lease does not end
   * them; they keep conflicting scopes excluded until the helper answers or a drain confirms.
   */
  private readonly nativeWork = new Set<{
    key: string;
    generation: number;
    scope: ComputerLeaseScope;
  }>();
  /** Request IDs whose OS action the helper confirmed before any optional capture. */
  private readonly confirmed = new Set<string>();
  /** Input sequence the helper reported idle at, checked natively when a takeover resumes. */
  private takeoverInputSequence: number | undefined;
  private frontmostAppId: string | undefined;
  private readonly appNames = new Map<string, string>();
  private readonly snapshots = new Map<
    string,
    { owner: string; appId: string; result: ComputerInspectResult }
  >();
  private readonly sharedApps = new ComputerSharedAppState();
  sharedAppsAvailable(): boolean {
    return this.helper.capabilities?.().includes(COMPUTER_SHARED_APP_CAPABILITY) ?? false;
  }
  backgroundEventsAvailable(): boolean {
    return this.helper.capabilities?.().includes(COMPUTER_BACKGROUND_EVENTS_CAPABILITY) ?? false;
  }
  private readonly permitTimer: ReturnType<typeof setInterval>;
  private readonly offEvent: () => void;
  private readonly offLease: () => void;
  constructor(
    readonly lease: ComputerLeaseAuthority,
    private readonly helper: ComputerHelper,
    private readonly overlay: ComputerOverlaySurface,
    private readonly options: {
      f5Pids: () => ReadonlyArray<number>;
      f5BundlePath: string;
      platform: "darwin" | "win32";
      activity: (profileId: string, activity: ComputerActivity) => void;
      thumbnail?: (screenshot: ComputerScreenshot) => string | undefined;
      paused: (holder: ComputerLeaseHolder, cause: ComputerPauseCause) => void;
      /** Whether background delivery is negotiated and healthy end to end. */
      backgroundAvailable?: () => boolean;
      executionState?: (profileId: string, update: ComputerExecutionStateUpdate) => void;
      /** Validates a takeover holder against its Electron-issued receipt. */
      takeoverValid?: (holder: ComputerLeaseHolder) => boolean;
      /** Takeover receipts are revoked when their holder stops. */
      holderStopped?: (holder: ComputerLeaseHolder) => void;
      cooperationEnabled?: (profileId: string) => boolean;
      targetYielded?: (holder: ComputerLeaseHolder, appId?: string) => void;
      foregroundContinued?: (previous: ComputerLeaseHolder, next: ComputerLeaseHolder) => void;
      now?: () => number;
    },
  ) {
    this.cooperation = new ComputerCooperation(helper, () => this.cooperationNow());
    this.admission = new ComputerAdmissionQueue({
      conflicts: (a, b) => lease.scopesConflict(a, b),
      renewal: (holder) => lease.renewal(holder),
      sweep: (head) => {
        for (const holder of lease.idleConflicts(head.scope, 10_000)) {
          if (this.key(holder) === this.key(head)) continue;
          const key = this.key(holder);
          const jobs = [
            ...this.activeMutations.values(),
            ...this.activeObservations,
            ...this.observationQueue,
            ...[...this.mutationQueues.values()].flat(),
          ];
          if (
            jobs.some((job) => this.key(job.request.authorization) === key) ||
            [...this.nativeWork].some((entry) => entry.key === key)
          )
            continue;
          lease.release(holder);
          this.options.holderStopped?.(holder);
        }
      },
      state: (holder, waiting) => this.publishState(holder, waiting ? "waiting-agent" : null),
    });
    this.offEvent = helper.onEvent((message) => this.helperEvent(message));
    this.offLease = lease.subscribe((holders) => {
      this.holdersChanged(holders);
      this.admission.changed();
      for (const changed of this.availabilityListeners) changed();
    });
    this.permitTimer = setInterval(() => {
      lease.sweep();
      for (const holder of lease.holders())
        if (!this.paused.has(this.key(holder)) && !this.cooperation.yielded.has(this.key(holder)))
          helper.control({
            type: "permit",
            executionGeneration: holder.executionGeneration,
            expiresInMs: 1000,
          });
      for (const entry of this.cooperation.yielded.values()) {
        if (entry.appId || !this.lease.find(entry.holder)) continue;
        const ready = this.cooperation.readiness(entry.holder);
        const age = ready?.lastUserInputAgeMs ?? 0;
        this.overlay.waiting?.(
          entry.holder,
          ready && !ready.inputHeld && age >= 0
            ? Math.max(0, Math.ceil((entry.dwell - age) / 1000))
            : undefined,
        );
        if (this.cooperationNow() - entry.at >= 60_000 && this.lease.find(entry.holder)) {
          this.lease.release(entry.holder);
          this.options.holderStopped?.(entry.holder);
          this.overlay.clear();
        }
      }
    }, 250);
    this.permitTimer.unref();
  }
  /** Native activity ages and yield dwell must not advance when the system clock changes. */
  private cooperationNow(): number {
    return this.options.now?.() ?? performance.now();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private key(auth: Pick<ComputerAuthorization, "profileId" | "threadId">): string {
    return `${auth.profileId}\0${auth.threadId}`;
  }
  /** Background generations need a helper that understands per-generation control. */
  private capable(): boolean {
    return this.helper.capabilities?.().includes(COMPUTER_BACKGROUND_CAPABILITY) ?? false;
  }
  cooperationAvailable(): boolean {
    return this.cooperation.supported();
  }
  setAdmissionCheck(check: (holder: ComputerLeaseHolder) => void): void {
    this.admissionCheck = check;
  }
  admitWhenFree<T>(entry: ComputerAdmission<T>): Promise<T> {
    this.controlled.set(this.key(entry.holder), entry.holder);
    return this.admission.admit(entry);
  }
  assertTakeoverAdmission(holder: ComputerLeaseHolder): void {
    // A reservation owns no input permit; user-idle checks run after native consent.
    this.assertAdmission(holder, "reservation");
  }
  cancelAdmission(profileId: string, requestId: string): void {
    this.admission.cancel(
      (entry) => entry.profileId === profileId && entry.requestId === requestId,
    );
  }
  private cooperates(holder: ComputerLeaseHolder): boolean {
    return this.cooperation.supported() && !!this.options.cooperationEnabled?.(holder.profileId);
  }
  async prepareAcquisition(holder: ComputerLeaseHolder): Promise<void> {
    if (this.cooperates(holder)) {
      const auth = this.grants.get(this.key(holder));
      if (
        !auth ||
        auth.sessionGeneration !== holder.sessionGeneration ||
        auth.grantVersion !== holder.grantVersion
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
      const appId = holder.scope.kind === "app" ? holder.scope.appId : undefined;
      if (appId && !auth.grants.some((grant) => grant.appId === appId))
        throw new ComputerControlError({ _tag: "NotGranted", needed: "view" });
      await this.cooperation.prepare(holder);
    }
  }
  private yieldable(holder: ComputerLeaseHolder, cause: unknown): boolean {
    if (!this.cooperates(holder)) return false;
    if (holder.scope.kind !== "app" && !holder.cooperative) return false;
    return (
      typeof cause === "string" &&
      (["pointer", "key", "scroll", "drag"].includes(cause) ||
        (holder.scope.kind === "app" ? cause === "frontmost" : cause === "move"))
    );
  }
  private yieldHolder(holder: ComputerLeaseHolder): void {
    if (holder.scope.kind === "app") this.sharedApps.yielded(holder.scope.appId);
    const key = this.key(holder);
    if (
      this.cooperation.yielded.get(key)?.holder.executionGeneration === holder.executionGeneration
    )
      return;
    this.cooperation.yield(holder);
    // Sent mutations settle from native confirmation or an explicit pre-write interruption.
    this.cancelWhere(
      (job) => this.key(job.request.authorization) === key && job.phase === "queued",
      new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" }),
    );
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.owner === key) this.snapshots.delete(id);
    this.helper.control({ type: "suspend", executionGeneration: holder.executionGeneration });
    this.publishState(holder, "waiting-user");
    this.options.targetYielded?.(
      holder,
      holder.scope.kind === "app" ? holder.scope.appId : undefined,
    );
    const retire = async () => {
      try {
        await this.helper.drain?.(holder.executionGeneration, 5000);
      } catch {
        // A drain failure cannot prove the in-flight action is safe to continue.
        if (
          this.cooperation.yielded.get(key)?.holder.executionGeneration ===
          holder.executionGeneration
        )
          this.stopThread(holder, "outcome-unknown");
        return;
      }
      if (
        this.cooperation.yielded.get(key)?.holder.executionGeneration !== holder.executionGeneration
      )
        return;
      this.helper.control({ type: "retire", executionGeneration: holder.executionGeneration });
      if (holder.scope.kind === "app") {
        this.lease.release(holder);
        this.options.holderStopped?.(holder);
      }
    };
    void retire();
  }
  /** One predicate for acquisition, dispatch and advisory waiting. No cross-profile labels escape. */
  private assertAdmission(
    holder: ComputerLeaseHolder,
    phase: "execute" | "foreground-ownership" | "reservation" = "execute",
  ): void {
    const ended = this.endedTurns.get(this.key(holder));
    if (ended?.sessionGeneration === holder.sessionGeneration && ended.turnId === holder.turnId)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (this.paused.has(this.key(holder)))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    const status = this.helper.status();
    if (!status.available)
      throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
    this.admissionCheck?.(holder);
    if (phase === "foreground-ownership") {
      const other = this.lease
        .holders()
        .some((entry) => this.key(entry) !== this.key(holder) && entry.scope.kind !== "app");
      const pending = this.lease.pendingTakeover()?.holder;
      if (other || (pending && this.key(pending) !== this.key(holder)))
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
      return;
    }
    if (
      phase !== "reservation" &&
      this.cooperates(holder) &&
      (holder.scope.kind === "app" || holder.cooperative)
    ) {
      if (this.cooperation.blocked(holder))
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
    } else if (
      phase !== "reservation" &&
      (holder.scope.kind === "app"
        ? this.frontmostAppId === holder.scope.appId
        : this.inputIdleMs() < 1500)
    )
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
    if (this.lease.conflictsFor(holder))
      throw new ComputerControlError({ _tag: "Busy", holder: "other-profile" });
    if (
      this.takeoverDraining ||
      (holder.scope.kind === "app" &&
        this.lease.takeover() &&
        this.key(this.lease.takeover()!) !== this.key(holder)) ||
      this.nativeWorkConflicts(holder.scope)
    )
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
  }
  async waitForTarget(
    requestId: string,
    holder: ComputerLeaseHolder,
    appId: string | undefined,
    timeoutMs: number,
  ): Promise<ComputerTargetAvailability> {
    const waitKey = holder.profileId + "\0" + requestId;
    if (this.availabilityWaiters.size >= 32 || this.availabilityWaiters.has(waitKey))
      throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
    this.controlled.set(this.key(holder), holder);
    let cancelled = false;
    let rejectCancellation!: (error: unknown) => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const race = <T>(work: Promise<T>) => Promise.race([work, interruption]);
    this.availabilityWaiters.set(waitKey, {
      holder,
      cancel: () => {
        cancelled = true;
        rejectCancellation(new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }));
      },
    });
    const deadline = performance.now() + timeoutMs;
    let reason: ComputerTargetAvailability["reason"] = "user-active";
    try {
      if (appId) await race(this.cooperation.prepare(holder, appId));
      do {
        if (cancelled) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        if (this.paused.has(this.key(holder)))
          throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
        const auth = this.grants.get(this.key(holder));
        if (
          !auth ||
          auth.sessionGeneration !== holder.sessionGeneration ||
          auth.grantVersion !== holder.grantVersion ||
          (appId && !auth.grants.some((grant) => grant.appId === appId))
        )
          throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
        await race(this.cooperation.refresh(holder, appId));
        if (cancelled) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        try {
          // Without an app and without a yielded foreground, only foreground ownership is relevant.
          const yielded = this.cooperation.yielded.get(this.key(holder));
          if (!appId && (!yielded || yielded.appId || !this.lease.find(yielded.holder))) {
            try {
              this.assertAdmission(holder, "foreground-ownership");
            } catch (error) {
              const failure = computerError(error);
              if (
                failure._tag !== "Busy" &&
                !(failure._tag === "TargetBlocked" && failure.kind === "foreground-busy")
              )
                throw error;
              return {
                available: false,
                timedOut: false,
                reason: "foreground-busy",
                requiresFreshObservation: true,
              };
            }
            return { available: true, timedOut: false, requiresFreshObservation: true };
          }
          this.assertAdmission(holder);
          return { available: true, timedOut: false, requiresFreshObservation: true };
        } catch (cause) {
          const error = computerError(cause);
          if (error._tag === "Busy") reason = "agent-busy";
          else if (
            error._tag === "TargetBlocked" &&
            (error.kind === "foreground-busy" || error.kind === "user-active")
          )
            reason = error.kind;
          else throw cause;
        }
        if (performance.now() >= deadline) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let changed!: () => void;
        try {
          await race(
            new Promise<void>((resolve) => {
              changed = resolve;
              this.availabilityListeners.add(changed);
              timer = setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now())));
            }),
          );
        } finally {
          clearTimeout(timer);
          this.availabilityListeners.delete(changed);
        }
      } while (performance.now() < deadline);
      return { available: false, timedOut: true, reason, requiresFreshObservation: true };
    } finally {
      this.availabilityWaiters.delete(waitKey);
    }
  }
  turnEnded(profileId: string, threadId: string, sessionGeneration: string, turnId?: string): void {
    const key = this.key({ profileId, threadId });
    this.sharedApps.releaseOwner(key);
    this.admission.cancel(
      (entry) =>
        this.key(entry.holder) === key && entry.holder.sessionGeneration === sessionGeneration,
    );
    const turn = turnId ?? this.controlled.get(key)?.turnId ?? this.grants.get(key)?.turnId;
    if (turn) this.endedTurns.set(key, { sessionGeneration, turnId: turn });
    const matches = (holder: ComputerLeaseHolder) =>
      holder.profileId === profileId &&
      holder.threadId === threadId &&
      holder.sessionGeneration === sessionGeneration;
    for (const waiter of this.availabilityWaiters.values())
      if (matches(waiter.holder)) waiter.cancel();
    for (const entry of this.cooperation.yielded.values())
      if (matches(entry.holder) && this.lease.find(entry.holder)) {
        this.lease.release(entry.holder);
        this.options.holderStopped?.(entry.holder);
      }
    this.cooperation.release(matches);
  }
  private helperEvent(message: Record<string, unknown>): void {
    this.admission.changed();
    for (const changed of this.availabilityListeners) changed();
    const generation =
      typeof message.executionGeneration === "number" ? message.executionGeneration : undefined;
    const tagged = generation !== undefined ? this.permitted.get(generation) : undefined;
    if (message.type === "killSwitch") this.stop("kill-switch");
    else if (message.type === "actionConfirmed") {
      if (typeof message.requestId === "string") {
        this.confirmed.add(message.requestId);
        if (this.confirmed.size > 256) this.confirmed.delete(this.confirmed.values().next().value!);
      }
    } else if (message.type === "physicalInput") {
      this.physicalInputAt = this.now();
      if (tagged && this.yieldable(tagged, message.cause)) this.yieldHolder(tagged);
      else if (tagged) this.stopThread(tagged, "user-input");
      else if (generation === undefined)
        // Untagged input is legacy/Windows or generic activity: it pauses only holders that
        // share the user's pointer and keyboard. Background holders pause on conflicts only.
        for (const holder of this.lease.holders())
          if (
            isForegroundHolder(holder) &&
            !(
              message.idle === true &&
              holder.cooperative &&
              this.cooperates(holder) &&
              this.cooperation.yielded.has(this.key(holder))
            )
          )
            this.stopThread(holder, "user-input");
    } else if (message.type === "targetInterrupted") {
      if (tagged && this.yieldable(tagged, message.cause)) this.yieldHolder(tagged);
      else if (tagged) this.stopThread(tagged, "target-active");
    } else if (message.type === "activationIncident") {
      if (tagged) this.stopThread(tagged, "activation");
    } else if (message.type === "executionState") {
      if (
        tagged &&
        !this.cooperation.yielded.has(this.key(tagged)) &&
        !this.paused.has(this.key(tagged)) &&
        (message.state === "waiting-secure-input" || message.state === "active")
      )
        this.publishState(tagged, message.state);
    } else if (message.type === "heartbeat") {
      this.cooperation.heartbeat(message);
      if (typeof message.lastUserInputAgeMs === "number" && message.lastUserInputAgeMs >= 0)
        this.physicalInputAt = Math.max(
          this.physicalInputAt,
          this.now() - message.lastUserInputAgeMs,
        );
      this.frontmostAppId =
        typeof message.frontmostAppId === "string" ? message.frontmostAppId : undefined;
    } else if (message.type === "hello") {
      if (
        this.cooperation.yielded.size ||
        this.availabilityWaiters.size ||
        this.lease.holders().length
      )
        this.stop("paused");
      this.cooperation.reset();
      this.sharedApps.reset();
      // The previous helper process is gone, and with it any unresolved native work.
      this.nativeWork.clear();
      // A replacement helper starts suspended and has no remembered authorization. Existing
      // holders are never re-resumed into it; only a newly granted lease resumes.
      for (const authorization of this.grants.values())
        this.helper.control({ type: "grantsChanged", authorization });
    } else if (
      message.type === "status" &&
      !this.helper.status().available &&
      (this.lease.holders().length > 0 ||
        this.lease.pendingTakeover() ||
        this.cooperation.yielded.size ||
        this.availabilityWaiters.size)
    )
      this.stop("paused");
    else if (message.type === "permitExpired") {
      if (tagged) this.stopThread(tagged, "permit-expired");
      else if (generation === undefined) this.stop("permit-expired");
    }
  }
  private holdersChanged(holders: ReadonlyArray<ComputerLeaseHolder>): void {
    const next = new Map(holders.map((holder) => [holder.executionGeneration, holder]));
    for (const [generation, previous] of this.permitted)
      if (!next.has(generation)) {
        if (
          previous.scope.kind === "takeover" &&
          this.cooperation.yielded.has(this.key(previous)) &&
          !holders.some((holder) => this.key(holder) === this.key(previous))
        )
          this.options.holderStopped?.(previous);
        this.permitted.delete(generation);
        this.helper.control(
          this.capable()
            ? { type: "retire", executionGeneration: generation }
            : { type: "suspend" },
        );
        this.forgetAdmissions((entry) => entry.generation === generation);
      }
    for (const holder of holders) {
      if (this.cooperation.yielded.has(this.key(holder))) continue;
      if (this.permitted.has(holder.executionGeneration)) continue;
      this.permitted.set(holder.executionGeneration, holder);
      this.helper.control({
        type: "permit",
        executionGeneration: holder.executionGeneration,
        expiresInMs: 1000,
        scope: holder.scope,
        cooperative: holder.cooperative === true,
      });
      const expected =
        holder.scope.kind === "takeover"
          ? this.takeoverInputSequence
          : holder.cooperative
            ? this.cooperation.readiness(holder)?.inputSequence
            : undefined;
      if (holder.scope.kind === "takeover") this.takeoverInputSequence = undefined;
      this.helper.control({
        type: "resume",
        executionGeneration: holder.executionGeneration,
        scope: holder.scope,
        ...(expected !== undefined ? { inputSequence: expected } : {}),
        ...(this.cooperates(holder) && holder.scope.kind === "app"
          ? { activityEpoch: this.cooperation.readiness(holder)?.activityEpoch }
          : {}),
        cooperative: holder.cooperative === true,
      });
    }
    // Only foreground holders own the screen; background work never draws an overlay.
    const foreground = holders.find(isForegroundHolder);
    if (!foreground || !this.overlayHolder || !sameComputerHolder(foreground, this.overlayHolder)) {
      this.overlay.clear();
      this.overlayHolder = foreground;
      if (foreground) this.overlay.show(foreground);
    }
  }
  /** Milliseconds since the last physical input the helper or OS reported. */
  inputIdleMs(): number {
    return this.now() - this.physicalInputAt;
  }
  frontmost(): string | undefined {
    return this.frontmostAppId;
  }
  /**
   * Native readiness for a takeover: the helper's own idle age and input sequence, read now
   * rather than from the last heartbeat. The sequence is re-checked by the helper on resume.
   */
  async takeoverReadiness(holder?: ComputerLeaseHolder): Promise<{ idleMs: number }> {
    if (holder?.cooperative && this.cooperates(holder)) {
      await this.cooperation.prepare(holder);
      const ready = this.cooperation.readiness(holder)!;
      this.takeoverInputSequence = ready.inputSequence;
      return {
        idleMs: this.cooperation.blocked(holder)
          ? 0
          : ready.lastUserInputAgeMs < 0
            ? Infinity
            : ready.lastUserInputAgeMs,
      };
    }
    if (!this.helper.readiness) return { idleMs: this.inputIdleMs() };
    const ready = await this.helper.readiness();
    if (ready.lastUserInputAgeMs >= 0)
      this.physicalInputAt = Math.max(this.physicalInputAt, this.now() - ready.lastUserInputAgeMs);
    this.takeoverInputSequence = ready.inputSequence;
    return { idleMs: ready.lastUserInputAgeMs < 0 ? Infinity : ready.lastUserInputAgeMs };
  }
  /** Whether unresolved native work still excludes `scope` (or Chrome control). */
  nativeWorkConflicts(scope: ComputerLeaseScope | "chrome"): boolean {
    for (const entry of this.nativeWork)
      if (
        scope === "chrome"
          ? entry.scope.kind !== "app" || COMPUTER_CHROME_APP_IDS.includes(entry.scope.appId)
          : this.lease.scopesConflict(entry.scope, scope)
      )
        return true;
    return false;
  }
  private trackNative(request: ComputerAutomationRequest, native: Promise<unknown>): void {
    if (!isComputerMutation(request.op)) return;
    const entry = {
      key: this.key(request.authorization),
      generation: request.authorization.executionGeneration,
      scope: this.lease.find(request.authorization)?.scope ?? { kind: "foreground" as const },
    };
    this.nativeWork.add(entry);
    const settle = () => {
      this.nativeWork.delete(entry);
      this.pump();
      this.admission.changed();
    };
    // A timeout or lost reply is not completion: only a drain proves the helper finished. A
    // generation still stuck in its app stays excluded and is drained again; a retired helper
    // (drain failure, or a replacement's hello clearing the set) ends the wait.
    const drainUntilDone = async (): Promise<void> => {
      while (this.nativeWork.has(entry)) {
        try {
          await this.helper.drain!(entry.generation, 5000);
          break;
        } catch (cause) {
          const failure = computerError(cause);
          if (failure._tag !== "TargetBlocked") break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      settle();
    };
    native.then(
      (result) => {
        this.recordSharedMutation(request, result);
        settle();
      },
      (error: unknown) => {
        if (
          computerError(error)._tag === "OutcomeUnknown" ||
          this.confirmed.has(request.requestId)
        ) {
          const confirmed = this.confirmed.has(request.requestId);
          if (!confirmed && "appId" in request && request.appId)
            this.sharedApps.yielded(request.appId);
          this.recordSharedMutation(request, {}, confirmed);
        }
        if (computerError(error)._tag === "OutcomeUnknown" && this.capable() && this.helper.drain)
          void drainUntilDone();
        else settle();
      },
    );
  }
  private recordSharedMutation(
    request: ComputerAutomationRequest,
    result: unknown,
    confirmed = true,
  ): void {
    if (
      request.delivery !== "background" ||
      !("appId" in request) ||
      !request.appId ||
      !this.sharedAppsAvailable() ||
      (result &&
        typeof result === "object" &&
        "actionCompleted" in result &&
        result.actionCompleted === false)
    )
      return;
    const key = this.key(request.authorization);
    const ended = this.endedTurns.get(key);
    const canPress =
      confirmed &&
      !this.paused.has(key) &&
      !this.cooperation.yielded.has(key) &&
      this.grants.get(key)?.sessionGeneration === request.authorization.sessionGeneration &&
      !(
        ended?.sessionGeneration === request.authorization.sessionGeneration &&
        ended.turnId === request.authorization.turnId
      );
    this.sharedApps.mutated(
      request.appId,
      key,
      canPress && request.op === "elementAction" && request.action === "press",
    );
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.appId === request.appId && snapshot.owner !== this.key(request.authorization))
        this.snapshots.delete(id);
  }
  private async awaitNative(
    predicate: (entry: { key: string; generation: number }) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    const pending = () => [...this.nativeWork].some(predicate);
    while (pending() && this.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return !pending();
  }
  /** A mutation whose effect is unknown pauses its thread into recovery until local resume. */
  private recordUnknown(request: ComputerAutomationRequest): void {
    const key = this.key(request.authorization);
    const appId = "appId" in request && request.appId ? request.appId : "*";
    this.quarantined.add(`${key}\0${appId}`);
    const holder = this.lease.holders().find((entry) => this.key(entry) === key);
    if (holder) {
      this.stopThread(holder, "outcome-unknown");
      return;
    }
    const wasPaused = this.paused.has(key);
    this.paused.add(key);
    this.pauseCauses.set(key, "outcome-unknown");
    const last = this.controlled.get(key);
    if (last) {
      if (!wasPaused) this.options.paused(last, "outcome-unknown");
      this.publishState(last, "recovery", "outcome-unknown");
    }
  }
  /** The OS action completed; only its follow-up screenshot was lost. */
  private completedWithoutCapture(request: ComputerAutomationRequest): unknown {
    return {
      displayId: "unknown",
      geometryGeneration: "unknown",
      frontmostApp: null,
      cursor: null,
      actionCompleted: true,
      screenshotError: "Interrupted",
      ...(request.delivery === "background"
        ? {
            delivery: "background",
            ...("appId" in request && request.appId ? { target: { appId: request.appId } } : {}),
          }
        : {}),
    };
  }
  isPaused(profileId: string, threadId: string): boolean {
    return this.paused.has(this.key({ profileId, threadId }));
  }
  acquire(holder: ComputerLeaseHolder): ComputerLeaseHolder {
    const key = this.key(holder);
    this.controlled.set(key, holder);
    if (this.paused.has(key))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    const status = this.helper.status();
    if (!status.available)
      throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
    const yielded = this.cooperation.yielded.get(key);
    const continuing =
      !!yielded &&
      yielded.appId === undefined &&
      this.lease.find(yielded.holder) !== undefined &&
      holder.cooperative === true &&
      holder.sessionGeneration === yielded.holder.sessionGeneration &&
      holder.turnId === yielded.holder.turnId;
    if (holder.scope.kind === "takeover" && !continuing)
      throw new ComputerControlError({
        _tag: "Execution",
        message: "A foreground takeover needs approval.",
      });
    if (holder.scope.kind === "app") {
      if (!this.capable() || !(this.options.backgroundAvailable?.() ?? false))
        throw new ComputerControlError({
          _tag: "ForegroundRequired",
          reason: "unsupported-in-background",
        });
    }
    if (this.cooperates(holder)) this.assertAdmission(holder);
    else {
      if (
        holder.scope.kind === "app"
          ? this.frontmostAppId === holder.scope.appId
          : this.inputIdleMs() < 1500
      )
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
      if (this.nativeWorkConflicts(holder.scope))
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
    }
    this.cooperation.continued(holder);
    const acquired = continuing
      ? this.lease.rotate(
          yielded!.holder,
          (next) => {
            if (next.scope.kind === "takeover")
              this.options.foregroundContinued?.(yielded!.holder, next);
          },
          holder,
        )
      : this.lease.acquire(holder);
    // A lease listener may reject control if the emergency shortcut cannot register.
    if (
      this.paused.has(key) ||
      !this.lease.holders().some((entry) => sameComputerHolder(entry, acquired))
    )
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    this.publishState(acquired, "active");
    return acquired;
  }
  updateGrants(authorization: ComputerAuthorization): void {
    const key = this.key(authorization);
    const previous = this.grants.get(key);
    if (
      previous?.sessionGeneration === authorization.sessionGeneration &&
      previous.grantVersion >= authorization.grantVersion
    )
      return;
    if (previous && previous.sessionGeneration !== authorization.sessionGeneration) {
      this.sharedApps.releaseOwner(key);
      this.cooperation.release((holder) => this.key(holder) === key);
      this.forgetAdmissions(
        (entry) =>
          entry.owner === key && entry.sessionGeneration !== authorization.sessionGeneration,
      );
      for (const entry of this.quarantined)
        if (entry.startsWith(`${key}\0`)) this.quarantined.delete(entry);
    }
    this.grants.set(key, authorization);
    for (const waiter of this.availabilityWaiters.values())
      if (this.key(waiter.holder) === key) waiter.cancel();
    const ended = this.endedTurns.get(key);
    if (ended && ended.sessionGeneration !== authorization.sessionGeneration)
      this.endedTurns.delete(key);
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.owner === key) this.snapshots.delete(id);
    this.cancelWhere(
      (job) => this.key(job.request.authorization) === key,
      new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" }),
    );
    // A takeover ends when its app is no longer granted control.
    for (const holder of this.lease.holders())
      if (
        this.key(holder) === key &&
        holder.scope.kind !== "foreground" &&
        !authorization.grants.some(
          (grant) =>
            grant.appId === (holder.scope as { appId: string }).appId && grant.tier !== "view",
        )
      ) {
        this.lease.release(holder);
        this.options.holderStopped?.(holder);
      }
    this.helper.control({ type: "grantsChanged", authorization });
  }
  invoke(request: ComputerAutomationRequest): Promise<unknown> {
    const { payloadHash, ...payload } = request;
    if (createHash("sha256").update(computerRequestPayload(payload)).digest("hex") !== payloadHash)
      return Promise.reject(new ComputerControlError({ _tag: "PayloadMismatch" }));
    // Replays must never return private data after a grant or session changed.
    try {
      this.validate(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = `${request.authorization.profileId}\0${request.authorization.executionGeneration}\0${request.requestId}`;
    const previous = this.admitted.get(key);
    if (previous) {
      if (previous.hash !== payloadHash)
        return Promise.reject(new ComputerControlError({ _tag: "PayloadMismatch" }));
      if (previous.promise) return previous.promise;
      if (previous.bytes !== undefined)
        return previous.error ? Promise.reject(previous.error) : Promise.resolve(previous.result);
      return Promise.reject(new ComputerControlError({ _tag: "ReplayRejected" }));
    }
    // Bound tombstone memory as well as result memory. Saturation must refuse, never evict
    // a mutation tombstone and risk executing its request ID again.
    if (this.admitted.size >= 65536)
      return Promise.reject(new ComputerControlError({ _tag: "ReplayRejected" }));
    // Reserve before queue admission, including rejected admissions.
    const admission: Admission = {
      owner: this.key(request.authorization),
      sessionGeneration: request.authorization.sessionGeneration,
      mutation: isComputerMutation(request.op),
      hash: payloadHash,
      generation: request.authorization.executionGeneration,
    };
    this.admitted.set(key, admission);
    const promise = new Promise<unknown>((resolve, reject) => {
      let cancel = () => {};
      const cancellation = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const job: Job = {
        request,
        resolve,
        reject,
        cancelled: false,
        phase: "queued",
        cancellation,
        cancel,
      };
      const mutation = isComputerMutation(request.op);
      if (
        mutation
          ? this.queuedMutations >= 32
          : this.activeObservations.size >= 2 && this.observationQueue.length >= 4
      ) {
        reject(
          new ComputerControlError({
            _tag: "Busy",
            holder: "same-profile",
            ...(!mutation ? { reason: "observation-backlog" as const } : {}),
          }),
        );
        return;
      }
      if (mutation) {
        const generation = request.authorization.executionGeneration;
        const queue = this.mutationQueues.get(generation) ?? [];
        queue.push(job);
        this.mutationQueues.set(generation, queue);
        ++this.queuedMutations;
      } else this.observationQueue.push(job);
      this.pump();
    });
    admission.promise = promise;
    void promise.then(
      (result) => this.cache(key, admission, result),
      (error: unknown) => this.cache(key, admission, undefined, error),
    );
    return promise;
  }
  private forgetAdmissions(predicate: (entry: Admission) => boolean): void {
    for (const [key, entry] of this.admitted)
      if (predicate(entry)) {
        if (entry.bytes !== undefined) {
          this.cacheBytes -= entry.bytes;
          --this.cachedCount;
        }
        this.admitted.delete(key);
      }
  }
  private cache(key: string, entry: Admission, result: unknown, error?: unknown): void {
    if (this.admitted.get(key) !== entry) return;
    entry.promise = undefined;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(result ?? error ?? null));
    } catch {
      bytes = 64;
    }
    if (bytes > 16 * 1024 * 1024) return;
    entry.result = result;
    entry.error = error;
    entry.bytes = bytes;
    this.admitted.delete(key);
    this.admitted.set(key, entry);
    this.cacheBytes += bytes;
    ++this.cachedCount;
    for (const candidate of this.admitted.values()) {
      if (this.cachedCount <= 64 && this.cacheBytes <= 32 * 1024 * 1024) break;
      if (candidate.bytes === undefined) continue;
      this.cacheBytes -= candidate.bytes;
      --this.cachedCount;
      candidate.bytes = undefined;
      candidate.result = undefined;
      candidate.error = undefined;
    }
  }
  private pump(): void {
    for (const [generation, queue] of this.mutationQueues) {
      if (this.activeMutations.has(generation)) continue;
      const next = queue[0]?.request;
      const appId = next?.delivery === "background" && "appId" in next ? next.appId : undefined;
      if (
        appId &&
        ([...this.activeMutations.values()].some(
          ({ request }) =>
            request.delivery === "background" && "appId" in request && request.appId === appId,
        ) ||
          [...this.nativeWork].some(
            (entry) =>
              entry.generation !== generation &&
              entry.scope.kind === "app" &&
              entry.scope.appId === appId,
          ))
      )
        continue;
      const job = queue.shift();
      if (!queue.length) this.mutationQueues.delete(generation);
      if (!job) continue;
      --this.queuedMutations;
      this.activeMutations.set(generation, job);
      void this.run(job).finally(() => {
        this.activeMutations.delete(generation);
        this.pump();
      });
    }
    while (this.activeObservations.size < 2) {
      const job = this.observationQueue.shift();
      if (!job) break;
      this.activeObservations.add(job);
      void this.run(job).finally(() => {
        this.activeObservations.delete(job);
        this.pump();
      });
    }
  }
  private validate(request: ComputerAutomationRequest): void {
    if (request.deadlineAtMs <= this.now())
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Request expired before execution.",
      });
    const latest = this.grants.get(this.key(request.authorization));
    if (
      !latest ||
      latest.sessionGeneration !== request.authorization.sessionGeneration ||
      latest.grantVersion !== request.authorization.grantVersion ||
      JSON.stringify(latest.grants) !== JSON.stringify(request.authorization.grants)
    )
      throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
    const status = this.helper.status();
    if (!status.available)
      throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
    if (
      this.paused.has(this.key(request.authorization)) &&
      !["status", "listApps", "resolveApps"].includes(request.op)
    )
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    const delivery = request.delivery ?? "foreground";
    if (request.op === "scroll" && "elementRef" in request && delivery !== "background")
      throw new ComputerControlError({
        _tag: "Execution",
        message:
          "Element scrolling uses background delivery; use a fresh display screenshot and coordinates for foreground scrolling.",
      });
    if (isComputerMutation(request.op)) {
      const holder = this.lease.find(request.authorization);
      if (!holder || holder.backend !== "native")
        throw new ComputerControlError({ _tag: "ReplayRejected" });
      const appId = "appId" in request ? request.appId : undefined;
      const action = request.op === "elementAction" ? request.action : undefined;
      if (this.cooperates(holder) && (holder.scope.kind === "app" || holder.cooperative)) {
        if (this.cooperation.yielded.has(this.key(holder)))
          throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
        this.assertAdmission(holder);
        this.cooperation.assertObserved(holder, request);
      }
      if (delivery === "background") {
        if (holder.scope.kind !== "app" || appId !== holder.scope.appId)
          throw new ComputerControlError({ _tag: "ReplayRejected" });
        if (this.sharedAppsAvailable()) {
          if (
            request.op === "elementAction" ||
            (request.op === "scroll" && "elementRef" in request)
          ) {
            const snapshot = this.snapshots.get(request.snapshotId);
            if (!snapshot || snapshot.owner !== this.key(holder) || snapshot.appId !== appId)
              throw new ComputerControlError({ _tag: "StaleElement" });
          }
          if (request.op === "type" || request.op === "key")
            this.sharedApps.assertTyping(
              appId,
              this.key(holder),
              this.lease
                .holders()
                .some(
                  (other) =>
                    this.key(other) !== this.key(holder) &&
                    other.scope.kind === "app" &&
                    other.scope.appId === appId,
                ),
            );
        }
        const events =
          this.backgroundEventsAvailable() &&
          computerBackgroundEventAppAllowed(appId, this.options.platform) &&
          (request.op === "scroll"
            ? "elementRef" in request
            : request.op === "key" &&
              computerBackgroundKeyAllowed(request.chords, this.options.platform));
        if (!computerScopeAllows(holder.scope, delivery, request.op, appId, action, { events }))
          throw new ComputerControlError({
            _tag: "ForegroundRequired",
            reason: "unsupported-in-background",
          });
        // Another chat's takeover owns the foreground; observations stay available.
        if (
          this.takeoverDraining ||
          (this.lease.takeover() && this.key(this.lease.takeover()!) !== this.key(holder))
        )
          throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
        if (this.quarantined.has(`${this.key(holder)}\0${holder.scope.appId}`))
          throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      } else {
        if (holder.scope.kind === "app")
          throw new ComputerControlError({
            _tag: "ForegroundRequired",
            reason: "unsupported-in-background",
          });
        if (holder.scope.kind === "takeover") {
          if (!(this.options.takeoverValid?.(holder) ?? false))
            throw new ComputerControlError({ _tag: "ReplayRejected" });
          if (!computerScopeAllows(holder.scope, delivery, request.op, appId))
            throw new ComputerControlError({ _tag: "TargetBlocked", kind: "other-app" });
        }
        if (!holder.cooperative && this.now() - this.physicalInputAt < 1500) {
          this.stopThread(holder, "user-input");
          throw new ComputerControlError({ _tag: "Interrupted", cause: "user-input" });
        }
      }
    }
    if ("geometryGeneration" in request) {
      const display = status.displays?.find((entry) => entry.displayId === request.displayId);
      if (!display || display.geometryGeneration !== request.geometryGeneration)
        throw new ComputerControlError({ _tag: "GeometryChanged" });
      if (request.op === "drag") {
        computerModelToNative(display, request.from.x, request.from.y, this.options.platform);
        computerModelToNative(display, request.to.x, request.to.y, this.options.platform);
      } else computerModelToNative(display, request.x, request.y, this.options.platform);
    }
  }
  private async run(job: Job): Promise<void> {
    const { request } = job;
    const mutation = isComputerMutation(request.op);
    const background = request.delivery === "background";
    const holder =
      this.lease.find(request.authorization) ??
      this.controlled.get(this.key(request.authorization));
    const observedApp = background && "appId" in request ? request.appId : undefined;
    const observationSequence = holder
      ? this.cooperation.observationSequence(holder, observedApp)
      : 0;
    try {
      this.validate(request);
      if (job.cancelled) return;
      if (mutation) {
        // Background work never draws on the user's screen or delays for an animation.
        if (!background) {
          const status = this.helper.status();
          const snapshot =
            request.op === "elementAction" ? this.snapshots.get(request.snapshotId) : undefined;
          const node =
            snapshot?.owner === this.key(request.authorization) &&
            request.op === "elementAction" &&
            snapshot.appId === request.appId
              ? snapshot.result.nodes.find((node) => node.elementRef === request.elementRef)
              : undefined;
          const target: ComputerOverlayTarget = {
            ...("appId" in request && request.appId && this.appNames.has(request.appId)
              ? { appName: this.appNames.get(request.appId)! }
              : {}),
            ...(node?.displayId ? { displayId: node.displayId } : {}),
            ...(node?.bounds ? { bounds: node.bounds } : {}),
          };
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.overlay.action(request, status.available ? (status.displays ?? []) : [], target),
              job.cancellation,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 280);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          this.validate(request);
          if (job.cancelled) return;
        }
        this.options.activity(request.authorization.profileId, {
          threadId: request.authorization.threadId,
          requestId: request.requestId,
          sessionGeneration: request.authorization.sessionGeneration,
          backend: "native",
          op: request.op,
          status: "started",
          ...(background ? { delivery: "background" as const } : {}),
        });
      }
      let nativeRequest = request;
      const observing = ["inspect", "screenshot", "zoom"].includes(request.op);
      let observationEpoch: number | undefined;
      if (holder && this.cooperates(holder) && (mutation || observing)) {
        const ready = await this.cooperation.refresh(
          holder,
          background && "appId" in request ? request.appId : undefined,
        );
        if (mutation) {
          this.validate(request);
          const {
            activityEpoch: _untrustedEpoch,
            inputSequence: _untrustedSequence,
            ...base
          } = request;
          nativeRequest = {
            ...base,
            ...(background
              ? { activityEpoch: ready.activityEpoch }
              : { inputSequence: ready.inputSequence }),
          };
        }
        observationEpoch = background ? ready.activityEpoch : ready.inputSequence;
      }
      if (job.cancelled) return;
      job.phase = "sent";
      const native = this.helper.request(nativeRequest, {
        f5Pids: this.options.f5Pids(),
        f5BundlePath: this.options.f5BundlePath,
        overlayWindowIds: this.overlay.windowIds(),
      });
      this.trackNative(request, native);
      const result = await Promise.race([native, job.cancellation]);
      if (job.cancelled) return;
      if (
        observing &&
        holder &&
        observationEpoch !== undefined &&
        !this.cooperation.observed(
          holder,
          observedApp,
          request.op === "screenshot",
          observationEpoch,
          observationSequence,
        )
      )
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
      job.phase = "terminal";
      this.confirmed.delete(request.requestId);
      const limit =
        request.op === "inspect"
          ? 512 * 1024
          : request.op === "screenshot" || request.op === "zoom" || request.screenshot
            ? 16 * 1024 * 1024
            : 64 * 1024;
      if (Buffer.byteLength(JSON.stringify(result)) > limit)
        throw new ComputerControlError({ _tag: "ResultTooLarge" });
      if ((request.op === "listApps" || request.op === "resolveApps") && Array.isArray(result)) {
        for (const app of result)
          if (app && typeof app.appId === "string" && typeof app.name === "string")
            this.appNames.set(app.appId, app.name.slice(0, 200));
      }
      if (request.op === "inspect" && result && typeof result === "object") {
        const tree = result as ComputerInspectResult;
        if (typeof tree.snapshotId === "string" && Array.isArray(tree.nodes)) {
          this.snapshots.set(tree.snapshotId, {
            owner: this.key(request.authorization),
            appId: request.appId,
            result: tree,
          });
          const matches = [...this.snapshots.entries()].filter(
            ([, snapshot]) =>
              snapshot.owner === this.key(request.authorization) &&
              snapshot.appId === request.appId,
          );
          for (const [id] of matches.slice(0, -4)) this.snapshots.delete(id);
        }
      }
      if (mutation) {
        const holder = this.lease.find(request.authorization);
        if (holder) this.lease.touch(holder);
        const action =
          result !== null && typeof result === "object"
            ? (result as {
                frontmostApp?: { name?: unknown };
                target?: { appId?: unknown };
                waiting?: unknown;
                screenshot?: ComputerScreenshot;
              })
            : undefined;
        if (
          holder &&
          action?.waiting === "secure-input" &&
          !this.cooperation.yielded.has(this.key(holder))
        )
          this.publishState(holder, "active");
        // Attribute to the app the action targeted, never to whatever happens to be frontmost.
        const targetApp =
          typeof action?.target?.appId === "string" ? action.target.appId : undefined;
        const appName = targetApp
          ? this.appNames.get(targetApp)
          : typeof action?.frontmostApp?.name === "string"
            ? action.frontmostApp.name.slice(0, 200)
            : undefined;
        let thumbnailDataUrl: string | undefined;
        try {
          if (action?.screenshot) thumbnailDataUrl = this.options.thumbnail?.(action.screenshot);
        } catch {
          /* A thumbnail failure cannot change the outcome of an OS action. */
        }
        this.options.activity(request.authorization.profileId, {
          threadId: request.authorization.threadId,
          requestId: request.requestId,
          sessionGeneration: request.authorization.sessionGeneration,
          backend: "native",
          op: request.op,
          status: "completed",
          ...(appName ? { appName } : {}),
          ...(background ? { delivery: "background" as const } : {}),
          ...(thumbnailDataUrl && Buffer.byteLength(thumbnailDataUrl) <= 40 * 1024
            ? { thumbnailDataUrl }
            : {}),
        });
      }
      job.resolve(result);
    } catch (cause) {
      let error = cause;
      const sent = job.phase === "sent";
      job.phase = "terminal";
      if (mutation && sent && holder && this.cooperates(holder)) {
        const failure = computerError(error);
        if (failure._tag === "Interrupted" && failure.actionStarted === true)
          error = new ComputerControlError({ _tag: "OutcomeUnknown" });
      }
      const unknown = mutation && sent && computerError(error)._tag === "OutcomeUnknown";
      // A confirmed action keeps its success even when its reply was lost afterwards.
      if (mutation && sent && this.confirmed.delete(request.requestId)) {
        job.resolve(this.completedWithoutCapture(request));
        return;
      }
      const failure = computerError(error);
      const cooperativeMutation =
        mutation && sent && holder && this.cooperates(holder) && (background || holder.cooperative);
      if (
        cooperativeMutation &&
        failure._tag === "Interrupted" &&
        failure.actionStarted === false &&
        !this.paused.has(this.key(holder))
      ) {
        if (failure.cause === "user-input") this.yieldHolder(holder);
        else if (
          failure.cause === "permit-expired" &&
          !this.cooperation.yielded.has(this.key(holder))
        )
          this.stopThread(holder, "permit-expired");
      }
      const contention =
        mutation &&
        sent &&
        holder &&
        this.cooperates(holder) &&
        (background || holder.cooperative) &&
        failure._tag === "Interrupted" &&
        (failure.cause === "user-input" ||
          (failure.cause === "permit-expired" && this.cooperation.yielded.has(this.key(holder)))) &&
        failure.actionStarted === false;
      job.reject(
        contention
          ? new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" })
          : error,
      );
      if (unknown && !job.cancelled) this.recordUnknown(request);
      if (mutation && !job.cancelled) {
        this.options.activity(request.authorization.profileId, {
          threadId: request.authorization.threadId,
          requestId: request.requestId,
          sessionGeneration: request.authorization.sessionGeneration,
          backend: "native",
          op: request.op,
          status: "failed",
          ...(background ? { delivery: "background" as const } : {}),
        });
        if (background) this.backgroundFailure(request, error);
      }
    }
  }
  /** Unknown outcomes quarantine the target; activation side effects pause the thread. */
  private backgroundFailure(request: ComputerAutomationRequest, cause: unknown): void {
    const error = computerError(cause);
    const holder = this.lease.find(request.authorization);
    // OutcomeUnknown is recorded by run() for every delivery.
    if (holder && error._tag === "ForegroundRequired" && error.reason === "activation-side-effect")
      this.stopThread(holder, "activation");
  }
  private cancelWhere(predicate: (job: Job) => boolean, error: ComputerControlError): void {
    const unknown: ComputerAutomationRequest[] = [];
    const interrupt = (job: Job) => {
      if (job.cancelled) return;
      job.cancelled = true;
      job.cancel();
      const sentMutation = job.phase === "sent" && isComputerMutation(job.request.op);
      // The helper confirmed the OS action; only the optional capture is being abandoned.
      if (sentMutation && this.confirmed.delete(job.request.requestId))
        job.resolve(this.completedWithoutCapture(job.request));
      else if (sentMutation) {
        // A request the helper may already have performed is unknown, never "interrupted",
        // and its thread enters recovery like any other unknown outcome.
        job.reject(new ComputerControlError({ _tag: "OutcomeUnknown" }));
        unknown.push(job.request);
      } else job.reject(error);
      if (isComputerMutation(job.request.op))
        this.options.activity(job.request.authorization.profileId, {
          threadId: job.request.authorization.threadId,
          requestId: job.request.requestId,
          sessionGeneration: job.request.authorization.sessionGeneration,
          backend: "native",
          op: job.request.op,
          status: "interrupted",
        });
    };
    for (const [generation, queue] of this.mutationQueues) {
      for (let index = queue.length - 1; index >= 0; --index) {
        const job = queue[index]!;
        if (predicate(job)) {
          queue.splice(index, 1);
          --this.queuedMutations;
          interrupt(job);
        }
      }
      if (!queue.length) this.mutationQueues.delete(generation);
    }
    for (let index = this.observationQueue.length - 1; index >= 0; --index) {
      const job = this.observationQueue[index]!;
      if (predicate(job)) {
        this.observationQueue.splice(index, 1);
        interrupt(job);
      }
    }
    for (const job of [...this.activeMutations.values(), ...this.activeObservations])
      if (predicate(job)) {
        if (job.cancelled) continue;
        this.helper.control({ type: "cancel", requestId: job.request.requestId });
        interrupt(job);
      }
    for (const request of unknown) this.recordUnknown(request);
  }
  cancel(requestId: string, profileId: string): void {
    this.cancelAdmission(profileId, requestId);
    const waiter = this.availabilityWaiters.get(profileId + "\0" + requestId);
    if (waiter?.holder.profileId === profileId) waiter.cancel();
    this.cancelWhere(
      (job) =>
        job.request.requestId === requestId && job.request.authorization.profileId === profileId,
      new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }),
    );
  }
  /**
   * Prepare a takeover: refuse new background mutations from other threads and wait for their
   * in-flight ones to finish (drain, not revoke). Returns a release function.
   */
  async drainBackground(exceptKey: string, timeoutMs = 5000): Promise<() => void> {
    this.takeoverDraining = true;
    const release = () => {
      this.takeoverDraining = false;
    };
    const deadline = this.now() + timeoutMs;
    const pending = () =>
      [...this.activeMutations.values()].filter(
        (job) =>
          job.request.delivery === "background" &&
          this.key(job.request.authorization) !== exceptKey,
      );
    try {
      if (this.capable())
        await Promise.all(
          pending().map((job) =>
            this.helper.drain?.(job.request.authorization.executionGeneration, timeoutMs),
          ),
        );
      while (pending().length && this.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      // Cancelled or released work the helper has not finished also blocks the takeover.
      const drained = await this.awaitNative(() => true, Math.max(0, deadline - this.now()));
      if (pending().length || !drained) {
        release();
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
      }
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }
  /** Policy transition for one thread: cancel, revoke holders and await their drain. */
  async invalidateThread(profileId: string, threadId: string, revision: number): Promise<void> {
    const key = this.key({ profileId, threadId });
    this.admission.cancel(
      (entry) => this.key(entry.holder) === key,
      new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" }),
    );
    this.cooperation.release((holder) => this.key(holder) === key);
    for (const waiter of this.availabilityWaiters.values())
      if (this.key(waiter.holder) === key) waiter.cancel();
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.owner === key) this.snapshots.delete(id);
    this.cancelWhere(
      (job) => this.key(job.request.authorization) === key,
      new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" }),
    );
    const stale = this.lease
      .holders()
      .filter((holder) => this.key(holder) === key && holder.policyRevision < revision);
    for (const holder of stale) {
      this.lease.release(holder);
      this.options.holderStopped?.(holder);
    }
    // The backend may already have released these holders; drain by the work itself, so the
    // transition completes only once the helper has finished this thread's mutations.
    const generations = new Set([
      ...stale.map((holder) => holder.executionGeneration),
      ...[...this.nativeWork].filter((entry) => entry.key === key).map((entry) => entry.generation),
    ]);
    // A stuck generation reports foreground-busy; the remaining wait below decides the result.
    if (this.capable())
      await Promise.all(
        [...generations].map((generation) =>
          this.helper.drain?.(generation, 5000).catch(() => undefined),
        ),
      );
    if (!(await this.awaitNative((entry) => entry.key === key, 5500)))
      throw new ComputerControlError({ _tag: "OutcomeUnknown" });
  }
  disconnect(profileId: string): void {
    this.admission.cancel((entry) => entry.profileId === profileId);
    for (const key of this.endedTurns.keys())
      if (key.startsWith(profileId + "\0")) this.endedTurns.delete(key);
    for (const waiter of this.availabilityWaiters.values())
      if (waiter.holder.profileId === profileId) waiter.cancel();
    for (const entry of this.cooperation.yielded.values())
      if (entry.holder.profileId === profileId) this.stopThread(entry.holder, "paused");
    this.cooperation.release((holder) => holder.profileId === profileId);
    this.cancelWhere(
      (job) => job.request.authorization.profileId === profileId,
      new ComputerControlError({ _tag: "OutcomeUnknown" }),
    );
    for (const holder of this.lease.holders())
      if (holder.profileId === profileId) this.stopThread(holder, "paused");
    if (this.lease.pendingTakeover()?.holder.profileId === profileId) this.lease.cancelTakeover();
    this.forgetAdmissions((entry) => entry.owner.startsWith(`${profileId}\0`));
    for (const [key, auth] of this.grants)
      if (auth.profileId === profileId) {
        this.sharedApps.releaseOwner(key);
        this.grants.delete(key);
        this.paused.delete(key);
        this.pauseCauses.delete(key);
        this.controlled.delete(key);
      }
    for (const entry of this.quarantined)
      if (entry.startsWith(`${profileId}\0`)) this.quarantined.delete(entry);
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.owner.startsWith(`${profileId}\0`)) this.snapshots.delete(id);
  }
  private publishState(
    holder: ComputerLeaseHolder,
    state: ComputerExecutionState | null,
    pauseCause?: ComputerPauseCause,
  ): void {
    this.options.executionState?.(holder.profileId, {
      threadId: holder.threadId,
      sessionGeneration: holder.sessionGeneration,
      state,
      delivery: computerScopeDelivery(holder.scope),
      ...(holder.scope.kind !== "foreground" ? { appId: holder.scope.appId } : {}),
      ...(pauseCause ? { pauseCause } : {}),
    });
  }
  /** Stop one thread's generation; other threads' background work keeps running. */
  stopThread(holder: ComputerLeaseHolder, cause: ComputerPauseCause = "paused"): void {
    const key = this.key(holder);
    this.sharedApps.releaseOwner(key);
    this.admission.cancel(
      (entry) => this.key(entry.holder) === key,
      new ComputerControlError({ _tag: "Interrupted", cause: STOP_CAUSE[cause] }),
    );
    this.cooperation.release((entry) => this.key(entry) === key);
    for (const waiter of this.availabilityWaiters.values())
      if (this.key(waiter.holder) === key) waiter.cancel();
    const capable = this.capable();
    const owned = this.lease.holders().filter((entry) => this.key(entry) === key);
    this.controlled.set(key, owned[0] ?? holder);
    for (const entry of owned)
      this.helper.control(
        capable
          ? { type: "suspend", executionGeneration: entry.executionGeneration }
          : { type: "suspend" },
      );
    const wasPaused = this.paused.has(key);
    this.paused.add(key);
    this.pauseCauses.set(key, cause);
    if (!wasPaused || cause === "kill-switch") this.options.paused(holder, cause);
    this.publishState(holder, cause === "outcome-unknown" ? "recovery" : "paused", cause);
    this.cancelWhere(
      (job) => this.key(job.request.authorization) === key,
      new ComputerControlError({ _tag: "Interrupted", cause: STOP_CAUSE[cause] }),
    );
    if (holder.scope.kind === "app" && cause === "outcome-unknown")
      for (const [id, snapshot] of this.snapshots)
        if (snapshot.owner === key) this.snapshots.delete(id);
    const held = owned.length > 0;
    if (held) {
      this.recentlyStopped = [
        ...this.recentlyStopped.filter((entry) => this.key(entry.holder) !== key),
        ...owned.map((entry) => ({ holder: entry, at: this.now() })),
      ].slice(-16);
      this.lease.invalidate((entry) => this.key(entry) === key);
      for (const entry of owned) this.options.holderStopped?.(entry);
      for (const entry of owned)
        void this.helper.suspend(capable ? entry.executionGeneration : undefined);
    }
    const pending = this.lease.pendingTakeover();
    if (pending && this.key(pending.holder) === key) this.lease.cancelTakeover(pending);
    // Without per-generation control a legacy helper suspends everything.
    if (!capable)
      for (const other of this.lease.holders())
        if (this.key(other) !== key) this.stopThread(other, cause);
  }
  stop(cause: ComputerPauseCause = "paused"): void {
    const active = [...this.lease.holders()];
    const pending = this.lease.pendingTakeover()?.holder;
    if (pending && !active.some((holder) => this.key(holder) === this.key(pending)))
      active.push(pending);
    for (const holder of this.admission.holders())
      if (!active.some((entry) => this.key(entry) === this.key(holder))) active.push(holder);
    this.admission.cancel(() => true);
    for (const { holder } of this.cooperation.yielded.values())
      if (!active.some((entry) => this.key(entry) === this.key(holder))) active.push(holder);
    for (const { holder } of this.availabilityWaiters.values())
      if (!active.some((entry) => this.key(entry) === this.key(holder))) active.push(holder);
    for (const waiter of this.availabilityWaiters.values()) waiter.cancel();
    // The chord's first physical modifier already pauses foreground input; its final key must
    // still interrupt those exact turns after main has released their leases.
    const stopped =
      cause === "kill-switch"
        ? this.recentlyStopped
            .filter((entry) => this.now() - entry.at <= 5000)
            .map((entry) => entry.holder)
            .filter((holder) => !active.some((entry) => this.key(entry) === this.key(holder)))
        : [];
    if (active.length) {
      this.recentlyStopped = [
        ...this.recentlyStopped,
        ...active.map((holder) => ({ holder, at: this.now() })),
      ].slice(-16);
    }
    this.helper.control({ type: "suspend" });
    this.cooperation.reset();
    for (const holder of [...active, ...stopped]) {
      const key = this.key(holder);
      this.sharedApps.releaseOwner(key);
      this.controlled.set(key, holder);
      this.paused.add(key);
      this.pauseCauses.set(key, cause);
      this.options.paused(holder, cause);
      this.publishState(holder, "paused", cause);
      this.options.holderStopped?.(holder);
    }
    this.cancelWhere(
      () => true,
      new ComputerControlError({ _tag: "Interrupted", cause: STOP_CAUSE[cause] }),
    );
    this.lease.invalidate();
    this.lease.cancelTakeover();
    this.overlay.clear();
    this.overlayHolder = undefined;
    if (cause === "kill-switch") this.recentlyStopped = [];
    if (active.length) void this.helper.suspend();
  }
  resumeTarget(profileId: string, threadId: string) {
    const key = this.key({ profileId, threadId });
    return {
      title: this.controlled.get(key)?.threadTitle ?? threadId,
      authorization: this.grants.get(key),
      pauseCause: this.pauseCauses.get(key),
      recovery: [...this.quarantined].some((entry) => entry.startsWith(`${key}\0`)),
    };
  }
  requiresLocalResume(profileId: string, threadId: string): boolean {
    const key = this.key({ profileId, threadId });
    return (
      (this.paused.has(key) && this.controlled.has(key)) ||
      this.lease.holders().some((holder) => this.key(holder) === key)
    );
  }
  setPaused(profileId: string, threadId: string, paused: boolean): void {
    const key = this.key({ profileId, threadId });
    if (paused) {
      const pending = this.lease.pendingTakeover()?.holder;
      if (pending && this.key(pending) === key) this.stopThread(pending, "paused");
      for (const holder of this.admission.holders())
        if (this.key(holder) === key) this.stopThread(holder, "paused");
      const yielded = this.cooperation.yielded.get(key);
      if (yielded) this.stopThread(yielded.holder, "paused");
      for (const holder of this.lease.holders())
        if (this.key(holder) === key) this.stopThread(holder, "paused");
      this.paused.add(key);
      this.pauseCauses.set(key, "paused");
    } else {
      if (this.paused.has(key) && this.controlled.has(key) && !this.helper.status().available)
        throw new ComputerControlError({ _tag: "Unavailable", reason: "monitor-unhealthy" });
      const holder = this.controlled.get(key);
      // Resuming while the user is still in the background target would pause it again.
      if (
        holder?.scope.kind === "app" &&
        this.pauseCauses.get(key) === "target-active" &&
        this.frontmostAppId === holder.scope.appId
      )
        throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
      // Resume is the local acknowledgement of an unknown outcome; observations restart fresh.
      for (const entry of this.quarantined)
        if (entry.startsWith(`${key}\0`)) this.quarantined.delete(entry);
      for (const [id, snapshot] of this.snapshots)
        if (snapshot.owner === key) this.snapshots.delete(id);
      this.paused.delete(key);
      this.pauseCauses.delete(key);
      if (holder)
        this.options.executionState?.(holder.profileId, {
          threadId: holder.threadId,
          sessionGeneration: holder.sessionGeneration,
          state: null,
        });
    }
  }
  close(): void {
    clearInterval(this.permitTimer);
    this.offEvent();
    this.offLease();
    this.stop();
    this.admission.close();
    this.forgetAdmissions(() => true);
    this.grants.clear();
    this.controlled.clear();
    this.paused.clear();
    this.pauseCauses.clear();
    this.quarantined.clear();
    this.snapshots.clear();
    this.sharedApps.reset();
    this.appNames.clear();
    this.permitted.clear();
    this.nativeWork.clear();
    this.confirmed.clear();
    this.cooperation.reset();
    this.availabilityWaiters.clear();
    this.availabilityListeners.clear();
    this.endedTurns.clear();
    this.recentlyStopped = [];
  }
}
