import { CommandId, ThreadId, MessageId, type NativeOperationRecord } from "@t3tools/contracts";
import { it, expect } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { finishAcknowledgedNativeRewind } from "./nativeRewindAcknowledgement.ts";

it("finishes a cancelled native receipt after a failed cancellation, without another browser request or mutation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const threadId = ThreadId.makeUnsafe("native-ack-thread");
      const operationId = CommandId.makeUnsafe("native-ack-rewind");
      const at = "2026-10-09T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('native-ack-project', 'Project', '/tmp/project', '[]', ${at}, ${at})`;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES (${threadId}, 'native-ack-project', 'Thread', 'model', ${at}, ${at}, ${at})`;
      yield* sql`INSERT INTO rewind_operations(operation_id, thread_id, target_message_id, provider_session_id, mode, expected_revision, state, relative_count, retained_count, boundary_json, draft_json, created_at, updated_at)
      VALUES (${operationId}, ${threadId}, ${MessageId.makeUnsafe("message")}, 'session', 'conversation-and-files', 1, 'reconciliation-required', 1, 0, '{}', '{}', ${at}, ${at})`;
      const record: NativeOperationRecord = {
        operationId: `native-files:${operationId}`,
        threadId,
        generation: 1,
        command: { kind: "revertFiles", userMessageId: "uuid" },
        state: "cancelled",
        createdAt: at,
        updatedAt: at,
      };
      let calls = 0;
      const engine = {
        dispatch: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1)
              return yield* new OrchestrationCommandInvariantError({
                commandType: "thread.rewind-draft.resolve",
                detail: "Temporary cancellation failure",
              });
            yield* sql`DELETE FROM rewind_operations WHERE operation_id = ${operationId}`.pipe(
              Effect.orDie,
            );
            return { sequence: 1 };
          }),
      };
      const first = yield* Effect.exit(finishAcknowledgedNativeRewind(record, sql, engine));
      expect(first._tag).toBe("Failure");
      yield* finishAcknowledgedNativeRewind(record, sql, engine);
      yield* finishAcknowledgedNativeRewind(record, sql, engine);
      expect(calls).toBe(2);
      expect(
        (yield* sql`SELECT 1 FROM rewind_operations WHERE operation_id = ${operationId}`).length,
      ).toBe(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
