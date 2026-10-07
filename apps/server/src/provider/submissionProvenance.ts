import type { CommandId, ThreadId, ProviderSendTurnInput } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const stampSubmissionSource = Effect.fn(function* (
  commandId: CommandId,
  threadId: ThreadId,
  source: NonNullable<ProviderSendTurnInput["submissionSource"]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO provider_submission_provenance(command_id, thread_id, source, created_at)
    VALUES(${commandId}, ${threadId}, ${source}, ${new Date().toISOString()})`;
});

/** Missing legacy records fail closed; do not infer provenance from prompt text. */
export const readSubmissionSource = Effect.fn(function* (commandId: CommandId, threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    source: "human" | "automation";
  }>`SELECT source FROM provider_submission_provenance
    WHERE command_id = ${commandId} AND thread_id = ${threadId}`;
  return rows[0]?.source;
});
