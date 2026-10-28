import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";
import { ServerConfig } from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { GitCore } from "../src/git/Services/GitCore.ts";
import { makeFakeGitCore } from "../src/git/testDoubles.ts";
import { canonicalJsonHash } from "../src/canonicalJsonHash.ts";
import { canonicalRequestHash } from "../src/nextTurnQueue/canonicalRequestHash.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundWorkLive } from "../src/orchestration/Layers/ThreadBackgroundWork.ts";
import { ThreadCommandExecutionQueryLive } from "../src/orchestration/Layers/ThreadCommandExecutionQuery.ts";
import { ThreadFileChangeQueryLive } from "../src/orchestration/Layers/ThreadFileChangeQuery.ts";
import { ProviderTurnDeliveryRepositoryLive } from "../src/orchestration/Layers/ProviderTurnDeliveryRepository.ts";
import { RuntimeReceiptBusLive } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueDispatcherLive } from "../src/nextTurnQueue/Layers/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStoreLive } from "../src/nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../src/nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../src/nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../src/persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadFileChangeRepositoryLive } from "../src/persistence/Layers/ProjectionThreadFileChanges.ts";
import { ProjectionThreadSessionRepositoryLive } from "../src/persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadRepositoryLive } from "../src/persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../src/persistence/Layers/ProjectionTurns.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { UsageFactRepositoryLive } from "../src/persistence/Layers/UsageFacts.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const at = new Date(Date.UTC(2026, 9, 7, 12)).toISOString();
const projectId = ProjectId.makeUnsafe("bound-project");
const threadId = ThreadId.makeUnsafe("bound-thread");
const live: ModelSelection = { instanceId: ProviderInstanceId.makeUnsafe("codex"), model: "gpt-5" };

const start = async (scheduledTasksEnabled: boolean) => {
  const unsupported = () =>
    Effect.die(new Error("No live provider call is permitted in this integration test")) as never;
  const provider: ProviderServiceShape = {
    startSession: unsupported,
    replaceSession: unsupported,
    sendTurn: unsupported,
    interruptTurn: unsupported,
    respondToRequest: unsupported,
    respondToUserInput: unsupported,
    respondToElicitation: unsupported,
    stopSession: unsupported,
    listStartingWorkspaces: () => Effect.succeed([]),
    listSessions: () => Effect.succeed([]),
    getSessionCapabilities: () => Effect.succeed(null),
    assertSessionAction: () => Effect.die(new Error("assertSessionAction is unused here")),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    readThread: () => Effect.succeed({ threadId, turns: [] }),
    rollbackConversation: unsupported,
    runOneOffPrompt: unsupported,
    compactConversation: unsupported,
    reloadMcpConfigForProject: unsupported,
    streamEvents: Stream.empty,
  };
  const persistence = Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "f5-bound-integration-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const store = NextTurnQueueStoreLive.pipe(Layer.provideMerge(persistence));
  const settings = ServerSettingsService.layerTest({
    scheduledTasks: { enabled: scheduledTasksEnabled },
  });
  const directory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
    Layer.provide(persistence),
  );
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(store),
  );
  const dependencies = Layer.mergeAll(
    engineLayer,
    directory,
    settings,
    Layer.succeed(ProviderService, provider),
    Layer.succeed(GitCore, makeFakeGitCore().service),
    ProviderTurnDeliveryRepositoryLive,
    RuntimeReceiptBusLive,
    ProjectionThreadRepositoryLive,
    ProjectionThreadSessionRepositoryLive,
    ProjectionTurnRepositoryLive,
    OrchestrationCommandReceiptRepositoryLive,
    UsageFactRepositoryLive,
    ThreadCommandExecutionQueryLive.pipe(
      Layer.provide(ProjectionThreadCommandExecutionRepositoryLive),
    ),
    ThreadFileChangeQueryLive.pipe(Layer.provide(ProjectionThreadFileChangeRepositoryLive)),
    ThreadBackgroundWorkLive.pipe(Layer.provide(directory)),
  ).pipe(Layer.provideMerge(store), Layer.provideMerge(persistence));
  const layer = NextTurnQueueDispatcherLive.pipe(Layer.provideMerge(dependencies));
  const runtime = ManagedRuntime.make(layer);
  const scope = await Effect.runPromise(Scope.make("sequential"));
  cleanup = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  };
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const dispatcher = await runtime.runPromise(Effect.service(NextTurnQueueDispatcher));
  const queue = await runtime.runPromise(Effect.service(NextTurnQueueStore));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("create-project"),
      projectId,
      title: "Bound project",
      workspaceRoot: process.cwd(),
      defaultModel: live.model,
      createdAt: at,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("create-thread"),
      threadId,
      projectId,
      title: "User conversation",
      model: live.model,
      modelSelection: live,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
    }),
  );
  // Creation does not record a model selection; a real conversation gains one with its
  // first message. Without it every bound item is canceled, so drift tests would pass vacuously.
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe("select-model"),
      threadId,
      modelSelection: live,
    }),
  );
  const turn = (
    id: string,
    text: string,
    modelSelection = live,
    runtimeMode: ThreadTurnStartCommand["runtimeMode"] = "approval-required",
  ): ThreadTurnStartCommand => ({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(id),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(`${id}-message`),
      role: "user",
      text,
      attachments: [],
    },
    model: modelSelection.model,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    createdAt: at,
  });
  /** A bound run that was admitted (capacity held) with `command` as its frozen settings. */
  const admitBound = async (command: ThreadTurnStartCommand) => {
    const snapshot = {
      id: "task",
      projectId,
      name: "Nightly",
      authority: { kind: "user" },
      workspace: { kind: "thread", threadId },
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sql`INSERT INTO scheduled_tasks(id,project_id,definition_json,request_hash,requested_at,version,enabled,updated_at)
          VALUES('task',${projectId},'{}','hash',${at},1,1,${at})`;
        yield* sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,command_json,command_hash,thread_id,submission_id,owns_execution,capacity,budget_consumed,submission_started,created_at)
          VALUES('run','task',${at},'manual','pending','{}',${JSON.stringify(snapshot)},${JSON.stringify(command)},${canonicalJsonHash(command)},${threadId},${command.commandId},1,1,1,1,${at})`;
        yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind)
          VALUES(${command.commandId},'run',${threadId},${command.message.messageId},'initial')`;
        yield* sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
      }),
    );
  };
  const enqueue = (command: ThreadTurnStartCommand) =>
    Effect.runPromise(
      queue.insertSubmission({
        submissionId: command.commandId,
        itemId: command.commandId,
        requestHash: canonicalRequestHash(command),
        command,
        atHead: false,
      }),
    );
  const run = async () => {
    await Effect.runPromise(dispatcher.start.pipe(Scope.provide(scope)));
    await Effect.runPromise(dispatcher.notify(threadId));
    await Effect.runPromise(dispatcher.drain);
  };
  const items = async () =>
    (await Effect.runPromise(queue.listByThread(threadId))).items.map((item) => item.itemId);
  const thread = async () =>
    (await Effect.runPromise(engine.getReadModel())).threads.find((t) => t.id === threadId)!;
  return { sql, turn, admitBound, enqueue, run, items, thread };
};

it("disabling the scheduler cancels a bound item without blocking or deleting the user's message", async () => {
  const f = await start(false);
  const bound = f.turn("bound", "Scheduled prompt");
  await f.admitBound(bound);
  await f.enqueue(bound);
  await f.enqueue(f.turn("user", "My own message"));
  await f.run();
  const remaining = await f.items();
  expect(remaining).not.toContain("bound");
  expect(remaining).toContain("user");
  const softDeleted = await Effect.runPromise(
    f.sql<{
      deleted: number;
    }>`SELECT deleted_at IS NOT NULL AS deleted FROM next_turn_queue WHERE item_id='bound'`,
  );
  expect(softDeleted).toEqual([{ deleted: 1 }]);
  // The user's message is the one that was sent.
  expect((await f.thread()).messages.map((message) => message.text)).toEqual(["My own message"]);
}, 15_000);

it("a bound item matching the conversation's live settings is sent", async () => {
  const f = await start(true);
  const bound = f.turn("bound", "Scheduled prompt");
  await f.admitBound(bound);
  await f.enqueue(bound);
  await f.run();
  expect((await f.thread()).messages.map((message) => message.text)).toEqual(["Scheduled prompt"]);
}, 15_000);

it("a settings change after the send gate rejects the turn instead of restoring its access", async () => {
  const f = await start(true);
  const bound = f.turn("bound", "Scheduled prompt", live, "full-access");
  await f.admitBound(bound);
  await f.enqueue(bound);
  await f.enqueue(f.turn("user", "My own message"));
  // The gate still sees the admitted access; the engine already has the user's restriction.
  await Effect.runPromise(
    f.sql`UPDATE projection_threads SET runtime_mode='full-access' WHERE thread_id=${threadId}`,
  );
  await f.run();
  expect(await f.items()).not.toContain("bound");
  const thread = await f.thread();
  expect(thread.runtimeMode).toBe("approval-required");
  expect(thread.messages.map((message) => message.text)).toEqual(["My own message"]);
}, 15_000);

it("settings drift cancels a bound item without reverting the conversation", async () => {
  const f = await start(true);
  const stale: ModelSelection = {
    instanceId: ProviderInstanceId.makeUnsafe("codex"),
    model: "old",
  };
  const bound = f.turn("bound", "Scheduled prompt", stale);
  await f.admitBound(bound);
  await f.enqueue(bound);
  await f.enqueue(f.turn("user", "My own message"));
  await f.run();
  expect(await f.items()).not.toContain("bound");
  const thread = await f.thread();
  expect(thread.modelSelection).toEqual(live);
  expect(thread.messages.map((message) => message.text)).toEqual(["My own message"]);
}, 15_000);
