import { CommandId, type NativeOperationRecord } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

/** Finish both acknowledgement steps on the server; retries after a crash are safe. */
export function finishAcknowledgedNativeRewind(
  record: NativeOperationRecord,
  sql: SqlClient.SqlClient,
  engine: Pick<OrchestrationEngineShape, "dispatch">,
) {
  return Effect.gen(function* () {
    if (
      record.state !== "cancelled" ||
      record.command.kind !== "revertFiles" ||
      !record.operationId.startsWith("native-files:")
    )
      return;
    const operationId = CommandId.makeUnsafe(record.operationId.slice("native-files:".length));
    const pending = yield* sql`SELECT 1 FROM rewind_operations WHERE operation_id = ${operationId}
      AND thread_id = ${record.threadId} AND state IN ('prepared', 'reconciliation-required')`;
    if (!pending.length) return;
    yield* engine.dispatch({
      type: "thread.rewind-draft.resolve",
      commandId: CommandId.makeUnsafe(`native-ack:${crypto.randomUUID()}`),
      threadId: record.threadId,
      operationId,
      intent: "cancel",
      createdAt: new Date().toISOString(),
    });
  });
}
