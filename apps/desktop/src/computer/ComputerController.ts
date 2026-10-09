import { createHash } from "node:crypto";
import type {
  ComputerAutomationRequest,
  ComputerAuthorization,
  ComputerDisplay,
  ComputerLeaseHolder,
  ComputerActivity,
  ComputerScreenshot,
  ComputerInspectResult,
} from "@t3tools/contracts";
import {
  ComputerControlError,
  computerRequestPayload,
  isComputerMutation,
} from "@t3tools/shared/computerControl";
import { computerModelToNative } from "@t3tools/shared/computerGeometry";
import { ComputerLeaseAuthority, sameComputerHolder } from "./ComputerLeaseAuthority";
import type { ComputerHelper } from "./ComputerHelperClient";

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
}
export interface ComputerOverlayTarget {
  appName?: string;
  displayId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}
export class ComputerController {
  private readonly paused = new Set<string>();
  private readonly grants = new Map<string, ComputerAuthorization>();
  private readonly admitted = new Map<string, Admission>();
  private cacheBytes = 0;
  private cachedCount = 0;
  private readonly mutationQueue: Job[] = [];
  private readonly observationQueue: Job[] = [];
  private activeMutation: Job | undefined;
  private readonly activeObservations = new Set<Job>();
  private physicalInputAt = -Infinity;
  private recentlyStopped: { holder: ComputerLeaseHolder } | undefined;
  private readonly appNames = new Map<string, string>();
  private readonly snapshots = new Map<
    string,
    { owner: string; appId: string; result: ComputerInspectResult }
  >();
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
      paused: (
        holder: ComputerLeaseHolder,
        cause: "paused" | "kill-switch" | "user-input" | "permit-expired",
      ) => void;
      now?: () => number;
    },
  ) {
    this.offEvent = helper.onEvent((message) => {
      if (message.type === "physicalInput" || message.type === "killSwitch") {
        if (message.type === "physicalInput") this.physicalInputAt = this.now();
        this.stop(message.type === "killSwitch" ? "kill-switch" : "user-input");
      } else if (message.type === "hello") {
        // A replacement helper starts suspended and has no remembered authorization.
        for (const authorization of this.grants.values())
          helper.control({ type: "grantsChanged", authorization });
      } else if (message.type === "status" && !helper.status().available && lease.current())
        this.stop("paused");
      else if (
        message.type === "permitExpired" &&
        message.executionGeneration === lease.current()?.executionGeneration
      )
        this.stop("permit-expired");
    });
    this.offLease = lease.subscribe((holder) => {
      this.helper.control({ type: "suspend" });
      this.overlay.clear();
      if (holder) {
        this.forgetAdmissions((entry) => entry.generation < holder.executionGeneration);
        this.overlay.show(holder);
        this.helper.control({
          type: "permit",
          executionGeneration: holder.executionGeneration,
          expiresInMs: 1000,
        });
        this.helper.control({ type: "resume", executionGeneration: holder.executionGeneration });
      }
    });
    this.permitTimer = setInterval(() => {
      lease.sweep();
      const holder = lease.current();
      if (holder && !this.paused.has(this.key(holder)))
        helper.control({
          type: "permit",
          executionGeneration: holder.executionGeneration,
          expiresInMs: 1000,
        });
    }, 250);
    this.permitTimer.unref();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private key(auth: Pick<ComputerAuthorization, "profileId" | "threadId">): string {
    return `${auth.profileId}\0${auth.threadId}`;
  }
  acquire(holder: ComputerLeaseHolder): ComputerLeaseHolder {
    if (this.paused.has(this.key(holder)))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    if (!this.helper.status().available)
      throw new ComputerControlError({
        _tag: "Unavailable",
        reason: this.helper.status().available
          ? "helper-crashed"
          : (this.helper.status() as { reason: "helper-crashed" }).reason,
      });
    if (this.now() - this.physicalInputAt < 1500) {
      this.paused.add(this.key(holder));
      throw new ComputerControlError({ _tag: "Interrupted", cause: "user-input" });
    }
    return this.lease.acquire(holder);
  }
  updateGrants(authorization: ComputerAuthorization): void {
    const key = this.key(authorization);
    const previous = this.grants.get(key);
    if (
      previous?.sessionGeneration === authorization.sessionGeneration &&
      previous.grantVersion >= authorization.grantVersion
    )
      return;
    if (previous && previous.sessionGeneration !== authorization.sessionGeneration)
      this.forgetAdmissions(
        (entry) =>
          entry.owner === key && entry.sessionGeneration !== authorization.sessionGeneration,
      );
    this.grants.set(key, authorization);
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.owner === key) this.snapshots.delete(id);
    this.cancelWhere(
      (job) => this.key(job.request.authorization) === key,
      new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" }),
    );
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
      const job: Job = { request, resolve, reject, cancelled: false };
      const mutation = isComputerMutation(request.op);
      if (
        mutation
          ? this.mutationQueue.length >= 32
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
      (mutation ? this.mutationQueue : this.observationQueue).push(job);
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
    if (!this.activeMutation) {
      const job = this.mutationQueue.shift();
      if (job) {
        this.activeMutation = job;
        void this.run(job).finally(() => {
          this.activeMutation = undefined;
          this.pump();
        });
      }
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
    if (isComputerMutation(request.op)) {
      const holder = this.lease.current();
      if (this.paused.has(this.key(request.authorization)))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      if (
        !holder ||
        !sameComputerHolder(holder, {
          ...request.authorization,
          backend: "native",
          threadTitle: request.agent.threadTitle,
        })
      )
        throw new ComputerControlError({ _tag: "ReplayRejected" });
      if (this.now() - this.physicalInputAt < 1500) {
        this.stop("user-input");
        throw new ComputerControlError({ _tag: "Interrupted", cause: "user-input" });
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
    try {
      this.validate(request);
      if (job.cancelled) return;
      if (mutation) {
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
          ...("appId" in request && this.appNames.has(request.appId)
            ? { appName: this.appNames.get(request.appId)! }
            : {}),
          ...(node?.displayId ? { displayId: node.displayId } : {}),
          ...(node?.bounds ? { bounds: node.bounds } : {}),
        };
        await this.overlay.action(request, status.available ? (status.displays ?? []) : [], target);
        this.validate(request);
        if (job.cancelled) return;
        this.options.activity(request.authorization.profileId, {
          threadId: request.authorization.threadId,
          backend: "native",
          op: request.op,
          status: "started",
        });
      }
      const result = await this.helper.request(request, {
        f5Pids: this.options.f5Pids(),
        f5BundlePath: this.options.f5BundlePath,
        overlayWindowIds: this.overlay.windowIds(),
      });
      if (job.cancelled) return;
      const limit =
        request.op === "inspect"
          ? 256 * 1024
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
        const holder = this.lease.current();
        if (holder) this.lease.touch(holder);
        const action =
          result !== null && typeof result === "object"
            ? (result as { frontmostApp?: { name?: unknown }; screenshot?: ComputerScreenshot })
            : undefined;
        const appName =
          typeof action?.frontmostApp?.name === "string"
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
          backend: "native",
          op: request.op,
          status: "completed",
          ...(appName ? { appName } : {}),
          ...(thumbnailDataUrl && Buffer.byteLength(thumbnailDataUrl) <= 40 * 1024
            ? { thumbnailDataUrl }
            : {}),
        });
      }
      job.resolve(result);
    } catch (error) {
      job.reject(error);
      if (mutation && !job.cancelled)
        this.options.activity(request.authorization.profileId, {
          threadId: request.authorization.threadId,
          backend: "native",
          op: request.op,
          status: "failed",
        });
    }
  }
  private cancelWhere(predicate: (job: Job) => boolean, error: ComputerControlError): void {
    const interrupt = (job: Job) => {
      if (job.cancelled) return;
      job.cancelled = true;
      job.reject(error);
      if (isComputerMutation(job.request.op))
        this.options.activity(job.request.authorization.profileId, {
          threadId: job.request.authorization.threadId,
          backend: "native",
          op: job.request.op,
          status: "interrupted",
        });
    };
    for (const queue of [this.mutationQueue, this.observationQueue])
      for (let index = queue.length - 1; index >= 0; --index) {
        const job = queue[index]!;
        if (predicate(job)) {
          queue.splice(index, 1);
          interrupt(job);
        }
      }
    for (const job of [this.activeMutation, ...this.activeObservations])
      if (job && predicate(job)) {
        if (job.cancelled) continue;
        this.helper.control({ type: "cancel", requestId: job.request.requestId });
        interrupt(job);
      }
  }
  cancel(requestId: string, profileId: string): void {
    this.cancelWhere(
      (job) =>
        job.request.requestId === requestId && job.request.authorization.profileId === profileId,
      new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }),
    );
  }
  disconnect(profileId: string): void {
    this.cancelWhere(
      (job) => job.request.authorization.profileId === profileId,
      new ComputerControlError({ _tag: "OutcomeUnknown" }),
    );
    if (this.lease.current()?.profileId === profileId) this.stop("paused");
    this.forgetAdmissions((entry) => entry.owner.startsWith(`${profileId}\0`));
    for (const [key, auth] of this.grants)
      if (auth.profileId === profileId) {
        this.grants.delete(key);
        this.paused.delete(key);
      }
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.owner.startsWith(`${profileId}\0`)) this.snapshots.delete(id);
  }
  stop(cause: "paused" | "kill-switch" | "user-input" | "permit-expired" = "paused"): void {
    const active = this.lease.current();
    // The chord's first physical modifier already pauses input; its final key must
    // still interrupt that exact turn after main has released the lease.
    const holder =
      active ?? (cause === "kill-switch" ? (this.recentlyStopped?.holder ?? null) : null);
    if (active) this.recentlyStopped = { holder: active };
    this.helper.control({ type: "suspend" });
    if (holder) {
      this.paused.add(this.key(holder));
      this.options.paused(holder, cause);
    }
    this.cancelWhere(() => true, new ComputerControlError({ _tag: "Interrupted", cause }));
    this.lease.invalidate();
    this.overlay.clear();
    if (cause === "kill-switch") this.recentlyStopped = undefined;
    if (active) void this.helper.suspend();
  }
  setPaused(profileId: string, threadId: string, paused: boolean): void {
    const key = this.key({ profileId, threadId });
    if (paused) {
      this.paused.add(key);
      if (this.lease.current() && this.key(this.lease.current()!) === key) this.stop();
    } else {
      if (!this.helper.status().available)
        throw new ComputerControlError({ _tag: "Unavailable", reason: "monitor-unhealthy" });
      this.paused.delete(key);
    }
  }
  close(): void {
    clearInterval(this.permitTimer);
    this.offEvent();
    this.offLease();
    this.stop();
    this.forgetAdmissions(() => true);
    this.grants.clear();
    this.snapshots.clear();
    this.appNames.clear();
    this.recentlyStopped = undefined;
  }
}
