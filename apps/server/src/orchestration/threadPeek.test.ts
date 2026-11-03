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
            ('a3','t','turn-3','assistant','Streaming text',1,'6','6'),
            ('u4','other','turn-x','user','Other thread',0,'7','7')`;
        const peek = yield* readThreadPeek(sql, ThreadId.makeUnsafe("t"));
        assert.strictEqual(peek.lastUserText, "Still running");
        // The running turn's streaming text is skipped for the latest completed reply.
        assert.strictEqual(peek.lastAssistantText, `${"r".repeat(599)}…`);
        assert.deepStrictEqual(peek.latestTurnDiff, { files: 2, additions: 13, deletions: 2 });

        yield* sql`UPDATE projection_thread_messages SET text = ${"p".repeat(250)} WHERE message_id = 'u3'`;
        const truncated = yield* readThreadPeek(sql, ThreadId.makeUnsafe("t"));
        assert.strictEqual(truncated.lastUserText, `${"p".repeat(199)}…`);
      }),
  );
});
