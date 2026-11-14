import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { MuseHistoryRecord } from "./museHistory.ts";

export interface MuseRecordedInterval {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** Unknown bounds and missing token coverage cannot prove an inference is already represented. */
export const museRecordedIntervals = (sql: SqlClient.SqlClient) => sql<MuseRecordedInterval>`
  SELECT native_session_id AS "sessionId", started_at AS "startedAt", completed_at AS "endedAt"
  FROM projection_turn_usage_facts
  WHERE provider_name = 'muse' AND native_session_id IS NOT NULL
    AND started_at IS NOT NULL AND total_tokens IS NOT NULL
`;

export function recordedMusePredicate(intervals: readonly MuseRecordedInterval[]) {
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
  return (record: MuseHistoryRecord) =>
    // MSP turn usage is the sum of that turn's model completions. Automated reviews
    // are separate native events; do not infer that they are included in a turn total.
    record.kind === "model_completed" &&
    (bySession.get(record.sessionId) ?? []).some(
      (interval) => record.timestamp >= interval.startedAt && record.timestamp <= interval.endedAt,
    );
}
