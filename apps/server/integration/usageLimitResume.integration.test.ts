import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { ServerConfig } from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { GitCore } from "../src/git/Services/GitCore.ts";
import { makeFakeGitCore } from "../src/git/testDoubles.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ThreadBackgroundWorkLive } from "../src/orchestration/Layers/ThreadBackgroundWork.ts";
import { ThreadCommandExecutionQueryLive } from "../src/orchestration/Layers/ThreadCommandExecutionQuery.ts";
import { ThreadFileChangeQueryLive } from "../src/orchestration/Layers/ThreadFileChangeQuery.ts";
import { ProviderTurnDeliveryRepositoryLive } from "../src/orchestration/Layers/ProviderTurnDeliveryRepository.ts";
import { RuntimeReceiptBusLive } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../src/orchestration/Services/ProviderRuntimeIngestion.ts";
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
import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

it("ingests a Claude subscription failure, schedules one durable head continue, and dispatches at reset plus 60 seconds", async () => {
  // Control wall-clock deadlines while leaving Effect worker timers live.
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.UTC(2026, 9, 7, 12);
  vi.setSystemTime(now);
  const at = new Date(now).toISOString();
  const reset = new Date(now + 2_000).toISOString();
  const target = new Date(now + 62_000).toISOString();
  const threadId = ThreadId.makeUnsafe("usage-integration-thread");
  const projectId = ProjectId.makeUnsafe("usage-integration-project");
  const turnId = TurnId.makeUnsafe("limited-turn");
  const instanceId = ProviderInstanceId.makeUnsafe("claude-default");
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const session: ProviderSession = {
    provider: "claudeAgent",
    threadId,
    status: "ready",
    runtimeMode: "approval-required",
    createdAt: at,
    updatedAt: at,
  };
  const unsupported = () =>
    Effect.die(new Error("No live provider call is permitted in this integration test")) as never;
  const provider: ProviderServiceShape = {
    startSession: unsupported,
    sendTurn: unsupported,
    interruptTurn: unsupported,
    respondToRequest: unsupported,
    respondToUserInput: unsupported,
    stopSession: unsupported,
    listSessions: () => Effect.succeed([session]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    readThread: () => Effect.succeed({ threadId, turns: [] }),
    rollbackConversation: unsupported,
    runOneOffPrompt: unsupported,
    compactConversation: unsupported,
    reloadMcpConfigForProject: unsupported,
    streamEvents: Stream.fromPubSub(events),
  };
  const persistence = Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "f5-usage-integration-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const store = NextTurnQueueStoreLive.pipe(Layer.provideMerge(persistence));
  const settings = ServerSettingsService.layerTest({ autoResumeUsageLimitedThreads: true });
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
  const layer = Layer.mergeAll(ProviderRuntimeIngestionLive, NextTurnQueueDispatcherLive).pipe(
    Layer.provideMerge(dependencies),
  );
  const runtime = ManagedRuntime.make(layer);
  const scope = await Effect.runPromise(Scope.make("sequential"));
  cleanup = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  };
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
  const dispatcher = await runtime.runPromise(Effect.service(NextTurnQueueDispatcher));
  const queue = await runtime.runPromise(Effect.service(NextTurnQueueStore));
  const sessionDirectory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("create-project"),
      projectId,
      title: "Usage project",
      workspaceRoot: process.cwd(),
      defaultModel: "claude-sonnet-4-6",
      createdAt: at,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("create-thread"),
      threadId,
      projectId,
      title: "Limited thread",
      model: "claude-sonnet-4-6",
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("seed-session"),
      threadId,
      session: {
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: at,
      },
      createdAt: at,
    }),
  );
  await Effect.runPromise(
    sessionDirectory.upsert({
      threadId,
      provider: "claudeAgent",
      providerInstanceId: instanceId,
      status: "running",
      runtimeMode: "approval-required",
      runtimePayload: { activeTurnId: turnId },
    }),
  );
  await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
  await Effect.runPromise(dispatcher.start.pipe(Scope.provide(scope)));
  const emit = async (type: ProviderRuntimeEvent["type"], eventId: string, payload: unknown) => {
    await Effect.runPromise(
      PubSub.publish(events, {
        type,
        eventId: EventId.makeUnsafe(eventId),
        provider: "claudeAgent",
        providerInstanceId: instanceId,
        threadId,
        turnId,
        createdAt: at,
        payload,
      } as ProviderRuntimeEvent),
    );
    await Effect.runPromise(ingestion.drain);
  };
  await emit("turn.started", "turn-started", {});
  await expect
    .poll(
      async () =>
        (await Effect.runPromise(engine.getReadModel())).threads[0]?.session?.activeTurnId,
    )
    .toBe(turnId);
  const usageLimit = {
    windows: [{ id: "five_hour", label: "5-hour", resetsAt: reset }],
    resetsAt: reset,
    resetSource: "provider",
    evidence: "typed",
  };
  await emit("runtime.error", "limit-error", {
    message: "Claude 5-hour usage limit reached",
    usageLimit,
  });
  await emit("turn.completed", "limit-completed", {
    state: "failed",
    errorMessage: "Claude 5-hour usage limit reached",
    usageLimit,
  });
  await expect
    .poll(async () => (await Effect.runPromise(queue.listByThread(threadId))).items.length)
    .toBe(1);
  // The checkpoint worker normally emits this after post-processing; this
  // fixture has no Git work, so finish that lifecycle through its real command.
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.turn.processing.quiesce",
      commandId: CommandId.makeUnsafe("quiesce-failed-turn"),
      threadId,
      turnId,
      processingQuiescedAt: at,
      createdAt: at,
    }),
  );
  await Effect.runPromise(dispatcher.drain);
  const limited = (await Effect.runPromise(engine.getReadModel())).threads[0]!;
  expect(limited.session?.usageLimit).toMatchObject({
    resetsAt: reset,
    turnId,
    providerInstanceId: instanceId,
  });
  const scheduled = await Effect.runPromise(queue.listByThread(threadId));
  expect(scheduled.items).toHaveLength(1);
  expect(scheduled.items[0]).toMatchObject({
    position: 0,
    scheduleReason: "usage_limit_reset",
    status: "queued",
    notBefore: target,
    command: { presentation: "continuation", message: { text: "continue", attachments: [] } },
  });
  const item = scheduled.items[0]!;
  expect(
    (await Effect.runPromise(engine.getReadModel())).threads[0]!.messages.some(
      (message) => message.id === item.command.message.messageId,
    ),
  ).toBe(false);
  vi.setSystemTime(now + 61_999);
  await Effect.runPromise(dispatcher.notify(threadId));
  await Effect.runPromise(dispatcher.drain);
  expect(
    (await Effect.runPromise(engine.getReadModel())).threads[0]!.messages.some(
      (message) => message.id === item.command.message.messageId,
    ),
  ).toBe(false);
  vi.setSystemTime(now + 62_000);
  await Effect.runPromise(dispatcher.notify(threadId));
  await Effect.runPromise(dispatcher.drain);
  const afterDeadline = await Effect.runPromise(dispatcher.getSnapshot(threadId));
  expect(afterDeadline).toMatchObject({
    paused: false,
    reasonCode: "dispatch_in_flight",
    items: [{ itemId: item.itemId, status: "dispatching", attemptCount: 1 }],
  });
  const continued = (await Effect.runPromise(engine.getReadModel())).threads[0]!;
  expect(
    continued.messages.filter((message) => message.id === item.command.message.messageId),
  ).toHaveLength(1);
  // A duplicate wake-up reuses the accepted command and cannot enqueue a second send.
  await Effect.runPromise(dispatcher.notify(threadId));
  await Effect.runPromise(dispatcher.drain);
  expect((await Effect.runPromise(queue.listByThread(threadId))).items).toMatchObject([
    { itemId: item.itemId, status: "dispatching", attemptCount: 1 },
  ]);
  expect(
    (await Effect.runPromise(engine.getReadModel())).threads[0]!.messages.filter(
      (message) => message.id === item.command.message.messageId,
    ),
  ).toHaveLength(1);
}, 15_000);
