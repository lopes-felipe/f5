import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makeTopicOutcomeStore,
  readSettledPortReplies,
  recoveredTopicOutcome,
  type TopicOutcomeReceipt,
} from "./topicOutcomes.ts";
import { parseUpstreamOutcomes } from "@t3tools/shared/upstreamPortsOutcomes";

it("supersedes earlier evidence with invalid scoped corrections and verifies batch PR membership", () => {
  const invalid = parseUpstreamOutcomes("UPSTREAM-OUTCOME pr-1: equivalent nonsense");
  assert.equal(recoveredTopicOutcome(invalid, "pr-1", 2)?.kind, "invalid");
  const pr = parseUpstreamOutcomes("UPSTREAM-OUTCOME: pr https://github.com/o/f5/pull/42", {
    forkRepo: "https://github.com/o/f5",
  });
  assert.equal(recoveredTopicOutcome(pr, "pr-1", 2, "unknown")?.kind, "invalid");
  assert.isNull(recoveredTopicOutcome(pr, "pr-1", 2, "excluded"));
  assert.equal(recoveredTopicOutcome(pr, "pr-1", 2, "included")?.kind, "pr");
  assert.equal(recoveredTopicOutcome(pr, "pr-1", 1)?.kind, "pr");
  assert.isNull(recoveredTopicOutcome(parseUpstreamOutcomes("Review complete."), "pr-1", 1));
});

it.layer(SqlitePersistenceMemory)("durable upstream topic outcomes", (it) => {
  it.effect(
    "orders scoped and generic replacements chronologically and scopes them to an epoch",
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
        const review: TopicOutcomeReceipt = {
          ...original,
          turnId: "review",
          messageId: "review",
          explicit: false,
          sourceAt: "2026-10-22T13:00:00.000Z",
          outcome: { kind: "pr", detail: "https://github.com/o/f5/pull/42" },
        };
        yield* store.put(review);
        assert.deepStrictEqual(yield* store.list("p", "thread"), [review]);
        const replacement = {
          ...original,
          turnId: "correction",
          messageId: "correction",
          sourceAt: "2026-10-22T14:00:00.000Z",
          outcome: { kind: "invalid" as const, detail: "Invalid corrected outcome." },
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
