import { CommandId, MessageId, ThreadId, type ThreadTurnStartCommand } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { makeNextTurnQueueStore } from "./nextTurnQueue.ts";

const layer = it.layer(SqlitePersistenceMemory);

function command(index: number, threadId = ThreadId.makeUnsafe("queue-thread")) {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(`queue-command-${index}`),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(`queue-message-${index}`),
      role: "user",
      text: `Turn ${index}`,
      attachments: [],
    },
    provider: "codex",
    model: "gpt-5.1-codex",
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt,
  } satisfies ThreadTurnStartCommand;
}

layer("NextTurnQueueStore", (it) => {
  it.effect("persists, edits, reorders, pauses, resumes, and cancels queued turns", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const firstId = CommandId.makeUnsafe("queue-item-1");
      const secondId = CommandId.makeUnsafe("queue-item-2");
      const first = command(1);
      const second = command(2);

      yield* store.enqueue({ itemId: firstId, command: first });
      yield* store.enqueue({ itemId: secondId, command: second });
      yield* store.update({ itemId: secondId, text: "Edited next turn" });
      yield* store.reorder({ threadId: first.threadId, orderedItemIds: [secondId, firstId] });
      yield* store.pause(secondId, "Previous turn failed.");

      const recreatedStore = yield* makeNextTurnQueueStore;
      const paused = yield* recreatedStore.list(first.threadId);
      assert.deepEqual(
        paused.map((item) => [item.itemId, item.position, item.status, item.command.message.text]),
        [
          [secondId, 0, "paused", "Edited next turn"],
          [firstId, 1, "queued", "Turn 1"],
        ],
      );

      yield* recreatedStore.resume(secondId);
      const resumed = yield* recreatedStore.list(first.threadId);
      assert.equal(resumed[0]?.status, "queued");
      assert.equal(resumed[0]?.allowAfterError, true);

      yield* recreatedStore.cancel(secondId);
      const remaining = yield* recreatedStore.list(first.threadId);
      assert.deepEqual(
        remaining.map((item) => [item.itemId, item.position]),
        [[firstId, 0]],
      );
    }),
  );

  it.effect("deduplicates retries by queue item ID and durable command ID", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const queuedCommand = command(3, ThreadId.makeUnsafe("queue-retry-thread"));
      const originalItemId = CommandId.makeUnsafe("queue-retry-item");

      yield* store.enqueue({ itemId: originalItemId, command: queuedCommand });
      yield* store.enqueue({ itemId: originalItemId, command: queuedCommand });
      yield* store.enqueue({
        itemId: CommandId.makeUnsafe("queue-retry-item-new-request"),
        command: queuedCommand,
      });

      const items = yield* store.list(queuedCommand.threadId);
      assert.equal(items.length, 1);
      assert.equal(items[0]?.itemId, originalItemId);
    }),
  );

  it.effect("persists the first dispatch time without replacing enqueue chronology", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const itemId = CommandId.makeUnsafe("queue-dispatch-time-item");
      const queuedCommand = command(4, ThreadId.makeUnsafe("queue-dispatch-time-thread"));
      const firstDispatchAt = "2026-01-01T00:01:00.000Z";
      const laterRetryAt = "2026-01-01T00:02:00.000Z";

      yield* store.enqueue({ itemId, command: queuedCommand });
      const firstDispatch = yield* store.prepareForDispatch(itemId, firstDispatchAt);

      const recreatedStore = yield* makeNextTurnQueueStore;
      const retryDispatch = yield* recreatedStore.prepareForDispatch(itemId, laterRetryAt);
      const queuedItems = yield* recreatedStore.list(queuedCommand.threadId);

      assert.equal(firstDispatch.createdAt, firstDispatchAt);
      assert.equal(retryDispatch.createdAt, firstDispatchAt);
      assert.equal(queuedItems[0]?.command.createdAt, queuedCommand.createdAt);
      assert.equal(queuedItems[0]?.createdAt !== firstDispatchAt, true);
    }),
  );
});
