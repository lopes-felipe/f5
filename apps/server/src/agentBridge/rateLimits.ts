/**
 * In-memory admission limits for bridge clients. Every limit is checked
 * before admission and reports when the caller may retry.
 *
 * @module agentBridge/rateLimits
 */

export const AGENT_BRIDGE_LIMITS = {
  concurrentWaitersPerClient: 2,
  createThreadPerHour: 10,
  sendMessagePerHour: 30,
  queuedBridgeItemsPerThread: 3,
  runningBridgeThreadsGlobal: 4,
  taskWritesPerSecond: 1,
  taskWriteBurst: 10,
} as const;

const HOUR_MS = 60 * 60 * 1000;

export interface LimitRejection {
  readonly message: string;
  readonly retryAfterSeconds: number;
}

/** Sliding-window counter keyed by client and action. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks without consuming. */
  check(key: string): LimitRejection | null {
    const at = this.now();
    const recent = this.recent(key, at);
    if (recent.length < this.limit) return null;
    const oldest = recent[0]!;
    return {
      message: "Rate limit reached.",
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - at) / 1000)),
    };
  }

  consume(key: string): void {
    const at = this.now();
    const recent = this.recent(key, at);
    recent.push(at);
    this.hits.set(key, recent);
  }

  private recent(key: string, at: number): number[] {
    return (this.hits.get(key) ?? []).filter((hit) => hit > at - this.windowMs);
  }
}

/** Counts concurrently held slots per key. */
export class ConcurrencySlots {
  private readonly held = new Map<string, number>();

  constructor(private readonly limit: number) {}

  /** Returns a release function, or null when every slot is taken. */
  acquire(key: string): (() => void) | null {
    const count = this.held.get(key) ?? 0;
    if (count >= this.limit) return null;
    this.held.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.held.get(key) ?? 1) - 1;
      if (next <= 0) this.held.delete(key);
      else this.held.set(key, next);
    };
  }
}

/** Token bucket keyed by client: `ratePerSecond` refill up to `burst` tokens. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token, or reports when one will be available. */
  take(key: string): LimitRejection | null {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at };
    const tokens = Math.min(
      this.burst,
      bucket.tokens + ((at - bucket.at) / 1000) * this.ratePerSecond,
    );
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at });
      return {
        message: "Rate limit reached.",
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.ratePerSecond)),
      };
    }
    this.buckets.set(key, { tokens: tokens - 1, at });
    return null;
  }
}

export interface AgentBridgeLimiters {
  readonly createThread: SlidingWindowLimiter;
  readonly sendMessage: SlidingWindowLimiter;
  readonly waiters: ConcurrencySlots;
  readonly taskWrites: TokenBucketLimiter;
  readonly schedulingWrites: TokenBucketLimiter;
}

export const makeAgentBridgeLimiters = (now: () => number = Date.now): AgentBridgeLimiters => ({
  createThread: new SlidingWindowLimiter(AGENT_BRIDGE_LIMITS.createThreadPerHour, HOUR_MS, now),
  sendMessage: new SlidingWindowLimiter(AGENT_BRIDGE_LIMITS.sendMessagePerHour, HOUR_MS, now),
  waiters: new ConcurrencySlots(AGENT_BRIDGE_LIMITS.concurrentWaitersPerClient),
  schedulingWrites: new TokenBucketLimiter(1, 10, now),
  taskWrites: new TokenBucketLimiter(
    AGENT_BRIDGE_LIMITS.taskWritesPerSecond,
    AGENT_BRIDGE_LIMITS.taskWriteBurst,
    now,
  ),
});
