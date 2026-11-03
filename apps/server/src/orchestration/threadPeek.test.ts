import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readThreadPeek } from "./threadPeek.ts";

it.layer(SqlitePersistenceMemory)("thread peek", (it) => {
  it.effect("returns nulls for a thread without messages or checkpoints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("empty");
      const peek = yield* readThreadPeek(sql, threadId);
      assert.deepStrictEqual(peek, {
        threadId,
        lastUserText: null,
        lastAssistantText: null,
        latestTurnDiff: null,
      });
    }),
  );

  it.effect(
    "reads the last prompt, the latest completed reply and the latest checkpoint's totals",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const files = (...counts: Array<[number, number]>) =>
          JSON.stringify(
            counts.map(([additions, deletions], index) => ({
              path: `src/file-${index}.ts`,
              kind: "modified",
              additions,
              deletions,
            })),
          );
        yield* sql`INSERT INTO projection_turns
          (thread_id,turn_id,state,requested_at,checkpoint_turn_count,checkpoint_ref,checkpoint_status,checkpoint_files_json)
          VALUES ('t','turn-1','completed','2026-11-01',1,'ref-1','ready',${files([1, 1])}),
            ('t','turn-2','completed','2026-11-02',2,'ref-2','ready',${files([10, 2], [3, 0])}),
            ('t','turn-3','running','2026-11-03',NULL,NULL,NULL,'[]'),
            ('other','turn-x','completed','2026-11-04',1,'ref-x','ready',${files([99, 99])})`;
        const longReply = "r".repeat(700);
        yield* sql`INSERT INTO projection_thread_messages
          (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
          VALUES ('u1','t','turn-1','user','First prompt',0,'1','1'),
            ('a1','t','turn-1','assistant','First reply',0,'2','2'),
            ('u2','t','turn-2','user',${"p".repeat(250)},0,'3','3'),
            ('a2','t','turn-2','assistant',${longReply},0,'4','4'),
            ('u3','t','turn-3','user','Still running',0,'5','5'),
            ('a3c','t','turn-3','assistant','Settled commentary in a running turn',0,'5.5','5.5'),
            ('a3','t','turn-3','assistant','Streaming text',1,'6','6'),
            ('u4','other','turn-x','user','Other thread',0,'7','7')`;
        const peek = yield* readThreadPeek(sql, ThreadId.makeUnsafe("t"));
        assert.strictEqual(peek.lastUserText, "Still running");
        // Everything from the running turn is skipped, settled commentary included.
        assert.strictEqual(peek.lastAssistantText, `${"r".repeat(599)}…`);
        assert.deepStrictEqual(peek.latestTurnDiff, { files: 2, additions: 13, deletions: 2 });

        yield* sql`UPDATE projection_thread_messages SET text = ${"p".repeat(250)} WHERE message_id = 'u3'`;
        const truncated = yield* readThreadPeek(sql, ThreadId.makeUnsafe("t"));
        assert.strictEqual(truncated.lastUserText, `${"p".repeat(199)}…`);
      }),
  );

  it.effect("shows an interrupted turn's reply, like the client's local peek", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // T1 completed, T2 interrupted, T3 running: the reply is T2's, the newest settled one.
      yield* sql`INSERT INTO projection_turns
        (thread_id,turn_id,state,requested_at,checkpoint_files_json)
        VALUES ('i','t1','completed','2026-11-01','[]'),
          ('i','t2','interrupted','2026-11-02','[]'),
          ('i','t3','running','2026-11-03','[]')`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('i-a1','i','t1','assistant','T1 reply',0,'1','1'),
          ('i-a2','i','t2','assistant','T2 partial reply',0,'2','2'),
          ('i-a3','i','t3','assistant','T3 commentary',0,'3','3')`;
      const running = yield* readThreadPeek(sql, ThreadId.makeUnsafe("i"));
      assert.strictEqual(running.lastAssistantText, "T2 partial reply");
      yield* sql`DELETE FROM projection_turns WHERE thread_id = 'i' AND turn_id = 't3'`;
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'i-a3'`;
      const interrupted = yield* readThreadPeek(sql, ThreadId.makeUnsafe("i"));
      assert.strictEqual(interrupted.lastAssistantText, "T2 partial reply");
    }),
  );
});
