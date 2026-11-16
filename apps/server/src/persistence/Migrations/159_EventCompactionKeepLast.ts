import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Bookkeeping for two more kinds of event compaction (see `eventCompaction.ts`):
 *
 * - `orchestration_event_keep_last` remembers, per group of events where only
 *   the newest matters (a planning workflow's upserts), which stored event is
 *   the newest one still eligible for removal, plus how far each scan has read.
 * - Threads compacted before this version are visited again, so the session
 *   updates that only moved a token estimate are removed from them too. A
 *   revisit reads small payloads and changes nothing else.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_event_keep_last (
      group_key TEXT PRIMARY KEY,
      kept_sequence INTEGER
    )
  `;
  yield* sql`UPDATE orchestration_event_compaction SET compacted_through_sequence = 0`;
});
