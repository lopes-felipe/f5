import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import fs from "node:fs";
import path from "node:path";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NextTurnQueueStore,
  type NextTurnQueueStoreShape,
} from "../Services/NextTurnQueueStore.ts";
import { NextTurnQueueStoreLive } from "./NextTurnQueueStore.ts";

const testLayer = NextTurnQueueStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-next-turn-queue-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = it.layer(testLayer);

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

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    yield* sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id, title, workspace_root, default_model, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (${ProjectId.makeUnsafe("queue-project")}, 'Queue project', '/tmp', NULL, '[]', ${now}, ${now}, NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
        archived_at, created_at, last_interaction_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, ${ProjectId.makeUnsafe("queue-project")}, 'Queue thread', 'gpt-5.1-codex',
        NULL, NULL, NULL, NULL, ${now}, ${now}, ${now}, NULL
      )
    `;
  });

const insert = (store: NextTurnQueueStoreShape, index: number, threadId: ThreadId) =>
  store.insertSubmission({
    submissionId: CommandId.makeUnsafe(`submission-${index}`),
    requestHash: `hash-${index}`,
    itemId: CommandId.makeUnsafe(`item-${index}`),
    command: command(index, threadId),
    atHead: false,
  });

layer("NextTurnQueueStore", (it) => {
  it.effect("uses CAS claims and rejects edits or cancellation while dispatching", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-cas-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 1, threadId);
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;

      const first = yield* store.claim({
        itemId: created.item.itemId,
        leaseOwner: "owner-1",
        now: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:11:00.000Z",
      });
      const second = yield* store.claim({
        itemId: created.item.itemId,
        leaseOwner: "owner-2",
        now: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:11:00.000Z",
      });
      assert.equal(first?.leaseOwner, "owner-1");
      assert.equal(second, null);

      const cancelError = yield* store
        .softDelete({ itemId: created.item.itemId })
        .pipe(Effect.flip);
      assert.equal(cancelError._tag, "NextTurnQueueItemDispatchingError");
      const updateError = yield* store
        .updateCommand({
          itemId: created.item.itemId,
          expectedUpdatedAt: first!.item.updatedAt,
          update: (value) => value,
        })
        .pipe(Effect.flip);
      assert.equal(updateError._tag, "NextTurnQueueItemDispatchingError");
    }),
  );

  it.effect("rotates attempt identities and keeps the submission identity", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-retry-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 2, threadId);
      if (created.kind !== "created") return;
      yield* store.markFailed({
        itemId: created.item.itemId,
        leaseOwner: null,
        errorCode: "rejected",
        errorDetail: "rejected",
      });
      const failed = yield* store.getItem(created.item.itemId);
      const retried = yield* store.retry({
        itemId: created.item.itemId,
        expectedUpdatedAt: failed!.updatedAt,
      });
      assert.notEqual(retried.command.commandId, created.item.command.commandId);
      assert.notEqual(retried.command.message.messageId, created.item.command.message.messageId);
      assert.equal(retried.submissionId, created.item.submissionId);
      assert.equal(retried.attemptCount, 0);
      assert.equal(retried.dispatchStartedAt, null);
    }),
  );

  it.effect(
    "replays identical submissions, rejects changed hashes, and keeps revisions monotonic",
    () =>
      Effect.gen(function* () {
        const store = yield* NextTurnQueueStore;
        const threadId = ThreadId.makeUnsafe("queue-ledger-thread");
        yield* seedThread(threadId);
        const created = yield* insert(store, 3, threadId);
        assert.equal(created.kind, "created");
        const replay = yield* insert(store, 3, threadId);
        assert.equal(replay.kind, "replay");
        const conflict = yield* store
          .insertSubmission({
            submissionId: CommandId.makeUnsafe("submission-3"),
            requestHash: "changed",
            itemId: CommandId.makeUnsafe("other-item"),
            command: command(4, threadId),
            atHead: false,
          })
          .pipe(Effect.flip);
        assert.equal(conflict._tag, "NextTurnQueueIdempotencyConflictError");

        const before = yield* store.listByThread(threadId);
        yield* store.clear({ threadId, scope: "all", expectedRevision: before.state.revision });
        const empty = yield* store.listByThread(threadId);
        yield* insert(store, 5, threadId);
        const refilled = yield* store.listByThread(threadId);
        assert.equal(empty.items.length, 0);
        assert.equal(refilled.state.revision > empty.state.revision, true);
      }),
  );

  it.effect("quarantines malformed JSON without re-reading the invalid payload in SQLite", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("queue-malformed-json-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 6, threadId);
      if (created.kind !== "created") return;

      yield* sql`
        UPDATE next_turn_queue SET command_json = '{malformed'
        WHERE item_id = ${created.item.itemId}
      `;

      const first = yield* store.listByThread(threadId);
      assert.equal(first.items.length, 0);
      assert.equal(first.quarantinedCount, 1);
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM next_turn_queue WHERE thread_id = ${threadId}
      `;
      assert.equal(remaining[0]?.count ?? -1, 0);

      const second = yield* store.listByThread(threadId);
      assert.equal(second.items.length, 0);
      assert.equal(second.quarantinedCount, 1);
    }),
  );

  it.effect("never regresses a started submission when a timeout settles it as queued", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-monotonic-ledger-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 7, threadId);
      if (created.kind !== "created") return;

      yield* store.settleSubmission({
        submissionId: created.item.submissionId,
        result: {
          disposition: "started",
          submissionId: created.item.submissionId,
          sequence: 42,
        },
      });
      const data = yield* store.listByThread(threadId);
      yield* store.settleSubmission({
        submissionId: created.item.submissionId,
        result: {
          disposition: "queued",
          submissionId: created.item.submissionId,
          itemId: created.item.itemId,
          snapshot: {
            threadId,
            items: data.items,
            revision: data.state.revision,
            paused: data.state.paused,
            blockedKind: null,
            reasonCode: null,
            reasonDetail: null,
            maxItems: 20,
            quarantinedCount: data.quarantinedCount,
          },
        },
      });

      const ledger = yield* store.getBySubmissionId(created.item.submissionId);
      assert.equal(ledger?.disposition, "started");
      assert.equal(ledger?.resultSequence, 42);
    }),
  );

  it.effect("rejects every mutation that could replace an accepted attempted item", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("queue-accepted-mutation-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 8, threadId);
      if (created.kind !== "created") return;
      const claimed = yield* store.claim({
        itemId: created.item.itemId,
        leaseOwner: "accepted-owner",
        now: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:11:00.000Z",
      });
      assert.equal(claimed !== null, true);
      yield* store.markFailed({
        itemId: created.item.itemId,
        leaseOwner: "accepted-owner",
        errorCode: "dispatch_rejected",
        errorDetail: "recovered after commit",
      });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error
        ) VALUES (
          ${created.item.command.commandId}, 'thread', ${threadId},
          ${new Date().toISOString()}, 9, 'accepted', NULL
        )
      `;
      const failed = yield* store.getItem(created.item.itemId);
      assert.equal(failed !== null, true);

      const updateError = yield* store
        .updateCommand({
          itemId: created.item.itemId,
          expectedUpdatedAt: failed!.updatedAt,
          update: (value) => ({ ...value, message: { ...value.message, text: "changed" } }),
        })
        .pipe(Effect.flip);
      assert.equal(updateError._tag, "NextTurnQueueItemAlreadyRanError");

      const retryError = yield* store
        .retry({ itemId: created.item.itemId, expectedUpdatedAt: failed!.updatedAt })
        .pipe(Effect.flip);
      assert.equal(retryError._tag, "NextTurnQueueItemAlreadyRanError");

      const cancelError = yield* store
        .softDelete({ itemId: created.item.itemId, expectedUpdatedAt: failed!.updatedAt })
        .pipe(Effect.flip);
      assert.equal(cancelError._tag, "NextTurnQueueItemAlreadyRanError");

      const queue = yield* store.listByThread(threadId);
      const clearError = yield* store
        .clear({ threadId, scope: "all", expectedRevision: queue.state.revision })
        .pipe(Effect.flip);
      assert.equal(clearError._tag, "NextTurnQueueItemAlreadyRanError");
      assert.equal((yield* store.getItem(created.item.itemId)) !== null, true);
    }),
  );

  it.effect("sweeps untracked staging files left before attachment metadata commits", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const config = yield* ServerConfig;
      const stagingDirectory = path.join(config.attachmentsDir, ".staging", "crashed-submission");
      const stagingFile = path.join(stagingDirectory, "private-image.png");
      fs.mkdirSync(stagingDirectory, { recursive: true });
      fs.writeFileSync(stagingFile, "private");
      assert.equal(fs.existsSync(stagingFile), true);

      yield* store.drainOrphanedAttachments;
      assert.equal(fs.existsSync(stagingFile), false);
    }),
  );

  it.effect("sweeps ingress files left after finalization but before queue admission", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const config = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("queue-crashed-ingress-thread");
      yield* seedThread(threadId);
      const attachmentId = "queue-crashed-ingress-00000000-0000-4000-8000-000000000001";
      const finalPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      const now = new Date().toISOString();
      fs.mkdirSync(config.attachmentsDir, { recursive: true });
      fs.writeFileSync(finalPath, "private");
      yield* sql`
        INSERT INTO attachments (
          attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
          staging_path, final_path, lifecycle, created_at, updated_at
        ) VALUES (
          ${attachmentId}, ${threadId}, 'image', 'private.png', 'image/png', 7,
          'private-hash', NULL, ${finalPath}, 'ready', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
        VALUES (${attachmentId}, 'ingress', 'crashed-command', ${now})
      `;

      yield* store.drainOrphanedAttachments;
      assert.equal(fs.existsSync(finalPath), false);
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ${attachmentId}
      `;
      assert.equal(rows[0]?.count ?? -1, 0);
    }),
  );
});
