import type { ProviderEvent } from "@t3tools/contracts";

const METRICS = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
type Metric = (typeof METRICS)[number];
type Counts = Partial<Record<Metric, number>>;
interface Context {
  nativeThreadId?: string;
  baseline: Counts;
  active?: { turnId: string; counts: Counts; unknown: Set<Metric> };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Billable usage for an agentic turn, independent of its last-request context
 * occupancy. Called in native notification order, before runtime persistence.
 */
export class CodexTurnUsage {
  private readonly contexts = new Map<string, Context>();

  observe(event: ProviderEvent): Counts | undefined {
    const key = JSON.stringify([
      event.threadId,
      event.providerInstanceId ?? null,
      event.sessionGeneration ?? 0,
    ]);
    if (event.method === "session/exited" || event.method === "session/closed") {
      this.contexts.delete(key);
      return undefined;
    }
    const payload = record(event.payload);
    const thread = record(payload?.thread);
    const nativeThreadId =
      typeof payload?.threadId === "string"
        ? payload.threadId
        : typeof thread?.id === "string"
          ? thread.id
          : undefined;
    const context: Context = this.contexts.get(key) ?? { baseline: {} };
    if (
      context.nativeThreadId !== undefined &&
      nativeThreadId !== undefined &&
      context.nativeThreadId !== nativeThreadId
    ) {
      return undefined;
    }
    if (event.method === "thread/started" || event.method === "turn/started") {
      if (nativeThreadId !== undefined) context.nativeThreadId ??= nativeThreadId;
      if (event.method === "turn/started" && event.turnId) {
        // A duplicate start must not discard requests already accounted for.
        if (context.active?.turnId !== event.turnId)
          context.active = { turnId: event.turnId, counts: {}, unknown: new Set() };
      }
      this.contexts.set(key, context);
      return undefined;
    }
    if (event.method === "thread/tokenUsage/updated") {
      const usage = record(payload?.tokenUsage);
      const total = record(usage?.total);
      const last = record(usage?.last);
      const active = context.active;
      // Idle resume snapshots establish a baseline only for the known native
      // thread. Stale turns and child agents must not alter an active baseline.
      if (active ? event.turnId !== active.turnId : context.nativeThreadId === undefined)
        return undefined;
      const reset = METRICS.some((metric) => {
        const current = count(total?.[metric]);
        const previous = context.baseline[metric];
        return current !== undefined && previous !== undefined && current < previous;
      });
      for (const metric of METRICS) {
        const current = count(total?.[metric]);
        const previous = context.baseline[metric];
        const increment =
          !reset && current !== undefined && previous !== undefined
            ? current - previous
            : count(last?.[metric]);
        if (active) {
          // A last-only frame cannot be deduplicated reliably. Preserve unknown
          // rather than displaying a precise ratio from incomplete accounting.
          const sum = (active.counts[metric] ?? 0) + (increment ?? 0);
          if (current === undefined || increment === undefined || !Number.isSafeInteger(sum))
            active.unknown.add(metric);
          if (active.unknown.has(metric)) delete active.counts[metric];
          else active.counts[metric] = sum;
        }
        // Without cumulative counters, repeated last-request frames cannot be
        // distinguished from new requests. Do not reuse a stale baseline.
        if (current !== undefined) context.baseline[metric] = current;
        else delete context.baseline[metric];
      }
      this.contexts.set(key, context);
    }
    if (
      (event.method === "turn/completed" || event.method === "turn/aborted") &&
      context.active !== undefined &&
      context.active.turnId === event.turnId
    ) {
      const counts = context.active.counts;
      delete context.active;
      // Omit totalTokens: these are computed deltas, not a provider-reported
      // per-turn total. The shared normalizer derives totals and provenance.
      return Object.keys(counts).length > 0 ? counts : undefined;
    }
    return undefined;
  }
}
