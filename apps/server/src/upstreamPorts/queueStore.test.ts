import { expect, it } from "vitest";
import { it as effectIt, assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeQueueStore } from "./queueStore.ts";
import { outcomeCheckPending, type OutcomeCheck } from "./queueStore.ts";

it("caps same-turn outcome retries, honors backoff and resets the budget for a new turn", () => {
  const check: OutcomeCheck = {
    projectId: "p",
    threadId: "t",
    turnId: "turn",
    result: "failed",
    detail: "busy",
    checkedAt: "2026-10-22T12:00:00.000Z",
    attempts: 4,
    retryAt: "2026-10-22T12:01:00.000Z",
  };
  expect(outcomeCheckPending(check, "turn", Date.parse(check.checkedAt))).toBe(false);
  expect(outcomeCheckPending(check, "turn", Date.parse(check.retryAt!))).toBe(true);
  expect(outcomeCheckPending({ ...check, attempts: 5 }, "turn", Date.parse(check.retryAt!))).toBe(
    false,
  );
  expect(
    outcomeCheckPending({ ...check, attempts: 5 }, "new-turn", Date.parse(check.checkedAt)),
  ).toBe(true);
  expect(
    outcomeCheckPending({ ...check, result: "recorded" }, "turn", Date.parse(check.retryAt!)),
  ).toBe(false);
  expect(
    outcomeCheckPending(
      { ...check, result: "preexisting" },
      "new-turn",
      Date.parse(check.retryAt!),
    ),
  ).toBe(false);
});

effectIt.layer(SqlitePersistenceMemory)("outcome recovery wakes", (it) => {
  it.effect("retries completed turns after the active-turn pointer is cleared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const queue = makeQueueStore(sql);
      yield* sql`INSERT INTO projection_threads
        (thread_id,project_id,title,model,latest_turn_id,created_at,last_interaction_at,updated_at)
        VALUES ('idle-port','p','Port','model',NULL,'now','now','now')`;
      yield* sql`INSERT INTO upstream_port_links
        VALUES ('p','pr-1',1,'idle-port','request',0,'active')`;
      yield* sql`INSERT INTO projection_turns
        (thread_id,turn_id,state,requested_at,processing_quiesced_at,assistant_message_id,checkpoint_files_json)
        VALUES ('idle-port','settled','completed','2026-10-22','2026-10-22','reply','[]')`;
      yield* queue.upsertOutcomeCheck({
        projectId: "p",
        threadId: "idle-port",
        turnId: "settled",
        result: "failed",
        detail: "busy",
        checkedAt: "2026-10-22",
        attempts: 1,
        retryAt: null,
      });
      assert.deepStrictEqual(yield* queue.listProjectsWithPortWork, ["p"]);
      yield* sql`UPDATE upstream_port_outcome_checks SET result = 'no-outcome'`;
      assert.deepStrictEqual(yield* queue.listProjectsWithPortWork, []);
      yield* sql`INSERT INTO projection_turns
        (thread_id,turn_id,state,requested_at,processing_quiesced_at,assistant_message_id,checkpoint_files_json)
        VALUES ('idle-port','next','completed','2026-10-23','2026-10-23','next-reply','[]')`;
      assert.deepStrictEqual(yield* queue.listProjectsWithPortWork, ["p"]);
      yield* sql`UPDATE upstream_port_outcome_checks SET result = 'preexisting'`;
      assert.deepStrictEqual(yield* queue.listProjectsWithPortWork, []);
    }),
  );
});
