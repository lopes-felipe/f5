import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readTurnAssistantMessages, resolveTurnAssistantMessage } from "./turnAssistantMessage.ts";

it("uses only the final completed text reply belonging to the requested turn", () => {
  const final = {
    id: "final",
    role: "assistant",
    turnId: "turn",
    text: "Final answer",
    streaming: false,
  };
  const messages = [
    { ...final, id: "commentary", text: "Working..." },
    final,
    { ...final, id: "reasoning-only", text: "", reasoningText: "Private reasoning" },
    { ...final, id: "unicode-blank", text: "\u00a0\ufeff" },
    { ...final, id: "streaming", streaming: true },
    { ...final, id: "another-turn", turnId: "other" },
    { ...final, id: "user", role: "user" },
  ];
  assert.strictEqual(resolveTurnAssistantMessage(messages, "turn"), final);
  assert.isUndefined(resolveTurnAssistantMessage(messages, "missing"));
});

it.layer(SqlitePersistenceMemory)("persisted turn reply ownership", (it) => {
  it.effect(
    "finds the actual reply without a pointer and cannot borrow another thread's message",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('commentary','a','shared-turn','assistant','Working',0,'1','1'),
          ('final','a','shared-turn','assistant','Final answer',0,'2','2'),
          ('reasoning','a','shared-turn','assistant','',0,'3','3'),
          ('unicode-blank','a','shared-turn','assistant',${"\u00a0\ufeff"},0,'3','3'),
          ('streaming','a','shared-turn','assistant','Not finished',1,'4','4'),
          ('other-thread','b','shared-turn','assistant','Wrong thread',0,'5','5'),
          ('other-turn','a','other','assistant','Wrong turn',0,'6','6')`;
        const replies = yield* readTurnAssistantMessages(sql, [
          { threadId: "a", turnId: "shared-turn" },
          { threadId: "b", turnId: "other" },
        ]);
        assert.deepStrictEqual(
          replies.map((reply) => reply.id),
          ["final"],
        );
      }),
  );
});
