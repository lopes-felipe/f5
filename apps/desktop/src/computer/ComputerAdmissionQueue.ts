import {
  COMPUTER_LEASE_WAIT_MAX_MS,
  type ComputerLeaseHolder,
  type ComputerLeaseScope,
} from "@t3tools/contracts";
import { ComputerControlError, computerError } from "@t3tools/shared/computerControl";

export interface ComputerAdmission<T> {
  kind: "lease" | "takeover";
  holder: ComputerLeaseHolder;
  profileId: string;
  requestId: string;
  waitMs?: number;
  /** Revalidates all policy, session, Chrome, readiness and native-work inputs synchronously. */
  admit: () => T;
}
interface Waiting {
  holder: ComputerLeaseHolder;
  profileId: string;
  requestId: string;
  deadline: number;
  lastError: unknown;
  attempt: () => void;
  reject: (error: unknown) => void;
}
const interrupted = () => new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
function waitable(cause: unknown): boolean {
  const error = computerError(cause);
  return (
    (error._tag === "Busy" && error.reason === undefined) ||
    (error._tag === "TargetBlocked" && error.kind === "foreground-busy")
  );
}

/** One scope-aware FIFO across native leases, takeover reservations, and every profile. */
export class ComputerAdmissionQueue {
  private readonly waiting: Waiting[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private scheduled = false;
  private draining = false;
  private changedDuringDrain = false;
  constructor(
    private readonly options: {
      conflicts: (a: ComputerLeaseScope, b: ComputerLeaseScope) => boolean;
      renewal: (holder: ComputerLeaseHolder) => boolean;
      sweep: (holder: ComputerLeaseHolder) => void;
      state: (holder: ComputerLeaseHolder, waiting: boolean) => void;
      now?: () => number;
    },
  ) {
    this.timer = setInterval(() => this.changed(), 250);
    this.timer.unref?.();
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  /** Snapshot queued owners so pause and disconnect can include waiting threads. */
  holders(): ReadonlyArray<ComputerLeaseHolder> {
    return this.waiting.map((entry) => entry.holder);
  }
  /** Admit immediately when eligible, otherwise wait behind earlier conflicting scopes. */
  admit<T>(input: ComputerAdmission<T>): Promise<T> {
    if (this.closed) return Promise.reject(interrupted());
    const earlier = this.waiting.find((entry) =>
      this.options.conflicts(entry.holder.scope, input.holder.scope),
    );
    let lastError: unknown = new ComputerControlError({
      _tag: "Busy",
      holder: earlier && earlier.profileId !== input.profileId ? "other-profile" : "same-profile",
    });
    if (!earlier || this.options.renewal(input.holder)) {
      try {
        return Promise.resolve(input.admit());
      } catch (error) {
        if (!waitable(error)) return Promise.reject(error);
        lastError = error;
      }
    }
    if (
      !input.waitMs ||
      this.waiting.length >= 64 ||
      this.waiting.filter((entry) => entry.profileId === input.profileId).length >= 16
    )
      return Promise.reject(lastError);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        this.options.state(input.holder, false);
        return true;
      };
      const entry: Waiting = {
        holder: input.holder,
        profileId: input.profileId,
        requestId: input.requestId,
        deadline: this.now() + Math.min(COMPUTER_LEASE_WAIT_MAX_MS, input.waitMs!),
        lastError,
        attempt: () => {
          if (done) return;
          try {
            const result = input.admit();
            if (finish()) resolve(result);
          } catch (error) {
            if (!waitable(error)) entry.reject(error);
            else entry.lastError = error;
          }
        },
        reject: (error) => {
          if (finish()) reject(error);
        },
      };
      this.waiting.push(entry);
      this.options.state(input.holder, true);
      this.changed();
    });
  }
  /** Coalesce readiness notifications into a non-reentrant FIFO pass. */
  changed(): void {
    if (this.closed || !this.waiting.length) return;
    if (this.draining) {
      this.changedDuringDrain = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }
  private drain(): void {
    if (this.closed || this.draining || !this.waiting.length) return;
    this.draining = true;
    try {
      const head = this.waiting[0]!;
      try {
        this.options.sweep(head.holder);
      } catch (error) {
        head.reject(error);
      }
      for (const entry of [...this.waiting]) {
        if (!this.waiting.includes(entry)) continue;
        if (this.now() >= entry.deadline) {
          entry.reject(entry.lastError);
          continue;
        }
        const index = this.waiting.indexOf(entry);
        if (
          this.waiting
            .slice(0, index)
            .some((earlier) => this.options.conflicts(earlier.holder.scope, entry.holder.scope))
        )
          continue;
        entry.attempt();
      }
    } finally {
      this.draining = false;
      if (this.changedDuringDrain) {
        this.changedDuringDrain = false;
        this.changed();
      }
    }
  }
  /** Reject matching requests and release their queue positions and waiting states. */
  cancel(
    predicate: (entry: Pick<Waiting, "profileId" | "requestId" | "holder">) => boolean,
    error: unknown = interrupted(),
  ): void {
    for (const entry of [...this.waiting]) if (predicate(entry)) entry.reject(error);
    this.changed();
  }
  /** Stop admission permanently, rejecting all outstanding waiters. */
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.cancel(() => true);
  }
}
