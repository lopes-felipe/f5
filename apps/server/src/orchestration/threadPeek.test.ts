import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readThreadPeek, readThreadPeeks } from "./threadPeek.ts";

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

  it.effect("reads several threads in the order asked and leaves out missing ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-11-01T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, default_model, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('peeks-project', 'Peeks', '/tmp', NULL, '[]', ${now}, ${now}, NULL)`;
      for (const [threadId, deletedAt] of [
        ["peeks-a", null],
        ["peeks-b", null],
        ["peeks-deleted", now],
      ] as const) {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
           archived_at, created_at, last_interaction_at, updated_at, deleted_at)
          VALUES (${threadId}, 'peeks-project', ${threadId}, 'gpt-5', NULL, NULL, NULL,
            NULL, ${now}, ${now}, ${now}, ${deletedAt})`;
      }
      yield* sql`INSERT INTO projection_thread_messages
        (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('peeks-a-u','peeks-a',NULL,'user','Prompt A',0,'1','1'),
          ('peeks-b-u','peeks-b',NULL,'user','Prompt B',0,'1','1')`;
      const ids = ["peeks-b", "peeks-missing", "peeks-a", "peeks-deleted", "peeks-b"].map((id) =>
        ThreadId.makeUnsafe(id),
      );
      const peeks = yield* readThreadPeeks(sql, ids);
      assert.deepStrictEqual(
        peeks.map((peek) => [peek.threadId, peek.lastUserText]),
        [
          ["peeks-b", "Prompt B"],
          ["peeks-a", "Prompt A"],
        ],
      );
      assert.deepStrictEqual(yield* readThreadPeeks(sql, []), []);
    }),
  );

  it.effect("reads each thread in a batch exactly as the single read does", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-11-01T00:00:00.000Z";
      const files = JSON.stringify([
        { path: "src/a.ts", kind: "modified", additions: 4, deletions: 1 },
      ]);
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, default_model, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('same-project', 'Same', '/tmp', NULL, '[]', ${now}, ${now}, NULL)`;
      // One thread mid-turn, one settled, one with a turn but no messages, one empty.
      for (const threadId of ["same-running", "same-settled", "same-turn-only", "same-empty"]) {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
           archived_at, created_at, last_interaction_at, updated_at, deleted_at)
          VALUES (${threadId}, 'same-project', ${threadId}, 'gpt-5', NULL, NULL, NULL,
            NULL, ${now}, ${now}, ${now}, NULL)`;
      }
      yield* sql`INSERT INTO projection_turns
        (thread_id,turn_id,state,requested_at,checkpoint_turn_count,checkpoint_ref,checkpoint_status,checkpoint_files_json)
        VALUES ('same-running','sr-1','completed','2026-11-01',1,'ref-1','ready',${files}),
          ('same-running','sr-2','running','2026-11-02',NULL,NULL,NULL,'[]'),
          ('same-settled','ss-1','completed','2026-11-01',1,'ref-1','ready',${files}),
          ('same-settled','ss-2','completed','2026-11-02',NULL,NULL,NULL,'[]'),
          ('same-turn-only','st-1','pending','2026-11-01',NULL,NULL,NULL,'[]')`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('sr-u1','same-running','sr-1','user','Running: first prompt',0,'1','1'),
          ('sr-a1','same-running','sr-1','assistant','Running: settled reply',0,'2','2'),
          ('sr-u2','same-running','sr-2','user','   ',0,'3','3'),
          ('sr-a2','same-running','sr-2','assistant','Running: commentary',0,'4','4'),
          ('sr-a3','same-running','sr-2','assistant','Running: streaming',1,'5','5'),
          ('ss-u1','same-settled','ss-1','user','Settled: first prompt',0,'1','1'),
          ('ss-a1','same-settled','ss-1','assistant','Settled: first reply',0,'2','2'),
          ('ss-u2','same-settled','ss-2','user','Settled: second prompt',0,'3','3'),
          ('ss-a2','same-settled','ss-2','assistant','Settled: second reply',0,'4','4'),
          ('ss-a3','same-settled',NULL,'assistant','Settled: note outside a turn',0,'5','5')`;
      const ids = ["same-running", "same-settled", "same-turn-only", "same-empty"].map((id) =>
        ThreadId.makeUnsafe(id),
      );
      const batch = yield* readThreadPeeks(sql, ids);
      const single = yield* Effect.forEach(ids, (threadId) => readThreadPeek(sql, threadId));
      assert.deepStrictEqual(batch, single);
      // The running turn's own messages are skipped for that thread only.
      assert.deepStrictEqual(
        batch.map((peek) => [peek.lastUserText, peek.lastAssistantText, peek.latestTurnDiff]),
        [
          [
            "Running: first prompt",
            "Running: settled reply",
            { files: 1, additions: 4, deletions: 1 },
          ],
          [
            "Settled: second prompt",
            "Settled: note outside a turn",
            { files: 1, additions: 4, deletions: 1 },
          ],
          [null, null, null],
          [null, null, null],
        ],
      );
    }),
  );
});
