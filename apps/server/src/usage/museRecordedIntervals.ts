import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { MuseHistoryRecord } from "./museHistory.ts";
import type { NativeUsageRecord } from "./nativeUsageRecord.ts";

export interface MuseRecordedInterval {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface NativeRecordedInterval extends MuseRecordedInterval {
  readonly provider: string;
}

/** Unknown bounds and missing token coverage cannot prove an inference is already represented. */
export const nativeRecordedIntervals = (sql: SqlClient.SqlClient) => sql<NativeRecordedInterval>`
  SELECT provider_name AS provider, native_session_id AS "sessionId",
    started_at AS "startedAt", completed_at AS "endedAt"
  FROM projection_turn_usage_facts
  WHERE provider_name IN ('muse', 'cursor', 'opencode', 'antigravity')
    AND native_session_id IS NOT NULL
    AND started_at IS NOT NULL AND total_tokens IS NOT NULL
`;

function recordedIntervalPredicate(intervals: readonly MuseRecordedInterval[]) {
  const bySession = new Map<string, MuseRecordedInterval[]>();
  for (const interval of intervals) {
    const start = Date.parse(interval.startedAt),
      end = Date.parse(interval.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) continue;
    const entries = bySession.get(interval.sessionId) ?? [];
    entries.push({
      ...interval,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
    });
    bySession.set(interval.sessionId, entries);
  }
  return (record: Pick<MuseHistoryRecord, "sessionId" | "timestamp">) =>
    (bySession.get(record.sessionId) ?? []).some(
      (interval) => record.timestamp >= interval.startedAt && record.timestamp <= interval.endedAt,
    );
}

export function recordedMusePredicate(intervals: readonly MuseRecordedInterval[]) {
  const isRecorded = recordedIntervalPredicate(intervals);
  return (record: MuseHistoryRecord) =>
    // MSP turn usage is the sum of that turn's model completions. Automated reviews
    // are separate native events; do not infer that they are included in a turn total.
    record.kind === "model_completed" && isRecorded(record);
}

export function recordedExternalPredicate(intervals: readonly NativeRecordedInterval[]) {
  const predicates = new Map(
    (["opencode", "cursor", "antigravity"] as const).map((provider) => [
      provider,
      recordedIntervalPredicate(intervals.filter((interval) => interval.provider === provider)),
    ]),
  );
  return (record: NativeUsageRecord) => {
    const time = new Date(record.timestampMs);
    return (
      record.sessionId &&
      Number.isFinite(time.getTime()) &&
      predicates.get(record.provider)?.({
        sessionId: record.sessionId,
        timestamp: time.toISOString(),
      })
    );
  };
}
