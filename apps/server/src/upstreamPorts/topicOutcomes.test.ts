import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makeTopicOutcomeStore,
  readSettledPortReplies,
  type TopicOutcomeReceipt,
} from "./topicOutcomes.ts";

it.layer(SqlitePersistenceMemory)("durable upstream topic outcomes", (it) => {
  it.effect(
    "preserves scoped outcomes across generic PR updates and scopes replacements to an epoch",
    () =>
      Effect.gen(function* () {
        const store = makeTopicOutcomeStore(yield* SqlClient.SqlClient);
        const original: TopicOutcomeReceipt = {
          projectId: "p",
          topicId: "pr-1",
          epoch: 1,
          threadId: "thread",
          turnId: "original",
          messageId: "original",
          explicit: true,
          sourceAt: "2026-10-22T12:00:00.000Z",
          outcome: { kind: "equivalent", detail: "src/already.ts:1" },
        };
        yield* store.put(original);
        yield* store.put({
          ...original,
          turnId: "review",
          messageId: "review",
          explicit: false,
          sourceAt: "2026-10-22T13:00:00.000Z",
          outcome: { kind: "pr", detail: "https://github.com/o/f5/pull/42" },
        });
        assert.deepStrictEqual(yield* store.list("p", "thread"), [original]);
        const replacement = {
          ...original,
          turnId: "correction",
          messageId: "correction",
          sourceAt: "2026-10-22T14:00:00.000Z",
          outcome: { kind: "blocked" as const, detail: "Requires a product decision." },
        };
        yield* store.put(replacement);
        yield* store.put(original);
        yield* store.put({ ...original, epoch: 2 });
        assert.deepStrictEqual(yield* store.list("p", "thread"), [
          replacement,
          { ...original, epoch: 2 },
        ]);
      }),
  );

  it.effect(
    "pages settled history after admission and ignores running, unprocessed and foreign turns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 101; index++) {
          const turn = "history-" + index;
          yield* sql`INSERT INTO projection_turns
          (thread_id,turn_id,state,requested_at,processing_quiesced_at,checkpoint_files_json)
          VALUES ('history',${turn},'completed','2026-10-22','2026-10-23','[]')`;
          yield* sql`INSERT INTO projection_thread_messages
          (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
          VALUES (${turn},'history',${turn},'assistant','Outcome',0,'now','now')`;
        }
        yield* sql`INSERT INTO projection_turns
        (thread_id,turn_id,state,requested_at,processing_quiesced_at,checkpoint_files_json)
        VALUES ('history','before','completed','2026-10-20','2026-10-21','[]'),
          ('history','running','running','2026-10-22',NULL,'[]'),
          ('history','processing','completed','2026-10-22',NULL,'[]'),
          ('foreign','foreign','completed','2026-10-22','2026-10-23','[]')`;
        const replies = yield* readSettledPortReplies(sql, "history", "2026-10-21");
        assert.lengthOf(replies, 101);
        assert.isTrue(replies.every((reply) => reply.threadId === "history"));
      }),
  );
});
