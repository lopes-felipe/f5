import {
  COMPUTER_COOPERATION_CAPABILITY,
  type ComputerAutomationRequest,
  type ComputerLeaseHolder,
  type ComputerTargetReadiness,
  type ComputerUserActiveDetail,
} from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerHelper } from "./ComputerHelperClient";

/**
 * A non-cooperative foreground takeover arms only after this long without physical input.
 * Cooperative takeovers use the foreground admission dwell from `blockedDetail` instead.
 */
export const COMPUTER_TAKEOVER_IDLE_MS = 1500;
export const computerThreadKey = (holder: Pick<ComputerLeaseHolder, "profileId" | "threadId">) =>
  holder.profileId + "\0" + holder.threadId;
const ownerKey = (holder: ComputerLeaseHolder) =>
  computerThreadKey(holder) + "\0" + holder.sessionGeneration + "\0" + holder.turnId;
const scopeKey = (holder: ComputerLeaseHolder, appId?: string) =>
  ownerKey(holder) + "\0" + JSON.stringify(appId ?? null);
const sampleKey = (appId?: string) => JSON.stringify(appId ?? null);
type Sample = { ready: ComputerTargetReadiness; at: number };
export interface YieldedComputerTarget {
  holder: ComputerLeaseHolder;
  appId?: string;
  at: number;
  dwell: number;
}
interface Observation {
  sequence: number;
  epoch?: number;
  screenshotEpoch?: number;
}

/** Observe-only watches and bounded yield state. No method grants access or arms a permit. */
export class ComputerCooperation {
  readonly yielded = new Map<string, YieldedComputerTarget>();
  private readonly watches = new Map<string, Set<string>>();
  private readonly owners = new Map<string, ComputerLeaseHolder>();
  private readonly samples = new Map<string, Sample>();
  private readonly observations = new Map<string, Observation>();
  private readonly backoff = new Map<string, { at: number; dwell: number }>();
  private readonly registering = new Map<string, Promise<void>>();
  private readonly refreshing = new Map<string, Promise<ComputerTargetReadiness>>();
  private sequence = 0;
  private incarnation = 0;
  constructor(
    private readonly helper: ComputerHelper,
    private readonly now: () => number,
  ) {}
  supported(): boolean {
    return (
      !!this.helper.watch &&
      !!this.helper.availability &&
      !!this.helper.capabilities?.().includes(COMPUTER_COOPERATION_CAPABILITY)
    );
  }
  private app(holder: ComputerLeaseHolder): string | undefined {
    return holder.scope.kind === "app" ? holder.scope.appId : undefined;
  }
  async prepare(holder: ComputerLeaseHolder, appId = this.app(holder)): Promise<void> {
    if (!this.supported()) return;
    this.owners.set(ownerKey(holder), holder);
    if (appId === undefined) {
      await this.refresh(holder);
      return;
    }
    const owner = ownerKey(holder);
    const key = JSON.stringify([appId, owner]);
    const pending = this.registering.get(key);
    if (pending) return pending;
    if (this.watches.get(appId)?.has(owner)) {
      await this.refresh(holder, appId);
      return;
    }
    if (!this.watches.has(appId) && this.watches.size >= 32)
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Computer target watch limit reached.",
      });
    const owners = this.watches.get(appId) ?? new Set<string>();
    this.watches.set(appId, owners);
    owners.add(owner);
    const incarnation = this.incarnation;
    const task = this.helper.watch!(appId, owner)
      .then(
        (ready) => {
          // A turn can close while native registration is in flight.
          if (incarnation !== this.incarnation || !this.watches.get(appId)?.has(owner)) {
            if (incarnation === this.incarnation)
              this.helper.control({ type: "watchRelease", appId, owner });
            throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
          }
          this.samples.set(sampleKey(appId), { ready, at: this.now() });
        },
        (error: unknown) => {
          owners.delete(owner);
          if (!owners.size && this.watches.get(appId) === owners) this.watches.delete(appId);
          throw error;
        },
      )
      .finally(() => {
        if (this.registering.get(key) === task) this.registering.delete(key);
      });
    this.registering.set(key, task);
    return task;
  }
  async refresh(
    holder: ComputerLeaseHolder,
    appId = this.app(holder),
  ): Promise<ComputerTargetReadiness> {
    if (!this.supported())
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Update F5 to wait for a computer target.",
      });
    if (appId && !this.watches.get(appId)?.has(ownerKey(holder))) {
      await this.prepare(holder, appId);
      return this.samples.get(sampleKey(appId))!.ready;
    }
    const key = sampleKey(appId);
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const incarnation = this.incarnation;
    const task = this.helper.availability!(appId)
      .then((ready) => {
        if (incarnation !== this.incarnation)
          throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
        this.samples.set(key, { ready, at: this.now() });
        return ready;
      })
      .finally(() => {
        if (this.refreshing.get(key) === task) this.refreshing.delete(key);
      });
    this.refreshing.set(key, task);
    return task;
  }
  blocked(holder: ComputerLeaseHolder, appId = this.app(holder)): boolean {
    return this.blockedDetail(holder, appId) !== undefined;
  }
  /**
   * Why `blocked` holds, or undefined when the target is free. Admission and foreground
   * takeovers share this, so a takeover never arms into an action admission still refuses.
   */
  blockedDetail(
    holder: ComputerLeaseHolder,
    appId = this.app(holder),
  ): ComputerUserActiveDetail | undefined {
    const sample = this.samples.get(sampleKey(appId));
    if (!sample || !sample.ready.monitorHealthy) return "monitor-unhealthy";
    if (!appId && sample.ready.inputHeld) return "input-held";
    if (appId && sample.ready.frontmost) return "recent-input";
    const yielded = this.yielded.get(computerThreadKey(holder));
    const dwell = yielded && yielded.appId === appId ? yielded.dwell : appId ? 1500 : 3000;
    const age = appId ? sample.ready.lastActivityAgeMs : sample.ready.lastUserInputAgeMs;
    return age >= 0 && age + this.now() - sample.at < dwell ? "recent-input" : undefined;
  }
  readiness(
    holder: ComputerLeaseHolder,
    appId = this.app(holder),
  ): ComputerTargetReadiness | undefined {
    return this.samples.get(sampleKey(appId))?.ready;
  }
  /** The cached readiness sample and when it was taken, without a native call. */
  sample(appId?: string): Readonly<Sample> | undefined {
    return this.samples.get(sampleKey(appId));
  }
  yield(holder: ComputerLeaseHolder): YieldedComputerTarget {
    const appId = this.app(holder);
    const key = scopeKey(holder, appId);
    const previous = this.backoff.get(key);
    const now = this.now();
    const dwell =
      previous && now - previous.at < 60_000
        ? Math.min(15_000, previous.dwell * 2)
        : appId
          ? 1500
          : 3000;
    this.backoff.delete(key);
    this.backoff.set(key, { at: now, dwell });
    if (this.backoff.size > 256) this.backoff.delete(this.backoff.keys().next().value!);
    this.observations.set(key, { sequence: ++this.sequence });
    const entry = { holder, ...(appId ? { appId } : {}), at: now, dwell };
    this.samples.delete(sampleKey(appId));
    this.yielded.set(computerThreadKey(holder), entry);
    return entry;
  }
  observationSequence(holder: ComputerLeaseHolder, appId?: string): number {
    return this.observations.get(scopeKey(holder, appId))?.sequence ?? 0;
  }
  observed(
    holder: ComputerLeaseHolder,
    appId: string | undefined,
    screenshot: boolean,
    epoch: number,
    sequence: number,
  ): boolean {
    const requirement = this.observations.get(scopeKey(holder, appId));
    if (!requirement) return sequence === 0;
    if (requirement.sequence !== sequence) return false;
    requirement.epoch = epoch;
    if (screenshot) requirement.screenshotEpoch = epoch;
    return true;
  }
  assertObserved(holder: ComputerLeaseHolder, request: ComputerAutomationRequest): void {
    const appId = this.app(holder);
    const requirement = this.observations.get(scopeKey(holder, appId));
    if (!requirement) return;
    const ready = this.readiness(holder);
    const coordinates = ["click", "move", "drag", "scroll"].includes(request.op);
    const expected = coordinates && !appId ? requirement.screenshotEpoch : requirement.epoch;
    const current = appId ? ready?.activityEpoch : ready?.inputSequence;
    if (expected === undefined || expected !== current)
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
  }
  continued(holder: ComputerLeaseHolder): void {
    this.yielded.delete(computerThreadKey(holder));
  }
  heartbeat(message: Record<string, unknown>): void {
    if (typeof message.inputSequence !== "number" || typeof message.inputHeld !== "boolean") return;
    this.samples.set(sampleKey(), {
      at: this.now(),
      ready: {
        activityEpoch: message.inputSequence,
        inputSequence: message.inputSequence,
        lastActivityAgeMs:
          typeof message.lastUserInputAgeMs === "number" ? message.lastUserInputAgeMs : -1,
        lastUserInputAgeMs:
          typeof message.lastUserInputAgeMs === "number" ? message.lastUserInputAgeMs : -1,
        monitorHealthy: message.monitorHealthy === true,
        frontmost: false,
        inputHeld: message.inputHeld,
      },
    });
    const global = this.samples.get(sampleKey())!;
    if (Array.isArray(message.targets))
      for (const target of message.targets) {
        if (
          !target ||
          typeof target.appId !== "string" ||
          !this.watches.has(target.appId) ||
          !Number.isSafeInteger(target.activityEpoch) ||
          target.activityEpoch < 0 ||
          typeof target.lastActivityAgeMs !== "number" ||
          !Number.isFinite(target.lastActivityAgeMs) ||
          typeof target.frontmost !== "boolean"
        )
          continue;
        this.samples.set(sampleKey(target.appId), {
          at: global.at,
          ready: {
            ...global.ready,
            activityEpoch: target.activityEpoch,
            lastActivityAgeMs: target.lastActivityAgeMs,
            frontmost: target.frontmost,
          },
        });
      }
  }
  release(predicate: (holder: ComputerLeaseHolder) => boolean): void {
    const owners = new Set<string>();
    for (const [owner, holder] of this.owners)
      if (predicate(holder)) {
        owners.add(owner);
        this.owners.delete(owner);
      }
    for (const [appId, registered] of this.watches)
      for (const owner of owners)
        if (registered.delete(owner)) {
          this.helper.control({ type: "watchRelease", appId, owner });
          if (!registered.size) {
            this.watches.delete(appId);
            this.samples.delete(sampleKey(appId));
          }
        }
    for (const [key, entry] of this.yielded) if (predicate(entry.holder)) this.yielded.delete(key);
    for (const map of [this.observations, this.backoff])
      for (const key of map.keys())
        if ([...owners].some((owner) => key.startsWith(owner + "\0"))) map.delete(key);
  }
  reset(): void {
    this.incarnation++;
    this.release(() => true);
    this.registering.clear();
    this.refreshing.clear();
    this.samples.clear();
    this.observations.clear();
    this.backoff.clear();
  }
}
