import { ThreadId } from "@t3tools/contracts";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerSendText";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadFind } from "./threadFind.ts";

const layer = it.layer(SqlitePersistenceMemory);
const threadId = ThreadId.makeUnsafe("find-thread");

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      'find-project', 'Find Project', '/tmp/find-project', 'gpt-5.1-codex', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model, runtime_mode, interaction_mode,
      branch, worktree_path, created_at, last_interaction_at, updated_at, deleted_at
    ) VALUES (
      ${threadId}, 'find-project', 'Find', 'gpt-5.1-codex', 'approval-required', 'default',
      NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z', NULL
    )
  `;
  const messages = [
    ["image-only", "user", IMAGE_ONLY_BOOTSTRAP_PROMPT],
    ["reply", "assistant", "The attached image shows a login form."],
  ] as const;
  for (const [index, [messageId, role, text]] of messages.entries()) {
    const at = `2026-01-02T00:00:0${index + 1}.000Z`;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${messageId}, ${threadId}, 'turn-1', ${role}, ${text}, 0, ${at}, ${at})
    `;
  }
});

layer("threadFind", (it) => {
  it.effect("does not match the hidden prompt of an image-only message", () =>
    Effect.gen(function* () {
      yield* seed;
      const find = yield* makeThreadFind;
      const result = yield* find({ threadId, query: "attached image" });
      assert.strictEqual(result.totalMatches, 1);
      assert.strictEqual(result.match?.entryId, "reply");
      assert.strictEqual((yield* find({ threadId, query: "additional text" })).totalMatches, 0);
    }),
  );
});
