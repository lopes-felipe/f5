import type { UsageQuotaHistory, UsageQuotaSeries } from "@t3tools/contracts";

import type { QuotaSampleRow } from "../persistence/Services/UsageAccountHistory.ts";

export const QUOTA_HISTORY_LOOKBACK_MS = 8 * 24 * 60 * 60_000;
export const QUOTA_SERIES_MAX_POINTS = 240;
const RESET_DRIFT_MS = 10 * 60_000;
const USAGE_DROP_POINTS = 1;

function sameWindow(left: QuotaSampleRow, right: QuotaSampleRow): boolean {
  if (left.resetsAt === null || right.resetsAt === null) return false;
  const drift = Math.abs(Date.parse(left.resetsAt) - Date.parse(right.resetsAt));
  return Number.isFinite(drift) && drift <= RESET_DRIFT_MS;
}

function downsample<T>(points: ReadonlyArray<T>, max: number): Array<T> {
  if (points.length <= max) return [...points];
  const indexes = new Set<number>();
  for (let index = 0; index < max; index++)
    indexes.add(Math.round((index * (points.length - 1)) / (max - 1)));
  indexes.add(points.length - 1);
  return [...indexes].sort((left, right) => left - right).map((index) => points[index]!);
}

/**
 * Builds the current-window series per account window from rows ordered by
 * account key, window key, and time. A series covers only the latest identity
 * and is cut where the reset time jumps or usage drops (a reset happened).
 */
export function buildQuotaHistory(
  rows: ReadonlyArray<QuotaSampleRow>,
  now: Date,
): UsageQuotaHistory {
  const groups = new Map<string, Array<QuotaSampleRow>>();
  for (const row of rows) {
    const key = `${row.accountKey}\u0000${row.windowKey}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const series: Array<UsageQuotaSeries> = [];
  for (const group of groups.values()) {
    const last = group[group.length - 1]!;
    const samples = group.filter((row) => row.identity === last.identity);
    if (last.resetsAt === null || !(Date.parse(last.resetsAt) > now.getTime())) continue;
    let start = samples.length - 1;
    while (start > 0) {
      const previous = samples[start - 1]!;
      const current = samples[start]!;
      if (!sameWindow(previous, current)) break;
      if (previous.usedPercent - current.usedPercent > USAGE_DROP_POINTS) break;
      start--;
    }
    series.push({
      accountKey: last.accountKey,
      windowKey: last.windowKey,
      resetsAt: last.resetsAt,
      samples: downsample(samples.slice(start), QUOTA_SERIES_MAX_POINTS).map((row) => ({
        at: row.sampledAt,
        usedPercent: row.usedPercent,
      })),
    });
  }
  return { generatedAt: now.toISOString(), series };
}
