import {
  type ChatAttachment,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  makeNextTurnQueueStore,
  MAX_QUEUED_TURNS_PER_THREAD,
  NextTurnQueueError,
} from "./nextTurnQueue.ts";

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

const manualBlocker = {
  code: "manual_pause" as const,
  message: "Previous turn failed.",
  resumable: true,
};

layer("NextTurnQueueStore", (it) => {
  it.effect("versions, edits, reorders, pauses, resumes, and cancels queued turns", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const firstId = CommandId.makeUnsafe("queue-item-1");
      const secondId = CommandId.makeUnsafe("queue-item-2");
      const first = command(1);
      const second = command(2);

      const firstSnapshot = yield* store.enqueue({ itemId: firstId, command: first });
      const secondSnapshot = yield* store.enqueue({ itemId: secondId, command: second });
      assert.equal(firstSnapshot.version, 1);
      assert.equal(secondSnapshot.version, 2);

      const edited = yield* store.update({
        itemId: secondId,
        threadId: first.threadId,
        expectedVersion: secondSnapshot.version,
        expectedRevision: 0,
        text: "Edited next turn",
      });
      assert.equal(edited.items[1]?.failurePolicy, "stop");

      const reordered = yield* store.reorder({
        threadId: first.threadId,
        expectedVersion: edited.version,
        orderedItemIds: [secondId, firstId],
      });
      const paused = yield* store.pause(secondId, manualBlocker);
      assert.isNotNull(paused);

      const recreatedStore = yield* makeNextTurnQueueStore;
      const recreated = yield* recreatedStore.getSnapshot(first.threadId);
      assert.equal(recreated.version, (paused?.version ?? reordered.version) + 0);
      assert.deepEqual(
        recreated.items.map((item) => [
          item.itemId,
          item.position,
          item.status,
          item.command.message.text,
        ]),
        [
          [secondId, 0, "paused", "Edited next turn"],
          [firstId, 1, "queued", "Turn 1"],
        ],
      );

      const resumed = yield* recreatedStore.resume({
        itemId: secondId,
        threadId: first.threadId,
        expectedVersion: recreated.version,
      });
      assert.equal(resumed.items[0]?.status, "queued");
      assert.equal(resumed.items[0]?.failurePolicy, "stop");

      const cancelled = yield* recreatedStore.cancel({
        itemId: secondId,
        threadId: first.threadId,
        expectedVersion: resumed.version,
      });
      assert.equal(cancelled.outcome, "cancelled");
      assert.deepEqual(
        cancelled.snapshot.items.map((item) => [item.itemId, item.position]),
        [[firstId, 0]],
      );
    }),
  );

  it.effect("deduplicates retries by queue item ID and durable command ID", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const queuedCommand = command(3, ThreadId.makeUnsafe("queue-retry-thread"));
      const originalItemId = CommandId.makeUnsafe("queue-retry-item");

      const inserted = yield* store.enqueue({ itemId: originalItemId, command: queuedCommand });
      const sameItem = yield* store.enqueue({ itemId: originalItemId, command: queuedCommand });
      const sameCommand = yield* store.enqueue({
        itemId: CommandId.makeUnsafe("queue-retry-item-new-request"),
        command: queuedCommand,
      });

      assert.equal(inserted.version, 1);
      assert.equal(sameItem.version, 1);
      assert.equal(sameCommand.version, 1);
      assert.equal(sameCommand.items.length, 1);
      assert.equal(sameCommand.items[0]?.itemId, originalItemId);
    }),
  );

  it.effect("resumes queue_paused rows created by the reliability migration", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const queuedCommand = command(3_030, ThreadId.makeUnsafe("queue-migrated-pause-thread"));
      const itemId = CommandId.makeUnsafe("queue-migrated-pause-item");
      const enqueued = yield* store.enqueue({ itemId, command: queuedCommand });
      const paused = yield* store.pause(itemId, {
        code: "queue_paused",
        message: "Queue is paused.",
        resumable: true,
      });
      assert.isNotNull(paused);

      const resumed = yield* store.resumeQueue({
        threadId: queuedCommand.threadId,
        expectedVersion: paused?.version ?? enqueued.version,
      });

      assert.equal(resumed.items[0]?.status, "queued");
      assert.isNull(resumed.items[0]?.blocker ?? null);
    }),
  );

  it.effect("enforces the per-thread queue limit without changing the accepted snapshot", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-limit-thread");
      for (let index = 0; index < MAX_QUEUED_TURNS_PER_THREAD; index += 1) {
        yield* store.enqueue({
          itemId: CommandId.makeUnsafe(`queue-limit-item-${index}`),
          command: command(index + 100, threadId),
        });
      }

      const overflow = store.enqueue({
        itemId: CommandId.makeUnsafe("queue-limit-overflow-item"),
        command: command(MAX_QUEUED_TURNS_PER_THREAD + 100, threadId),
      });
      const error = yield* Effect.flip(overflow);
      assert.equal(Schema.is(NextTurnQueueError)(error) ? error.code : null, "limit");

      const snapshot = yield* store.getSnapshot(threadId);
      assert.equal(snapshot.items.length, MAX_QUEUED_TURNS_PER_THREAD);
      assert.equal(snapshot.version, MAX_QUEUED_TURNS_PER_THREAD);
    }),
  );

  it.effect("clears optional execution overrides without changing queue policy", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const itemId = CommandId.makeUnsafe("queue-clear-overrides-item");
      const queuedCommand = {
        ...command(30, ThreadId.makeUnsafe("queue-clear-overrides-thread")),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.1-codex",
        },
        modelOptions: { codex: { reasoningEffort: "high" as const } },
      } satisfies ThreadTurnStartCommand;

      const inserted = yield* store.enqueue({ itemId, command: queuedCommand });
      const updated = yield* store.update({
        itemId,
        threadId: queuedCommand.threadId,
        expectedVersion: inserted.version,
        expectedRevision: 0,
        provider: null,
        model: null,
        modelSelection: null,
        modelOptions: null,
      });

      const item = updated.items[0];
      assert.isUndefined(item?.command.provider);
      assert.isUndefined(item?.command.model);
      assert.isUndefined(item?.command.modelSelection);
      assert.isUndefined(item?.command.modelOptions);
      assert.equal(item?.failurePolicy, "stop");
      assert.equal(item?.status, "queued");
    }),
  );

  it.effect("only allows attachment edits to remove files owned by the queue item", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const itemId = CommandId.makeUnsafe("queue-attachment-owner-item");
      const ownedAttachment = {
        type: "image",
        id: "queue-attachment-owner-thread-00000000-0000-0000-0000-000000000001",
        name: "owned.png",
        mimeType: "image/png",
        sizeBytes: 128,
      } satisfies ChatAttachment;
      const queuedCommand = {
        ...command(32, ThreadId.makeUnsafe("queue-attachment-owner-thread")),
        message: {
          ...command(32, ThreadId.makeUnsafe("queue-attachment-owner-thread")).message,
          attachments: [ownedAttachment],
        },
      } satisfies ThreadTurnStartCommand;
      const inserted = yield* store.enqueue({ itemId, command: queuedCommand });

      const forgedUpdate = store.update({
        itemId,
        threadId: queuedCommand.threadId,
        expectedVersion: inserted.version,
        expectedRevision: 0,
        attachments: [
          {
            ...ownedAttachment,
            id: "another-thread-00000000-0000-0000-0000-000000000002",
          },
        ],
      });
      const error = yield* Effect.flip(forgedUpdate);
      assert.equal(Schema.is(NextTurnQueueError)(error) ? error.code : null, "invalid_command");

      const unchanged = yield* store.getSnapshot(queuedCommand.threadId);
      assert.equal(unchanged.version, inserted.version);
      assert.deepEqual(unchanged.items[0]?.command.message.attachments, [ownedAttachment]);

      const removed = yield* store.update({
        itemId,
        threadId: queuedCommand.threadId,
        expectedVersion: unchanged.version,
        expectedRevision: 0,
        attachments: [],
      });
      assert.deepEqual(removed.items[0]?.command.message.attachments, []);
    }),
  );

  it.effect("advances the snapshot version for derived lifecycle changes", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const itemId = CommandId.makeUnsafe("queue-lifecycle-version-item");
      const queuedCommand = command(31, ThreadId.makeUnsafe("queue-lifecycle-version-thread"));
      const inserted = yield* store.enqueue({ itemId, command: queuedCommand });

      const touched = yield* store.touchVersion(queuedCommand.threadId);

      assert.equal(touched.version, inserted.version + 1);
      assert.equal(touched.items[0]?.revision, inserted.items[0]?.revision);
    }),
  );

  it.effect("atomically claims the head and rejects stale or too-late mutations", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const itemId = CommandId.makeUnsafe("queue-dispatch-time-item");
      const queuedCommand = command(4, ThreadId.makeUnsafe("queue-dispatch-time-thread"));
      const dispatchStartedAt = "2026-01-01T00:01:00.000Z";

      const inserted = yield* store.enqueue({ itemId, command: queuedCommand });
      const claimed = yield* store.claimHead(queuedCommand.threadId, dispatchStartedAt);
      assert.isNotNull(claimed);
      assert.equal(claimed?.status, "dispatching");
      assert.equal(claimed?.command.createdAt, dispatchStartedAt);

      const secondClaim = yield* store.claimHead(
        queuedCommand.threadId,
        "2026-01-01T00:02:00.000Z",
      );
      assert.isNull(secondClaim);

      const afterClaim = yield* store.getSnapshot(queuedCommand.threadId);
      const cancelled = yield* store.cancel({
        itemId,
        threadId: queuedCommand.threadId,
        expectedVersion: afterClaim.version,
      });
      assert.equal(cancelled.outcome, "too_late");
      assert.equal(cancelled.snapshot.items[0]?.status, "dispatching");

      const stale = store.update({
        itemId,
        threadId: queuedCommand.threadId,
        expectedVersion: inserted.version,
        expectedRevision: 0,
        text: "stale",
      });
      const error = yield* Effect.flip(stale);
      assert.equal(Schema.is(NextTurnQueueError)(error) ? error.code : null, "stale_version");
    }),
  );

  it.effect("keeps a claimed row until provider acceptance is completed", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const itemId = CommandId.makeUnsafe("queue-provider-receipt-item");
      const queuedCommand = command(5, ThreadId.makeUnsafe("queue-provider-receipt-thread"));

      yield* store.enqueue({ itemId, command: queuedCommand });
      yield* store.claimHead(queuedCommand.threadId, "2026-01-01T00:03:00.000Z");

      const recreatedStore = yield* makeNextTurnQueueStore;
      const beforeAcceptance = yield* recreatedStore.getSnapshot(queuedCommand.threadId);
      assert.equal(beforeAcceptance.items[0]?.status, "dispatching");

      yield* recreatedStore.complete(itemId);
      const afterAcceptance = yield* recreatedStore.getSnapshot(queuedCommand.threadId);
      assert.equal(afterAcceptance.items.length, 0);
      assert.equal(afterAcceptance.version, beforeAcceptance.version + 1);
    }),
  );

  it.effect("quarantines malformed envelopes without blocking the thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* makeNextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-quarantine-thread");
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO next_turn_queue (
          item_id,
          thread_id,
          command_id,
          position,
          status,
          failure_policy,
          revision,
          envelope_version,
          command_json,
          created_at,
          updated_at
        ) VALUES (
          'malformed-item',
          ${threadId},
          'malformed-command',
          0,
          'queued',
          'stop',
          0,
          999,
          '{not-json',
          ${now},
          ${now}
        )
      `;

      const snapshot = yield* store.getSnapshot(threadId);
      const quarantined = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM next_turn_queue_quarantine
        WHERE thread_id = ${threadId}
      `;

      assert.equal(snapshot.items.length, 0);
      assert.equal(snapshot.version, 1);
      assert.equal(quarantined[0]?.count, 1);
    }),
  );
});
