import { RPC_LANES, RpcAdmission, type RpcLane } from "@t3tools/shared/rpcScheduling";

/**
 * Ordinary-lane dispatch classes, dequeued in this order. Connection controls
 * are idempotent and travel with interactive reads.
 */
export type RpcRequestClass = "mutation" | "interactive" | "background";

export interface ScheduledRpc {
  readonly id: string;
  readonly lane: RpcLane;
  readonly requestClass: RpcRequestClass;
  readonly bytes: number;
}

interface QueueCap {
  readonly count: number;
  readonly bytes: number;
}

const MIB = 1024 * 1024;

/** Unsent requests per lane. Hitting a cap rejects only that lane's new request. */
export const RPC_QUEUE_CAPS: Readonly<Record<RpcLane, QueueCap>> = {
  ordinary: { count: 256, bytes: 80 * MIB },
  stop: { count: 16, bytes: MIB },
  answer: { count: 32, bytes: 40 * MIB },
  recovery: { count: 8, bytes: MIB },
  long: { count: 16, bytes: 40 * MIB },
  health: { count: 2, bytes: 64 * 1024 },
};
export const RPC_BACKGROUND_QUEUE_CAP: QueueCap = { count: 192, bytes: 16 * MIB };

/** Reads leave two ordinary slots for mutations; background reads leave two more for interactive reads. */
export const ORDINARY_READ_SLOTS = 6;
export const ORDINARY_BACKGROUND_SLOTS = 4;
/** Consecutive foreground dispatches before a waiting background read goes first. */
export const BACKGROUND_STARVATION_LIMIT = 8;

/** Socket send order across lanes; each lane has its own slots. */
const LANE_DISPATCH_ORDER: ReadonlyArray<RpcLane> = [
  "health",
  "stop",
  "answer",
  "recovery",
  "ordinary",
  "long",
];

class RequestQueue<T extends ScheduledRpc> {
  // Map preserves FIFO order while making removal by request id O(1).
  readonly entries = new Map<string, T>();
  bytes = 0;

  add(entry: T): void {
    this.entries.set(entry.id, entry);
    this.bytes += entry.bytes;
  }

  delete(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
    return entry;
  }

  oldest(): T | undefined {
    return this.entries.values().next().value;
  }

  get size(): number {
    return this.entries.size;
  }

  fits(cap: QueueCap, bytes: number): boolean {
    // An empty queue always admits one request its lane can carry at all.
    return this.size < cap.count && (this.size === 0 || this.bytes + bytes <= cap.bytes);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

interface DispatchGate<T> {
  readonly eligible: (entry: T) => boolean;
  readonly holdsBack: (held: T, later: T) => boolean;
}

export type RpcEnqueueResult<T> =
  | { readonly ok: true; readonly evicted: T | null }
  | { readonly ok: false; readonly lane: RpcLane };

interface InFlightEntry<T> {
  readonly entry: T;
  readonly release: () => void;
}

/**
 * Client mirror of the server's per-socket `RpcAdmission`: the client is the
 * only sender on its socket, so it admits requests against the same limits
 * before sending instead of collecting `RpcBusy` rejections.
 */
export class RpcRequestScheduler<T extends ScheduledRpc> {
  private admission = new RpcAdmission();
  private readonly queues: Record<Exclude<RpcLane, "ordinary">, RequestQueue<T>> = {
    stop: new RequestQueue(),
    answer: new RequestQueue(),
    recovery: new RequestQueue(),
    long: new RequestQueue(),
    health: new RequestQueue(),
  };
  private readonly ordinary: Record<RpcRequestClass, RequestQueue<T>> = {
    mutation: new RequestQueue(),
    interactive: new RequestQueue(),
    background: new RequestQueue(),
  };
  private readonly inFlight = new Map<string, InFlightEntry<T>>();
  private inFlightReads = 0;
  private inFlightBackground = 0;
  private foregroundStreak = 0;

  enqueue(entry: T): RpcEnqueueResult<T> {
    if (entry.lane !== "ordinary") {
      const queue = this.queues[entry.lane];
      if (!queue.fits(RPC_QUEUE_CAPS[entry.lane], entry.bytes))
        return { ok: false, lane: entry.lane };
      queue.add(entry);
      return { ok: true, evicted: null };
    }
    if (
      entry.requestClass === "background" &&
      !this.ordinary.background.fits(RPC_BACKGROUND_QUEUE_CAP, entry.bytes)
    )
      return { ok: false, lane: "ordinary" };
    if (this.ordinaryFits(entry.bytes, null)) {
      this.ordinary[entry.requestClass].add(entry);
      return { ok: true, evicted: null };
    }
    // Only foreground work may displace the oldest queued background read;
    // mutations and controls are never evicted.
    const victim =
      entry.requestClass === "background" ? undefined : this.ordinary.background.oldest();
    if (!victim || !this.ordinaryFits(entry.bytes, victim)) return { ok: false, lane: "ordinary" };
    this.ordinary.background.delete(victim.id);
    this.ordinary[entry.requestClass].add(entry);
    return { ok: true, evicted: victim };
  }

  /** Removes an unsent request. Returns `undefined` when it was not queued. */
  remove(id: string): T | undefined {
    for (const queue of this.allQueues()) {
      const entry = queue.delete(id);
      if (entry) return entry;
    }
    return undefined;
  }

  isQueued(id: string): boolean {
    return this.allQueues().some((queue) => queue.entries.has(id));
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get queuedCount(): number {
    return this.allQueues().reduce((sum, queue) => sum + queue.size, 0);
  }

  /**
   * Claims a slot for every queued request that may be sent now, in priority
   * order, and returns them. `eligible` rejects requests still gated on
   * synchronization or runtime readiness; they keep their queue position.
   * `holdsBack` decides which later mutations an ineligible mutation keeps
   * behind it; by default, all of them.
   */
  takeDispatchable(
    eligible: (entry: T) => boolean,
    holdsBack: (held: T, later: T) => boolean = () => true,
  ): T[] {
    const gate: DispatchGate<T> = { eligible, holdsBack };
    const taken: T[] = [];
    for (const lane of LANE_DISPATCH_ORDER) {
      if (lane === "ordinary") this.takeOrdinary(gate, taken);
      else this.takeFrom(this.queues[lane], gate, taken);
    }
    return taken;
  }

  /** Releases a sent request's slot. Returns false when it held none. */
  release(id: string): boolean {
    const inFlight = this.inFlight.get(id);
    if (!inFlight) return false;
    this.inFlight.delete(id);
    inFlight.release();
    if (inFlight.entry.lane === "ordinary" && inFlight.entry.requestClass !== "mutation") {
      this.inFlightReads--;
      if (inFlight.entry.requestClass === "background") this.inFlightBackground--;
    }
    return true;
  }

  /** Drops every queued request and slot. Used when a socket generation ends. */
  reset(): void {
    for (const queue of this.allQueues()) queue.clear();
    this.inFlight.clear();
    this.inFlightReads = 0;
    this.inFlightBackground = 0;
    this.foregroundStreak = 0;
    this.admission = new RpcAdmission();
  }

  /** Releases only slots; queued requests stay for the next socket. */
  resetAdmission(): void {
    this.inFlight.clear();
    this.inFlightReads = 0;
    this.inFlightBackground = 0;
    this.admission = new RpcAdmission();
  }

  queuedEntries(): T[] {
    return this.allQueues().flatMap((queue) => [...queue.entries.values()]);
  }

  snapshot(): {
    readonly queued: Readonly<Record<RpcLane, number>>;
    readonly inFlight: Readonly<Record<RpcLane, number>>;
  } {
    const queued = Object.fromEntries(RPC_LANES.map((lane) => [lane, 0])) as Record<
      RpcLane,
      number
    >;
    const inFlight = { ...queued };
    for (const lane of RPC_LANES) {
      queued[lane] =
        lane === "ordinary"
          ? this.ordinary.mutation.size +
            this.ordinary.interactive.size +
            this.ordinary.background.size
          : this.queues[lane].size;
      inFlight[lane] = this.admission.inFlight(lane);
    }
    return { queued, inFlight };
  }

  /** Whether the ordinary queue admits `bytes` more, optionally after evicting `without`. */
  private ordinaryFits(bytes: number, without: T | null): boolean {
    const count =
      this.ordinary.mutation.size +
      this.ordinary.interactive.size +
      this.ordinary.background.size -
      (without ? 1 : 0);
    const queuedBytes =
      this.ordinary.mutation.bytes +
      this.ordinary.interactive.bytes +
      this.ordinary.background.bytes -
      (without?.bytes ?? 0);
    const cap = RPC_QUEUE_CAPS.ordinary;
    return count < cap.count && (count === 0 || queuedBytes + bytes <= cap.bytes);
  }

  private takeOrdinary(gate: DispatchGate<T>, taken: T[]): void {
    for (;;) {
      const backgroundFirst =
        this.foregroundStreak >= BACKGROUND_STARVATION_LIMIT && this.ordinary.background.size > 0;
      const order: ReadonlyArray<RpcRequestClass> = backgroundFirst
        ? ["background", "mutation", "interactive"]
        : ["mutation", "interactive", "background"];
      let dispatched: T | null = null;
      for (const requestClass of order) {
        if (!this.classHasSlot(requestClass)) continue;
        dispatched = this.takeOne(this.ordinary[requestClass], gate);
        if (dispatched) break;
      }
      if (!dispatched) return;
      if (dispatched.requestClass === "background") this.foregroundStreak = 0;
      else if (this.ordinary.background.size > 0) this.foregroundStreak++;
      taken.push(dispatched);
    }
  }

  private classHasSlot(requestClass: RpcRequestClass): boolean {
    if (requestClass === "mutation") return true;
    if (this.inFlightReads >= ORDINARY_READ_SLOTS) return false;
    return requestClass !== "background" || this.inFlightBackground < ORDINARY_BACKGROUND_SLOTS;
  }

  private takeFrom(queue: RequestQueue<T>, gate: DispatchGate<T>, taken: T[]): void {
    for (;;) {
      const entry = this.takeOne(queue, gate);
      if (!entry) return;
      taken.push(entry);
    }
  }

  /**
   * Claims the first eligible entry; stops at the first one the lane cannot
   * admit. Reads may pass a held entry, but mutations keep their send order:
   * a held mutation also holds the later mutations in its queue that
   * `holdsBack` names.
   */
  private takeOne(queue: RequestQueue<T>, gate: DispatchGate<T>): T | null {
    const heldMutations: T[] = [];
    for (const entry of queue.entries.values()) {
      const mutation = entry.requestClass === "mutation";
      if (mutation && heldMutations.some((held) => gate.holdsBack(held, entry))) continue;
      if (!gate.eligible(entry)) {
        if (mutation) heldMutations.push(entry);
        continue;
      }
      const release = this.admission.claim(entry.lane, entry.bytes);
      if (!release) return null;
      queue.delete(entry.id);
      this.inFlight.set(entry.id, { entry, release });
      if (entry.lane === "ordinary" && entry.requestClass !== "mutation") {
        this.inFlightReads++;
        if (entry.requestClass === "background") this.inFlightBackground++;
      }
      return entry;
    }
    return null;
  }

  private allQueues(): RequestQueue<T>[] {
    return [
      this.queues.health,
      this.queues.stop,
      this.queues.answer,
      this.queues.recovery,
      this.ordinary.mutation,
      this.ordinary.interactive,
      this.ordinary.background,
      this.queues.long,
    ];
  }
}

/** UTF-8 byte length without allocating an encoded copy of large frames. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
