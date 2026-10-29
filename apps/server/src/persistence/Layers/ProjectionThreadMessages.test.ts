import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect(
    "appends only to the exact message identity, preserves metadata and creation time, and supports reasoning-only deltas",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        const threadId = ThreadId.makeUnsafe("append-owner");
        const messageId = MessageId.makeUnsafe("append-message");
        const turnId = TurnId.makeUnsafe("append-turn");
        const createdAt = "2026-10-19T00:00:00.000Z";
        const updatedAt = "2026-10-19T00:00:01.000Z";
        const input = {
          threadId,
          messageId,
          turnId,
          role: "assistant" as const,
          delta: " \n",
          updatedAt,
        };
        assert.equal(yield* repository.appendStreamingText(input), 0);
        yield* repository.upsert({
          messageId,
          threadId,
          turnId,
          role: "assistant",
          text: "first",
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
          skillCall: { name: "review" },
          attachments: [
            { type: "image", id: "image", name: "image.png", mimeType: "image/png", sizeBytes: 5 },
          ],
        });
        for (const mismatch of [
          { threadId: ThreadId.makeUnsafe("another-thread") },
          { turnId: null },
          { turnId: TurnId.makeUnsafe("another-turn") },
          { role: "user" as const },
        ]) {
          assert.equal(yield* repository.appendStreamingText({ ...input, ...mismatch }), 0);
        }
        assert.equal(yield* repository.appendStreamingText(input), 1);
        const [plain] = yield* repository.listByThreadId({ threadId });
        assert.equal(plain?.text, "first \n");
        assert.equal(plain?.reasoningText, undefined);
        assert.equal(plain?.createdAt, createdAt);
        assert.equal(plain?.updatedAt, updatedAt);
        assert.equal(plain?.isStreaming, true);
        assert.deepEqual(plain?.skillCall, { name: "review" });
        assert.equal(plain?.attachments?.[0]?.name, "image.png");
        assert.equal(
          yield* repository.appendStreamingText({
            ...input,
            delta: "",
            reasoningDelta: "reason \n",
          }),
          1,
        );
        assert.equal(
          (yield* repository.listByThreadId({ threadId }))[0]?.reasoningText,
          "reason \n",
        );
        assert.deepEqual(
          yield* repository.listByThreadId({ threadId: ThreadId.makeUnsafe("another-thread") }),
          [],
        );
      }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-preserve-attachments");
      const messageId = MessageId.makeUnsafe("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-clear-attachments");
      const messageId = MessageId.makeUnsafe("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("preserves reasoning text when later upserts omit it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-preserve-reasoning");
      const messageId = MessageId.makeUnsafe("message-preserve-reasoning");
      const createdAt = "2026-02-28T19:20:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "answer",
        reasoningText: "thinking",
        isStreaming: true,
        createdAt,
        updatedAt: "2026-02-28T19:20:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "answer",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:20:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows[0]?.reasoningText, "thinking");
    }),
  );

  it.effect("accumulates reasoning tokens and keeps them across upserts and reverts", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-reasoning-tokens");
      const messageId = MessageId.makeUnsafe("message-reasoning-tokens");
      const createdAt = "2026-02-28T19:20:00.000Z";
      const upsert = (isStreaming: boolean, updatedAt: string) =>
        repository.upsert({
          messageId,
          threadId,
          turnId: null,
          role: "assistant",
          text: "answer",
          isStreaming,
          createdAt,
          updatedAt,
        });

      yield* upsert(true, "2026-02-28T19:20:01.000Z");
      yield* repository.addReasoningTokens({ messageId, threadId, tokens: 400, estimated: false });
      yield* repository.addReasoningTokens({ messageId, threadId, tokens: 100, estimated: true });
      yield* repository.addReasoningTokens({ messageId, threadId, tokens: 50, estimated: false });
      // A later upsert that omits the count keeps it.
      yield* upsert(false, "2026-02-28T19:20:02.000Z");

      const [row] = yield* repository.listByThreadId({ threadId });
      assert.equal(row?.reasoningTokens, 550);
      assert.equal(row?.reasoningTokensEstimated, true);

      // Revert re-inserts retained rows from what was read.
      yield* repository.deleteByThreadId({ threadId });
      yield* repository.upsert(row!);
      const [restored] = yield* repository.listByThreadId({ threadId });
      assert.equal(restored?.reasoningTokens, 550);
      assert.equal(restored?.reasoningTokensEstimated, true);
    }),
  );

  it.effect("round-trips skill call metadata", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-skill-call");
      const messageId = MessageId.makeUnsafe("message-skill-call");
      const createdAt = "2026-02-28T19:30:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "$review target",
        skillCall: { name: "review" },
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:30:01.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepEqual(rows[0]?.skillCall, { name: "review" });
    }),
  );

  it.effect("omits skill call metadata when absent", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-no-skill-call");
      const messageId = MessageId.makeUnsafe("message-no-skill-call");
      const createdAt = "2026-02-28T19:40:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "plain target",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:40:01.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows[0]?.skillCall, undefined);
    }),
  );
});
