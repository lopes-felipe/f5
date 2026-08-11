import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderTurnDeliveryRepository } from "../../orchestration/Services/ProviderTurnDeliveryRepository.ts";
import { RuntimeReceiptBus } from "../../orchestration/Services/RuntimeReceiptBus.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NextTurnQueueDispatcher } from "../Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcherLive } from "./NextTurnQueueDispatcher.ts";
import { NextTurnQueueStoreLive } from "./NextTurnQueueStore.ts";

const dispatched: CommandId[] = [];

const dependencies = Layer.mergeAll(
  Layer.succeed(ProjectionThreadRepository, {
    getById: ({ threadId }: { threadId: ThreadId }) =>
      Effect.succeed(
        Option.some({ threadId, archivedAt: null, deletedAt: null, worktreePath: null }),
      ),
  } as never),
  Layer.succeed(ProjectionThreadSessionRepository, {
    getByThreadId: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(ProjectionTurnRepository, {
    getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
    getLatestRunningByThreadId: () => Effect.succeed(Option.none()),
    getLatestTerminalByThreadId: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(OrchestrationCommandReceiptRepository, {
    getByCommandId: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(ProviderTurnDeliveryRepository, {
    getByCommandId: () => Effect.succeed(null),
  } as never),
  Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: { readonly commandId: CommandId }) =>
      Effect.sync(() => {
        dispatched.push(command.commandId);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.empty,
  } as never),
  Layer.succeed(RuntimeReceiptBus, {
    publish: () => Effect.void,
    stream: Stream.empty,
  }),
);

const persistence = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-next-turn-dispatcher-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const storeLayer = NextTurnQueueStoreLive.pipe(Layer.provideMerge(persistence));
const testLayer = NextTurnQueueDispatcherLive.pipe(
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(dependencies),
);
const layer = it.layer(testLayer);

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    yield* sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id, title, workspace_root, default_model, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES ('queue-dispatcher-project', 'Queue project', '/tmp', NULL, '[]', ${now}, ${now}, NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
        archived_at, created_at, last_interaction_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, ${ProjectId.makeUnsafe("queue-dispatcher-project")}, 'Queue thread',
        'gpt-5.1-codex', NULL, NULL, NULL, NULL, ${now}, ${now}, ${now}, NULL
      )
    `;
  });

const insert = (index: number, threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* NextTurnQueueStore;
    return yield* store.insertSubmission({
      submissionId: CommandId.makeUnsafe(`dispatcher-submission-${index}`),
      requestHash: `dispatcher-hash-${index}`,
      itemId: CommandId.makeUnsafe(`dispatcher-item-${index}`),
      atHead: false,
      command: {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`dispatcher-command-${index}`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`dispatcher-message-${index}`),
          role: "user",
          text: `Turn ${index}`,
          attachments: [],
        },
        provider: "codex",
        model: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      },
    });
  });

layer("NextTurnQueueDispatcher", (it) => {
  it.effect("does not admit a later item after Resume while delivery recovery is unresolved", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-delivery-recovery-thread");
      yield* seedThread(threadId);
      const first = yield* insert(1, threadId);
      const second = yield* insert(2, threadId);
      if (first.kind !== "created" || second.kind !== "created") return;

      yield* store.markDeliveryFailed({
        commandId: first.item.command.commandId,
        errorCode: "delivery_rejected",
        errorDetail: "Provider rejected the first turn.",
      });
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;

      let queue = yield* store.listByThread(threadId);
      assert.deepEqual(dispatched, []);
      assert.equal(queue.state.paused, true);
      assert.equal(queue.state.pauseReasonCode, "delivery_rejected");
      assert.equal(queue.items[1]?.itemId, second.item.itemId);

      const promoteError = yield* dispatcher
        .promote({
          itemId: first.item.itemId,
          interruptActive: true,
          expectedRevision: queue.state.revision,
        })
        .pipe(Effect.flip);
      assert.match(promoteError.message, /Recheck, Retry, or Discard/u);

      // A generic Resume must not skip the failed head. Only an explicit
      // delivery recovery action may release the following turn.
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      assert.deepEqual(dispatched, []);

      yield* store.discardDelivery({ commandId: first.item.command.commandId });
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      queue = yield* store.listByThread(threadId);
      assert.deepEqual(dispatched, [second.item.command.commandId]);
      assert.equal(queue.items[0]?.status, "dispatching");
    }),
  );
});
