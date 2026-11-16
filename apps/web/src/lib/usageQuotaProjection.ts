export interface QuotaObservation {
  readonly at: string;
  readonly usedPercent: number;
}

export type QuotaProjection =
  | { readonly kind: "exhausted" }
  | { readonly kind: "insufficient" }
  | { readonly kind: "will-hit"; readonly at: string }
  | { readonly kind: "under"; readonly percentAtReset: number };

const MINUTE_MS = 60_000;
const STALE_OBSERVATION_MS = 30 * MINUTE_MS;
const MIN_SPAN_MS = 15 * MINUTE_MS;
const SHORT_WINDOW_MS = 6 * 60 * MINUTE_MS;
const SHORT_LOOKBACK_MS = 2 * 60 * MINUTE_MS;
const LONG_LOOKBACK_MS = 24 * 60 * MINUTE_MS;
const RESET_DROP_POINTS = 1;

/**
 * Projects quota use at the current pace (least-squares slope, clamped to be
 * non-negative). Returns null when no honest projection exists: unknown use,
 * no future reset, or a stale latest observation.
 */
export function projectQuota(input: {
  readonly samples: ReadonlyArray<QuotaObservation>;
  readonly current: { readonly at: string; readonly usedPercent: number | null };
  readonly resetsAt: string | null;
  readonly now: number;
}): QuotaProjection | null {
  const { current, now } = input;
  if (current.usedPercent === null || input.resetsAt === null) return null;
  const resetsAt = Date.parse(input.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return null;

  const byTime = new Map<number, number>();
  for (const sample of input.samples) {
    const at = Date.parse(sample.at);
    if (Number.isFinite(at)) byTime.set(at, sample.usedPercent);
  }
  const currentAt = Date.parse(current.at);
  if (!Number.isFinite(currentAt)) return null;
  const lastSample = [...byTime.entries()].sort((left, right) => left[0] - right[0]).at(-1);
  // A drop below the history means the window reset; history no longer applies.
  if (lastSample && current.usedPercent < lastSample[1] - RESET_DROP_POINTS) byTime.clear();
  byTime.set(currentAt, current.usedPercent);
  const observations = [...byTime.entries()].sort((left, right) => left[0] - right[0]);
  const latest = observations.at(-1)!;
  if (now - latest[0] > STALE_OBSERVATION_MS) return null;
  const used = latest[1];
  if (used >= 100) return { kind: "exhausted" };

  const lookback = resetsAt - now <= SHORT_WINDOW_MS ? SHORT_LOOKBACK_MS : LONG_LOOKBACK_MS;
  const recent = observations.filter(([at]) => at >= now - lookback);
  if (recent.length < 2 || recent.at(-1)![0] - recent[0]![0] < MIN_SPAN_MS)
    return { kind: "insufficient" };

  const meanX = recent.reduce((sum, [at]) => sum + at, 0) / recent.length;
  const meanY = recent.reduce((sum, [, value]) => sum + value, 0) / recent.length;
  let numerator = 0;
  let denominator = 0;
  for (const [at, value] of recent) {
    numerator += (at - meanX) * (value - meanY);
    denominator += (at - meanX) ** 2;
  }
  const slope = Math.max(0, denominator === 0 ? 0 : numerator / denominator);
  if (slope > 0) {
    const hitAt = now + (100 - used) / slope;
    if (hitAt < resetsAt) return { kind: "will-hit", at: new Date(hitAt).toISOString() };
  }
  const percentAtReset = Math.min(100, Math.max(used, used + slope * (resetsAt - now)));
  return { kind: "under", percentAtReset };
}
