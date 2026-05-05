import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationReadModel,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestrationFileChangeId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { ThreadCommandExecutionQueryLive } from "./ThreadCommandExecutionQuery.ts";
import { ThreadFileChangeQueryLive } from "./ThreadFileChangeQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadCommandExecutionQuery } from "../Services/ThreadCommandExecutionQuery.ts";
import { ThreadFileChangeQuery } from "../Services/ThreadFileChangeQuery.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../../persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadFileChangeRepositoryLive } from "../../persistence/Layers/ProjectionThreadFileChanges.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];
  const threadSnapshots = new Map<
    ThreadId,
    {
      readonly threadId: ThreadId;
      readonly turns: ReadonlyArray<{
        readonly id: TurnId;
        readonly items: ReadonlyArray<unknown>;
      }>;
    }
  >();

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    readThread: (threadId) =>
      Effect.succeed(
        threadSnapshots.get(threadId) ?? {
          threadId,
          turns: [],
        },
      ),
    rollbackConversation: () => unsupported(),
    runOneOffPrompt: () => unsupported(),
    compactConversation: () => unsupported(),
    reloadMcpConfigForProject: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const setThreadSnapshot = (snapshot: {
    readonly threadId: ThreadId;
    readonly turns: ReadonlyArray<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  }): void => {
    threadSnapshots.set(snapshot.threadId, snapshot);
  };

  return {
    service,
    emit,
    setSession,
    setThreadSnapshot,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProviderSessionDirectory
    | ThreadCommandExecutionQuery
    | ThreadFileChangeQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness() {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(
        ThreadCommandExecutionQueryLive.pipe(
          Layer.provideMerge(ProjectionThreadCommandExecutionRepositoryLive),
        ),
      ),
      Layer.provideMerge(
        ThreadFileChangeQueryLive.pipe(
          Layer.provideMerge(ProjectionThreadFileChangeRepositoryLive),
        ),
      ),
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const providerSessionDirectory = await runtime.runPromise(
      Effect.service(ProviderSessionDirectory),
    );
    const threadCommandExecutionQuery = await runtime.runPromise(
      Effect.service(ThreadCommandExecutionQuery),
    );
    const threadFileChangeQuery = await runtime.runPromise(Effect.service(ThreadFileChangeQuery));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      emit: provider.emit,
      providerSessionDirectory,
      setProviderSession: provider.setSession,
      setThreadSnapshot: provider.setThreadSnapshot,
      threadCommandExecutionQuery,
      threadFileChangeQuery,
      drain,
      workspaceRoot,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        totalCostUsd: 0.42,
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
    expect(thread.session?.turnCostUsd).toBe(0.42);
  });

  it("extracts provider-reported context tokens from non-Claude turn.completed usage", async () => {
    const harness = await createHarness();
    const completedAt = new Date().toISOString();

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-usage"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: completedAt,
      turnId: asTurnId("turn-usage"),
      payload: {
        state: "completed",
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 20,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.updatedAt === completedAt &&
        entry.session?.status === "ready" &&
        entry.estimatedContextTokens === 550,
    );

    expect(thread.session?.estimatedContextTokens).toBe(550);
    expect(thread.session?.tokenUsageSource).toBe("provider");
    expect(thread.estimatedContextTokens).toBe(550);
  });

  it("does not treat Claude turn.completed usage totals as context occupancy", async () => {
    const harness = await createHarness();
    const usageAt = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-claude"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      createdAt: usageAt,
      turnId: asTurnId("turn-usage"),
      payload: {
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 20,
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.updatedAt === usageAt &&
        entry.session?.estimatedContextTokens === 550 &&
        entry.session?.tokenUsageSource === "provider",
    );

    const completedAt = new Date().toISOString();
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-usage-claude"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      createdAt: completedAt,
      turnId: asTurnId("turn-usage"),
      payload: {
        state: "completed",
        usage: {
          input_tokens: 1_988,
          cache_creation_input_tokens: 125_731,
          cache_read_input_tokens: 1_100_202,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.updatedAt === completedAt && entry.session?.status === "ready",
    );

    expect(thread.session?.estimatedContextTokens).toBe(550);
    expect(thread.session?.tokenUsageSource).toBe("provider");
    expect(thread.estimatedContextTokens).toBe(550);
  });

  it("does not overwrite thread token usage when turn.completed omits usage", async () => {
    const harness = await createHarness();
    const completedAt = new Date().toISOString();

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-no-usage"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: completedAt,
      turnId: asTurnId("turn-no-usage"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.updatedAt === completedAt && entry.session?.status === "ready",
    );

    expect(thread.session?.estimatedContextTokens).toBeUndefined();
    expect(thread.session?.tokenUsageSource).toBeUndefined();
    expect(thread.estimatedContextTokens).toBeNull();
  });

  it("maps thread.token-usage.updated into a session token snapshot", async () => {
    const harness = await createHarness();
    const updatedAt = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: updatedAt,
      payload: {
        usage: {
          total_tokens: 900,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.updatedAt === updatedAt &&
        entry.session?.status === "ready" &&
        entry.estimatedContextTokens === 900,
    );

    expect(thread.session?.estimatedContextTokens).toBe(900);
    expect(thread.session?.tokenUsageSource).toBe("provider");
    expect(thread.estimatedContextTokens).toBe(900);
  });

  it("captures model context window tokens from session.configured metadata", async () => {
    const harness = await createHarness();
    const configuredAt = "2026-04-15T00:00:03.000Z";

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-session-configured-window"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: configuredAt,
      payload: {
        config: {
          model: "gpt-5.4",
          limits: {
            contextWindowTokens: 999_000,
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.updatedAt === configuredAt &&
        entry.session?.modelContextWindowTokens === 999_000 &&
        entry.modelContextWindowTokens === 999_000,
    );

    expect(thread.session?.modelContextWindowTokens).toBe(999_000);
    expect(thread.modelContextWindowTokens).toBe(999_000);
  });

  it("keeps the local hidden-context estimate when codex token updates undercount it", async () => {
    const harness = await createHarness();
    const estimatedAt = "2026-04-15T00:00:01.000Z";
    const updatedAt = "2026-04-15T00:00:02.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-estimated-floor"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          estimatedContextTokens: 1_500,
          tokenUsageSource: "estimated",
          updatedAt: estimatedAt,
        },
        createdAt: estimatedAt,
      }),
    );

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-floor"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: updatedAt,
      payload: {
        usage: {
          total_tokens: 8,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.updatedAt === updatedAt &&
        entry.session?.estimatedContextTokens === 1_500 &&
        entry.estimatedContextTokens === 1_500,
    );

    expect(thread.session?.estimatedContextTokens).toBe(1_500);
    expect(thread.session?.tokenUsageSource).toBe("estimated");
    expect(thread.estimatedContextTokens).toBe(1_500);
  });

  it("allows Claude token usage snapshots to correct stale higher estimates", async () => {
    const harness = await createHarness();
    const estimatedAt = "2026-04-15T00:00:03.000Z";
    const updatedAt = "2026-04-15T00:00:04.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-claude-stale-usage"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          estimatedContextTokens: 1_227_921,
          tokenUsageSource: "provider",
          updatedAt: estimatedAt,
        },
        createdAt: estimatedAt,
      }),
    );

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-claude-correction"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      createdAt: updatedAt,
      payload: {
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 20,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.updatedAt === updatedAt &&
        entry.session?.estimatedContextTokens === 550 &&
        entry.estimatedContextTokens === 550,
    );

    expect(thread.session?.estimatedContextTokens).toBe(550);
    expect(thread.session?.tokenUsageSource).toBe("provider");
    expect(thread.estimatedContextTokens).toBe(550);
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("updates the thread model from provider session.configured payloads", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-session-configured-model"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        config: {
          model: "claude-haiku-4-5",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.model === "claude-haiku-4-5",
    );
    expect(thread.model).toBe("claude-haiku-4-5");
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        model: "gpt-5-codex",
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        model: "gpt-5-codex",
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: "codex",
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        model: "gpt-5-codex",
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("backfills a missing Codex assistant message from the provider thread snapshot on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        runtimeMode: "approval-required",
        resumeCursor: {
          threadId: "provider-thread-snapshot-backfill",
        },
      }),
    );

    harness.setThreadSnapshot({
      threadId: asThreadId("thread-1"),
      turns: [
        {
          id: asTurnId("turn-snapshot-backfill"),
          items: [
            {
              type: "agentMessage",
              id: "item-snapshot-backfill",
              content: [{ type: "text", text: "snapshot pong" }],
            },
          ],
        },
      ],
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-snapshot-backfill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-snapshot-backfill"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-snapshot-backfill",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-snapshot-backfill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-snapshot-backfill"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-snapshot-backfill" &&
            !message.streaming &&
            message.text === "snapshot pong",
        ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-snapshot-backfill",
    );
    expect(message?.text).toBe("snapshot pong");
    expect(message?.streaming).toBe(false);
  });

  it("reconciles a missing Codex assistant message from the provider thread snapshot on thread restart", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        runtimeMode: "approval-required",
        status: "stopped",
        resumeCursor: {
          threadId: "provider-thread-restart",
        },
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-reconcile"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-restart-reconcile"),
          role: "user",
          text: "resume the thread",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-restart-reconcile"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-restart-reconcile"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-restart-reconcile",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-restart-reconcile"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-restart-reconcile"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.latestTurn?.turnId === "turn-restart-reconcile" &&
        !thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-restart-reconcile",
        ),
    );

    harness.setThreadSnapshot({
      threadId: asThreadId("thread-1"),
      turns: [
        {
          id: asTurnId("turn-restart-reconcile"),
          items: [
            {
              type: "agentMessage",
              id: "item-restart-reconcile",
              content: [{ type: "text", text: "restart snapshot pong" }],
            },
          ],
        },
      ],
    });

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-restart-reconcile"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        providerThreadId: "provider-thread-restart",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-restart-reconcile" &&
          !message.streaming &&
          message.text === "restart snapshot pong",
      ),
    );

    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-restart-reconcile",
    );
    expect(message?.text).toBe("restart snapshot pong");
    expect(message?.streaming).toBe(false);

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-after-restart-reconcile"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-restart-reconcile"),
      itemId: asItemId("item-restart-reconcile"),
      payload: {
        streamKind: "assistant_text",
        delta: " ignored suffix",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-after-restart-reconcile"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-restart-reconcile"),
      itemId: asItemId("item-restart-reconcile"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "restart snapshot pong ignored suffix",
      },
    });

    await harness.drain();

    const postLateEventThread = await Effect.runPromise(harness.engine.getReadModel()).then(
      (readModel) => readModel.threads.find((entry) => entry.id === asThreadId("thread-1")),
    );
    const assistantMessages =
      postLateEventThread?.messages.filter(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-restart-reconcile",
      ) ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("restart snapshot pong");
    expect(assistantMessages[0]?.streaming).toBe(false);
  });

  it("ignores stale late assistant deltas after an assistant message is completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-snapshot-suffix"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-snapshot-suffix"),
          role: "user",
          text: "finish the answer",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-late-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-delta"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-late-delta",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-late-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-delta"),
      itemId: asItemId("item-late-delta"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-late-delta" &&
          message.streaming &&
          message.text === "hello",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-late-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-delta"),
      itemId: asItemId("item-late-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-late-delta" &&
          !message.streaming &&
          message.text === "hello",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-late-delta-stale"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-delta"),
      itemId: asItemId("item-late-delta"),
      payload: {
        streamKind: "assistant_text",
        delta: " stale",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    const message = thread?.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-late-delta",
    );
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("preserves requested permission profiles on approval activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-permissions-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-permissions"),
      payload: {
        requestType: "permissions_approval",
        detail: "Network access requested",
        requestedPermissions: {
          network: true,
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-permissions-request-opened",
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-permissions-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;

    expect(requested?.summary).toBe("Permission approval requested");
    expect(requestedPayload?.requestKind).toBe("permission");
    expect(requestedPayload?.requestedPermissions).toEqual({ network: true });
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session.configured into a runtime.configured activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-session-configured-runtime"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        config: {
          model: "claude-haiku-4-5",
          claude_code_version: "2.1.80",
          session_id: "session-123",
          fast_mode_state: "off",
          effort: "max",
          reasoning: "high",
          context_window: "200k",
          thinking_state: "on",
          output_style: "default",
          slashCommands: [
            {
              name: "review",
              description: "Review the current diff",
              argumentHint: "<target>",
            },
          ],
          instructionProfile: {
            contractVersion: "v2",
            providerSupplementVersion: "v1",
            strategy: "claude.append_system_prompt",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-session-configured-runtime" &&
          activity.kind === "runtime.configured",
      ),
    );
    const activity = thread.activities.find(
      (entry) => entry.id === "evt-session-configured-runtime",
    );
    expect(activity?.payload).toMatchObject({
      model: "claude-haiku-4-5",
      claudeCodeVersion: "2.1.80",
      sessionId: "session-123",
      fastModeState: "off",
      effort: "max",
      reasoning: "high",
      contextWindow: "200k",
      thinkingState: "on",
      outputStyle: "default",
      slashCommands: [
        {
          name: "review",
          description: "Review the current diff",
          argumentHint: "<target>",
        },
      ],
      instructionContractVersion: "v2",
      instructionSupplementVersion: "v1",
      instructionStrategy: "claude.append_system_prompt",
    });
    expect(activity?.payload).not.toHaveProperty("config");
  });

  it("preserves Codex slashCommands in runtime.configured activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-session-configured-runtime-codex"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        config: {
          model: "gpt-5.4",
          slashCommands: [
            {
              name: "review",
              description: "Review the current diff",
            },
          ],
          instructionProfile: {
            contractVersion: "v2",
            providerSupplementVersion: "v1",
            strategy: "codex.append_developer_prompt",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-session-configured-runtime-codex" &&
          activity.kind === "runtime.configured",
      ),
    );
    const activity = thread.activities.find(
      (entry) => entry.id === "evt-session-configured-runtime-codex",
    );
    expect(activity?.payload).toMatchObject({
      model: "gpt-5.4",
      slashCommands: [
        {
          name: "review",
          description: "Review the current diff",
        },
      ],
      instructionContractVersion: "v2",
      instructionSupplementVersion: "v1",
      instructionStrategy: "codex.append_developer_prompt",
    });
  });

  it("projects hook lifecycle diagnostics into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "hook.started",
      eventId: asEventId("evt-hook-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook"),
      payload: {
        hookId: "hook-1",
        hookName: "pre_tool_use",
        hookEvent: "pre_tool_use",
      },
      raw: {
        source: "codex.app-server.notification",
        method: "hook/started",
        payload: {
          run: {
            eventName: "pre_tool_use",
            statusMessage: "Preparing tool",
            sourcePath: "/tmp/hooks/pre-tool-use.sh",
          },
        },
      },
    });
    harness.emit({
      type: "hook.completed",
      eventId: asEventId("evt-hook-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook"),
      payload: {
        hookId: "hook-1",
        outcome: "error",
        output: `Hook failed\n\n${"x".repeat(220)}`,
      },
      raw: {
        source: "codex.app-server.notification",
        method: "hook/completed",
        payload: {
          run: {
            eventName: "pre_tool_use",
            status: "failed",
            statusMessage: "Hook failed",
            sourcePath: "/tmp/hooks/pre-tool-use.sh",
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-started",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-completed",
        ),
    );

    const started = thread.activities.find((activity) => activity.id === "evt-hook-started");
    expect(started).toMatchObject({
      kind: "hook.started",
      tone: "info",
      summary: "Running pre_tool_use hook: Preparing tool",
    });
    expect(started?.payload).toMatchObject({
      sourcePath: "/tmp/hooks/pre-tool-use.sh",
      detail: "Source: /tmp/hooks/pre-tool-use.sh",
    });

    const completed = thread.activities.find((activity) => activity.id === "evt-hook-completed");
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;
    expect(completed).toMatchObject({
      kind: "hook.completed",
      tone: "error",
      summary: "pre_tool_use hook (failed)",
    });
    const completedDetail =
      completedPayload && typeof completedPayload.detail === "string"
        ? completedPayload.detail
        : null;
    expect(completedDetail).not.toBeNull();
    expect(completedDetail?.endsWith("...")).toBe(true);
  });

  it("projects MCP, config, and deprecation diagnostics into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "mcp.status.updated",
      eventId: asEventId("evt-mcp-status"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        status: {
          name: "filesystem",
          status: "failed",
          error: "connection refused",
        },
      },
    });
    harness.emit({
      type: "mcp.oauth.completed",
      eventId: asEventId("evt-mcp-oauth"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        success: false,
        name: "filesystem",
        error: "oauth failed",
      },
    });
    harness.emit({
      type: "config.warning",
      eventId: asEventId("evt-config-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        summary: "Configuration warning",
        details: "Unsupported key",
        path: "/tmp/config.toml",
      },
    });
    harness.emit({
      type: "deprecation.notice",
      eventId: asEventId("evt-deprecation"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        summary: "Deprecated setting",
        details: "Use the new config key instead.",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-mcp-status",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-config-warning",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-deprecation",
        ),
    );

    expect(thread.activities.find((activity) => activity.id === "evt-mcp-status")).toMatchObject({
      kind: "mcp.status.updated",
      tone: "error",
      summary: "MCP server filesystem: failed",
      payload: {
        error: "connection refused",
        detail: "connection refused",
      },
    });
    expect(thread.activities.find((activity) => activity.id === "evt-mcp-oauth")).toMatchObject({
      kind: "mcp.oauth.completed",
      tone: "error",
      payload: {
        error: "oauth failed",
        detail: "oauth failed",
      },
    });
    expect(
      thread.activities.find((activity) => activity.id === "evt-config-warning"),
    ).toMatchObject({
      kind: "config.warning",
      tone: "info",
      summary: "Configuration warning",
      payload: {
        detail: "Unsupported key\n\nPath: /tmp/config.toml",
      },
    });
    expect(thread.activities.find((activity) => activity.id === "evt-deprecation")).toMatchObject({
      kind: "deprecation.notice",
      tone: "info",
      summary: "Deprecated setting",
      payload: {
        detail: "Use the new config key instead.",
      },
    });
  });

  it("ignores account diagnostics when projecting thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "account.updated",
      eventId: asEventId("evt-account-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        account: {
          plan: "pro",
        },
      },
    });
    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-rate-limits-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        rateLimits: {
          remaining: 42,
        },
      },
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));

    expect(thread?.activities.some((activity) => activity.id === "evt-account-updated")).toBe(
      false,
    );
    expect(thread?.activities.some((activity) => activity.id === "evt-rate-limits-updated")).toBe(
      false,
    );
  });

  it("updates the thread model and emits activity when the provider reroutes the model", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "model.rerouted",
      eventId: asEventId("evt-model-rerouted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        fromModel: "gpt-5.3-codex",
        toModel: "gpt-5.4",
        reason: "capacity",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.model === "gpt-5.4" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-model-rerouted" && activity.kind === "runtime.model-rerouted",
        ),
    );
    expect(thread.model).toBe("gpt-5.4");
    const activity = thread.activities.find((entry) => entry.id === "evt-model-rerouted");
    expect(activity?.payload).toMatchObject({
      fromModel: "gpt-5.3-codex",
      toModel: "gpt-5.4",
      reason: "capacity",
    });
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("forwards requestKind from item.started events onto tool.started activity payloads", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-rk"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-rk"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started-rk"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-rk"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "in_progress",
        title: "File read",
        detail: "apps/server/package.json",
        requestKind: "file-read",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    );

    const toolStarted = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
    );
    expect(toolStarted).toBeDefined();
    expect((toolStarted?.payload as { requestKind?: string } | undefined)?.requestKind).toBe(
      "file-read",
    );
  });

  it("compacts Claude read lifecycle payloads into read-path hints", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-claude-read-compact"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-read-compact"),
      itemId: asItemId("item-claude-read-compact"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        detail: "apps/server/package.json",
        requestKind: "file-read",
        data: {
          toolName: "Read",
          input: {
            file_path: "apps/server/package.json",
            offset: 12,
            limit: 1,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-read-compact",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-claude-read-compact",
    );
    expect(activity?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      providerItemId: "item-claude-read-compact",
      title: "Read file",
      detail: "apps/server/package.json",
      requestKind: "file-read",
      readPaths: ["apps/server/package.json"],
      lineSummary: "line 12",
    });
  });

  it("compacts Claude search and LS lifecycle payloads into normalized display hints", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-claude-grep-compact"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-grep-compact"),
      itemId: asItemId("item-claude-grep-compact"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          toolName: "Grep",
          input: {
            pattern: "CommandTranscriptCard",
            path: "apps/web/src/components/chat",
          },
        },
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-claude-ls-compact"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-ls-compact"),
      itemId: asItemId("item-claude-ls-compact"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          toolName: "LS",
          input: {
            path: "apps/web/src/components",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-ls-compact",
      ),
    );

    const grepActivity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-claude-grep-compact",
    );
    expect(grepActivity?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Searching apps/web/src/components/chat for CommandTranscriptCard",
      searchSummary: "Searching apps/web/src/components/chat for CommandTranscriptCard",
    });

    const lsActivity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-claude-ls-compact",
    );
    expect(lsActivity?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "List directory",
    });
  });

  it("refreshes persisted Claude resume cursors from thread.started events", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const staleResumeCursor = {
      threadId,
      resume: "11111111-1111-4111-8111-111111111111",
      resumeSessionAt: "assistant-1",
      turnCount: 1,
      approximateConversationChars: 128,
      compactionRecommendationEmitted: false,
    };

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        resumeCursor: staleResumeCursor,
      }),
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-claude-thread-started"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      payload: {
        providerThreadId: "550e8400-e29b-41d4-a716-446655440000",
      },
    });

    await harness.drain();

    const binding = await Effect.runPromise(harness.providerSessionDirectory.getBinding(threadId));
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.provider).toBe("claudeAgent");
      expect(binding.value.resumeCursor).toEqual({
        ...staleResumeCursor,
        threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
      });
    }
  });

  it("preserves the existing Claude resume cursor when thread.started reports a synthetic placeholder id", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const existingResumeCursor = {
      threadId,
      resume: "11111111-1111-4111-8111-111111111111",
      resumeSessionAt: "assistant-1",
      turnCount: 1,
      approximateConversationChars: 128,
      compactionRecommendationEmitted: false,
    };

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        resumeCursor: existingResumeCursor,
      }),
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-claude-thread-started-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      payload: {
        providerThreadId: "claude-thread-placeholder",
      },
    });

    await harness.drain();

    const binding = await Effect.runPromise(harness.providerSessionDirectory.getBinding(threadId));
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.provider).toBe("claudeAgent");
      expect(binding.value.resumeCursor).toEqual({
        ...existingResumeCursor,
        threadId,
      });
    }
  });

  it("preserves the existing Claude resume cursor when thread.started reports a non-UUID session id", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const existingResumeCursor = {
      threadId,
      resume: "11111111-1111-4111-8111-111111111111",
      resumeSessionAt: "assistant-1",
      turnCount: 1,
      approximateConversationChars: 128,
      compactionRecommendationEmitted: false,
    };

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        resumeCursor: existingResumeCursor,
      }),
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-claude-thread-started-invalid"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      payload: {
        providerThreadId: "actual-claude-session-id",
      },
    });

    await harness.drain();

    const binding = await Effect.runPromise(harness.providerSessionDirectory.getBinding(threadId));
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.provider).toBe("claudeAgent");
      expect(binding.value.resumeCursor).toEqual({
        ...existingResumeCursor,
        threadId,
      });
    }
  });

  it("preserves existing non-Claude resume cursor fields when thread.started refreshes threadId", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const staleResumeCursor = {
      threadId: "provider-thread-old",
      checkpointRef: "checkpoint-123",
      extraState: {
        stable: true,
      },
    };

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId,
        provider: "codex",
        runtimeMode: "approval-required",
        resumeCursor: staleResumeCursor,
      }),
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-codex-thread-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      payload: {
        providerThreadId: "provider-thread-new",
      },
    });

    await harness.drain();

    const binding = await Effect.runPromise(harness.providerSessionDirectory.getBinding(threadId));
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.resumeCursor).toEqual({
        ...staleResumeCursor,
        threadId: "provider-thread-new",
      });
    }
  });

  it("ignores thread.started resume cursor refreshes when providerThreadId is empty", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const existingResumeCursor = {
      threadId: "provider-thread-existing",
      opaque: "cursor-1",
    };

    await Effect.runPromise(
      harness.providerSessionDirectory.upsert({
        threadId,
        provider: "codex",
        runtimeMode: "approval-required",
        resumeCursor: existingResumeCursor,
      }),
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-empty-provider-id"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      payload: {
        providerThreadId: "   ",
      },
    });

    await harness.drain();

    const binding = await Effect.runPromise(harness.providerSessionDirectory.getBinding(threadId));
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.resumeCursor).toEqual(existingResumeCursor);
    }
  });

  it("stores compact changed-file previews for file-change tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        data: {
          item: {
            changes: [{ path: "README.md" }],
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-completed",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-file-change-completed",
    );
    expect(activity?.payload).toMatchObject({
      itemType: "file_change",
      status: "completed",
      title: "File change",
      changedFiles: ["README.md"],
    });
    expect(activity?.payload).not.toHaveProperty("data");
  });

  it("stores compact command previews for command tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed-preview"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-preview"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        data: {
          item: {
            command: ["bun", "run", "lint"],
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed-preview",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed-preview",
    );
    expect(activity?.payload).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
      command: "bun run lint",
    });
    expect(activity?.payload).not.toHaveProperty("data");
  });

  it("canonicalizes grep-style search command titles for activities and command executions", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const command =
      "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 300";
    const summary =
      "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …";

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-command-search-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-search"),
      itemId: asItemId("item-command-search"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Ran command",
        detail: command,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-search-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-search"),
      itemId: asItemId("item-command-search"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: command,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-search-completed",
      ),
    );

    const updatedActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-search-updated",
    );
    const completedActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-search-completed",
    );

    expect(updatedActivity?.summary).toBe(summary);
    expect(updatedActivity?.payload).toMatchObject({
      itemType: "command_execution",
      title: summary,
      detail: command,
    });
    expect(completedActivity?.summary).toBe(summary);
    expect(completedActivity?.payload).toMatchObject({
      itemType: "command_execution",
      title: summary,
      detail: command,
    });

    const result = await Effect.runPromise(
      harness.threadCommandExecutionQuery.getThreadCommandExecutions({
        threadId: asThreadId("thread-1"),
      }),
    );

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.title).toBe(summary);
    expect(result.executions[0]?.command).toBe(command);
  });

  it("preserves explicit provider titles for grep-style search commands", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const command = 'git grep -n "CommandTranscriptCard"';

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-search-provider-title"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-search-provider-title"),
      itemId: asItemId("item-command-search-provider-title"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Search workspace",
        detail: command,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-search-provider-title",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-search-provider-title",
    );
    expect(activity?.summary).toBe("Search workspace");
    expect(activity?.payload).toMatchObject({
      itemType: "command_execution",
      title: "Search workspace",
      detail: command,
    });

    const result = await Effect.runPromise(
      harness.threadCommandExecutionQuery.getThreadCommandExecutions({
        threadId: asThreadId("thread-1"),
      }),
    );

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.title).toBe("Search workspace");
  });

  it("captures late command output deltas that arrive after item completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-command-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      payload: {},
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Ran command",
        detail: "/bin/zsh -lc 'uname -a'",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "/bin/zsh -lc 'uname -a'",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        streamKind: "command_output",
        delta: "Darwin kernel-version\n",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-command-turn-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      payload: {
        state: "completed",
      },
    });

    await harness.drain();

    const result = await Effect.runPromise(
      harness.threadCommandExecutionQuery.getThreadCommandExecutions({
        threadId: asThreadId("thread-1"),
      }),
    );

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.command).toBe("/bin/zsh -lc 'uname -a'");
    expect(result.executions[0]?.cwd).toBe(harness.workspaceRoot);
    const detail = await Effect.runPromise(
      harness.threadCommandExecutionQuery.getThreadCommandExecution({
        threadId: asThreadId("thread-1"),
        commandExecutionId: result.executions[0]!.id,
      }),
    );
    expect(detail.commandExecution?.output).toContain("Darwin kernel-version");
  });

  it("captures command output deltas that arrive before the lifecycle record", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-command-early-output-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-early-output"),
      payload: {},
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-early-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-early-output"),
      itemId: asItemId("item-command-early-output"),
      payload: {
        streamKind: "command_output",
        delta: "/Users/felipelopes/dev/project\n",
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-early-output-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-early-output"),
      itemId: asItemId("item-command-early-output"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Ran command",
        detail: "/bin/zsh -lc 'pwd'",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-early-output-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-early-output"),
      itemId: asItemId("item-command-early-output"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "/bin/zsh -lc 'pwd'",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-command-early-output-turn-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-early-output"),
      payload: {
        state: "completed",
      },
    });

    await harness.drain();

    const result = await Effect.runPromise(
      harness.threadCommandExecutionQuery.getThreadCommandExecutions({
        threadId: asThreadId("thread-1"),
      }),
    );

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.command).toBe("/bin/zsh -lc 'pwd'");
    const detail = await Effect.runPromise(
      harness.threadCommandExecutionQuery.getThreadCommandExecution({
        threadId: asThreadId("thread-1"),
        commandExecutionId: result.executions[0]!.id,
      }),
    );
    expect(detail.commandExecution?.output).toContain("/Users/felipelopes/dev/project");
  });

  it("records exact file-change transcripts with compact activity fileChangeIds", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const fileChangeId = "filechange:thread-1:item-file-change";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-file-change-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      payload: {},
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-file-change-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      itemId: asItemId("item-file-change"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        detail: "Apply patch",
        data: {
          item: {
            changes: [
              {
                path: "README.md",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1,2 @@\n hello\n+world\n",
              },
            ],
          },
        },
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-file-change-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      itemId: asItemId("item-file-change"),
      payload: {
        streamKind: "file_change_output",
        delta: "Success. Updated the following files:\nM README.md\n",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      itemId: asItemId("item-file-change"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        detail: "Apply patch",
        data: {
          item: {
            changes: [
              {
                path: "README.md",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1,2 @@\n hello\n+world\n",
              },
            ],
          },
        },
      },
    });

    await harness.drain();

    const summaries = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChanges({
        threadId: asThreadId("thread-1"),
      }),
    );
    expect(summaries.fileChanges).toHaveLength(1);
    expect(summaries.fileChanges[0]).toMatchObject({
      id: fileChangeId,
      status: "completed",
      changedFiles: ["README.md"],
      hasPatch: true,
    });

    const exact = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChange({
        threadId: asThreadId("thread-1"),
        fileChangeId: OrchestrationFileChangeId.makeUnsafe(fileChangeId),
      }),
    );
    expect(exact.fileChange?.patch).toBe(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1,2 @@",
        " hello",
        "+world",
        "",
      ].join("\n"),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const completedActivity = readModel.threads
      .find((thread) => thread.id === asThreadId("thread-1"))
      ?.activities.find((activity) => activity.id === asEventId("evt-file-change-completed"));
    const toolPayload = completedActivity
      ? readToolActivityPayload(completedActivity.payload)
      : null;
    expect(toolPayload?.fileChangeId).toBe(fileChangeId);
  });

  it("preserves existing unified diff file headers without duplicating them", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const fileChangeId = "filechange:thread-1:item-file-change-headers";
    const fullHeaderDiff = [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " hello",
      "+world",
      "",
    ].join("\n");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-file-change-headers-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-headers"),
      payload: {},
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-file-change-headers-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-headers"),
      itemId: asItemId("item-file-change-headers"),
      payload: {
        streamKind: "file_change_output",
        delta: "Success. Updated the following files:\nM README.md\n",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-headers-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-headers"),
      itemId: asItemId("item-file-change-headers"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        detail: "Apply patch",
        data: {
          item: {
            changes: [
              {
                path: "README.md",
                kind: { type: "update", move_path: null },
                diff: fullHeaderDiff,
              },
            ],
          },
        },
      },
    });

    await harness.drain();

    const exact = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChange({
        threadId: asThreadId("thread-1"),
        fileChangeId: OrchestrationFileChangeId.makeUnsafe(fileChangeId),
      }),
    );

    expect(exact.fileChange?.patch).toBe(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1,2 @@",
        " hello",
        "+world",
        "",
      ].join("\n"),
    );
  });

  it("records rename-only file-change transcripts when move_path is present without hunks", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const fileChangeId = "filechange:thread-1:item-file-change-rename";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-file-change-rename-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-rename"),
      payload: {},
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-rename-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-rename"),
      itemId: asItemId("item-file-change-rename"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        detail: "Rename file",
        data: {
          item: {
            changes: [
              {
                path: "src/old-name.ts",
                kind: { type: "update", move_path: "src/new-name.ts" },
              },
            ],
          },
        },
      },
    });

    await harness.drain();

    const exact = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChange({
        threadId: asThreadId("thread-1"),
        fileChangeId: OrchestrationFileChangeId.makeUnsafe(fileChangeId),
      }),
    );

    expect(exact.fileChange?.patch).toBe(
      [
        "diff --git a/src/old-name.ts b/src/new-name.ts",
        "rename from src/old-name.ts",
        "rename to src/new-name.ts",
        "",
      ].join("\n"),
    );
  });

  it("preserves no-newline markers for synthesized add/delete patches and keeps multi-file order", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const fileChangeId = "filechange:thread-1:item-file-change-no-newline";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-file-change-no-newline-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-no-newline"),
      payload: {},
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-no-newline-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-no-newline"),
      itemId: asItemId("item-file-change-no-newline"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        detail: "Apply patch",
        data: {
          item: {
            changes: [
              {
                path: "src/add-no-newline.ts",
                kind: { type: "add" },
                diff: "export const added = true;",
              },
              {
                path: "src/delete-no-newline.ts",
                kind: { type: "delete" },
                diff: "export const deleted = true;",
              },
            ],
          },
        },
      },
    });

    await harness.drain();

    const exact = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChange({
        threadId: asThreadId("thread-1"),
        fileChangeId: OrchestrationFileChangeId.makeUnsafe(fileChangeId),
      }),
    );

    expect(exact.fileChange?.patch).toBe(
      [
        "diff --git a/src/add-no-newline.ts b/src/add-no-newline.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/add-no-newline.ts",
        "@@ -0,0 +1 @@",
        "+export const added = true;",
        "\\ No newline at end of file",
        "diff --git a/src/delete-no-newline.ts b/src/delete-no-newline.ts",
        "deleted file mode 100644",
        "--- a/src/delete-no-newline.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const deleted = true;",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("synthesizes a completed file-change transcript when output arrives before lifecycle", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const fileChangeId = "filechange:thread-1:item-file-change-early";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-file-change-early-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-early"),
      payload: {},
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-file-change-early-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-early"),
      itemId: asItemId("item-file-change-early"),
      payload: {
        streamKind: "file_change_output",
        delta: "Success. Updated the following files:\nA src/example.ts\n",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-early-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-early"),
      itemId: asItemId("item-file-change-early"),
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "File change",
        detail: "Apply patch",
        data: {
          item: {
            changes: [
              {
                path: "src/example.ts",
                kind: { type: "add" },
                diff: "export const example = true;\n",
              },
            ],
          },
        },
      },
    });

    await harness.drain();

    const exact = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChange({
        threadId: asThreadId("thread-1"),
        fileChangeId: OrchestrationFileChangeId.makeUnsafe(fileChangeId),
      }),
    );
    expect(exact.fileChange).toMatchObject({
      id: fileChangeId,
      status: "completed",
      changedFiles: ["src/example.ts"],
    });
    expect(exact.fileChange?.patch).toBe(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/example.ts",
        "@@ -0,0 +1 @@",
        "+export const example = true;",
        "",
      ].join("\n"),
    );
  });

  it("finalizes partial file-change transcripts as interrupted on aborted turns", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const fileChangeId = "filechange:thread-1:item-file-change-interrupted";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-file-change-interrupted-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-interrupted"),
      payload: {},
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-file-change-interrupted-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-interrupted"),
      itemId: asItemId("item-file-change-interrupted"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        detail: "Apply patch",
        data: {
          item: {
            changes: [
              {
                path: "src/interrupted.ts",
                kind: { type: "delete" },
                diff: "export const interrupted = true;\n",
              },
            ],
          },
        },
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-file-change-interrupted-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-interrupted"),
      itemId: asItemId("item-file-change-interrupted"),
      payload: {
        streamKind: "file_change_output",
        delta: "Success. Updated the following files:\nD src/interrupted.ts\n",
      },
    });
    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-file-change-interrupted-aborted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-interrupted"),
      payload: {
        reason: "user_cancelled",
      },
    } as ProviderRuntimeEvent);

    await harness.drain();

    const exact = await Effect.runPromise(
      harness.threadFileChangeQuery.getThreadFileChange({
        threadId: asThreadId("thread-1"),
        fileChangeId: OrchestrationFileChangeId.makeUnsafe(fileChangeId),
      }),
    );
    expect(exact.fileChange).toMatchObject({
      id: fileChangeId,
      status: "interrupted",
      changedFiles: ["src/interrupted.ts"],
    });
    expect(exact.fileChange?.patch).toBe(
      [
        "diff --git a/src/interrupted.ts b/src/interrupted.ts",
        "deleted file mode 100644",
        "--- a/src/interrupted.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const interrupted = true;",
        "",
      ].join("\n"),
    );
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("inProgress");
    expect(toolUpdatePayload).not.toHaveProperty("data");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("reuses the same checkpoint turn count for repeated turn.diff.updated events in one turn", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-diff-repeat");

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated-1"),
      provider: "claudeAgent",
      createdAt: "2026-04-23T10:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-turn-diff-1"),
      payload: {
        unifiedDiff: "",
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === turnId,
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated-2"),
      provider: "claudeAgent",
      createdAt: "2026-04-23T10:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-turn-diff-2"),
      payload: {
        unifiedDiff: "",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint: ProviderRuntimeTestCheckpoint) =>
          checkpoint.turnId === turnId &&
          checkpoint.checkpointRef === "provider-diff:evt-turn-diff-updated-2",
      ),
    );

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === turnId,
    );
    expect(checkpoint?.checkpointTurnCount).toBe(1);
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated-2");
  });

  it("suppresses redundant Claude subagent tool updates once a result is present", async () => {
    const harness = await createHarness();
    const updatedAt = "2026-04-08T16:00:00.000Z";
    const completedAt = "2026-04-08T16:00:01.000Z";
    const subagentPayload = {
      toolName: "Task",
      input: {
        description: "Review the migration",
        prompt: "Check locking risks and report back.",
        subagent_type: "code-reviewer",
      },
      result: {
        type: "tool_result",
        tool_use_id: "tool-subagent-1",
        content: "Found one lock-escalation risk in the backfill.",
      },
      subagentType: "code-reviewer",
      subagentDescription: "Review the migration",
      subagentPrompt: "Check locking risks and report back.",
      subagentResult: "Found one lock-escalation risk in the backfill.",
    };

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-subagent-updated"),
      provider: "claudeAgent",
      createdAt: updatedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-subagent-1"),
      itemId: asItemId("item-subagent-1"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Code Reviewer agent",
        detail: "Task: Review the migration",
        data: subagentPayload,
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-subagent-completed"),
      provider: "claudeAgent",
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-subagent-1"),
      itemId: asItemId("item-subagent-1"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Code Reviewer agent",
        detail: "Task: Review the migration",
        data: subagentPayload,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-subagent-completed",
      ),
    );

    const updatedActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-subagent-updated",
    );
    expect(updatedActivity).toBeUndefined();

    const completedActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-subagent-completed",
    );
    const completedPayload =
      completedActivity?.payload && typeof completedActivity.payload === "object"
        ? (completedActivity.payload as Record<string, unknown>)
        : undefined;

    expect(completedActivity?.kind).toBe("tool.completed");
    expect(completedPayload?.itemType).toBe("collab_agent_tool_call");
    expect(completedPayload?.subagentType).toBe("code-reviewer");
    expect(completedPayload?.subagentResult).toBe(
      "Found one lock-escalation risk in the backfill.",
    );
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe(
      "Comparing the desktop rollout chunks to the app-server stream.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("derives read and search display hints for reasoning updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-read-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-hints"),
      payload: {
        taskId: "turn-task-hints",
        description: "Reading lines 120-180 of apps/web/src/components/ui/alert.tsx",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-search-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-hints"),
      payload: {
        taskId: "turn-task-hints",
        description: 'Running grep -r "serverConfigQuery|useServerConfig" apps/web/src',
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-search-progress",
      ),
    );

    const readProgress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-read-progress",
    );
    const readPayload =
      readProgress?.payload && typeof readProgress.payload === "object"
        ? (readProgress.payload as Record<string, unknown>)
        : undefined;

    expect(readProgress?.kind).toBe("task.progress");
    expect(readPayload?.readPaths).toEqual(["apps/web/src/components/ui/alert.tsx"]);
    expect(readPayload?.lineSummary).toBe("lines 120-180");

    const searchProgress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-search-progress",
    );
    const searchPayload =
      searchProgress?.payload && typeof searchProgress.payload === "object"
        ? (searchProgress.payload as Record<string, unknown>)
        : undefined;

    expect(searchProgress?.kind).toBe("task.progress");
    expect(searchPayload?.searchSummary).toBe(
      "Searching apps/web/src for serverConfigQuery, useServerConfig",
    );
  });

  it("projects Claude TodoWrite lifecycle updates onto durable thread tasks", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-todo-update"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-todo-1"),
      itemId: asItemId("item-todo-1"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        data: {
          toolName: "TodoWrite",
          input: {
            todos: [
              {
                content: "Inspect the current implementation",
                activeForm: "Inspecting the current implementation",
                status: "completed",
              },
              {
                content: "Implement the task panel",
                activeForm: "Implementing the task panel",
                status: "in_progress",
              },
              {
                content: "Run bun typecheck",
                activeForm: "Running bun typecheck",
                status: "pending",
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.tasks.length === 3 && entry.tasks[1]?.status === "in_progress",
    );

    expect(thread.tasks).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^todo:inspect-the-current-implementation:[0-9a-f]{12}:1$/),
        content: "Inspect the current implementation",
        activeForm: "Inspecting the current implementation",
        status: "completed",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^todo:implement-the-task-panel:[0-9a-f]{12}:1$/),
        content: "Implement the task panel",
        activeForm: "Implementing the task panel",
        status: "in_progress",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^todo:run-bun-typecheck:[0-9a-f]{12}:1$/),
        content: "Run bun typecheck",
        activeForm: "Running bun typecheck",
        status: "pending",
      }),
    ]);
    expect(
      thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-todo-update",
      ),
    ).toBeUndefined();
  });

  it("derives distinct TodoWrite task ids for same-slug and same-content tasks", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-todo-collisions"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-todo-collisions"),
      itemId: asItemId("item-todo-collisions"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        data: {
          toolName: "TodoWrite",
          input: {
            todos: [
              {
                content: "Run tests!",
                activeForm: "Running unit tests",
                status: "completed",
              },
              {
                content: "Run tests?",
                activeForm: "Running integration tests",
                status: "completed",
              },
              {
                content: "Write docs",
                activeForm: "Writing docs draft",
                status: "pending",
              },
              {
                content: "Write docs",
                activeForm: "Writing docs polish",
                status: "in_progress",
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => entry.tasks.length === 4);
    const ids = thread.tasks.map((task) => task.id);

    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toMatch(/^todo:run-tests:[0-9a-f]{12}:1$/);
    expect(ids[1]).toMatch(/^todo:run-tests:[0-9a-f]{12}:1$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toMatch(/^todo:write-docs:[0-9a-f]{12}:1$/);
    expect(ids[3]).toMatch(/^todo:write-docs:[0-9a-f]{12}:1$/);
    expect(ids[2]).not.toBe(ids[3]);
  });

  it("does not dispatch a duplicate task snapshot for repeated TodoWrite events", async () => {
    const harness = await createHarness();
    const firstEventAt = "2026-04-03T17:05:00.000Z";
    const secondEventAt = "2026-04-03T17:05:01.000Z";

    const todoPayload = {
      itemType: "dynamic_tool_call" as const,
      status: "inProgress" as const,
      title: "Tool call",
      data: {
        toolName: "TodoWrite",
        input: {
          todos: [
            {
              content: "Inspect implementation",
              activeForm: "Inspecting implementation",
              status: "completed",
            },
            {
              content: "Apply patch",
              activeForm: "Applying patch",
              status: "in_progress",
            },
          ],
        },
      },
    };

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-todo-dedup-1"),
      provider: "claudeAgent",
      createdAt: firstEventAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-todo-dedup"),
      itemId: asItemId("item-todo-dedup"),
      payload: todoPayload,
    });

    const firstThread = await waitForThread(
      harness.engine,
      (entry) => entry.tasks.length === 2 && entry.updatedAt === firstEventAt,
    );
    expect(firstThread.updatedAt).toBe(firstEventAt);

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-todo-dedup-2"),
      provider: "claudeAgent",
      createdAt: secondEventAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-todo-dedup"),
      itemId: asItemId("item-todo-dedup"),
      payload: todoPayload,
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-1");
    expect(thread?.tasks).toHaveLength(2);
    expect(thread?.updatedAt).toBe(firstEventAt);
  });

  it("skips invalid TodoWrite task snapshots without mutating thread tasks", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-todo-invalid"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-todo-invalid"),
      itemId: asItemId("item-todo-invalid"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        data: {
          toolName: "TodoWrite",
          input: {
            todos: [
              {
                content: "Inspect implementation",
                activeForm: "Inspecting implementation",
                status: "in_progress",
              },
              {
                content: "Apply patch",
                activeForm: "Applying patch",
                status: "in_progress",
              },
            ],
          },
        },
      },
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-1");
    expect(thread?.tasks).toEqual([]);
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });

  it("flushes buffered reasoning onto the finalized assistant message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-reasoning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-reasoning",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-item"),
      payload: {
        streamKind: "reasoning_text",
        delta: "thinking...",
      },
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-answer-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("assistant-item"),
      payload: {
        streamKind: "assistant_text",
        delta: "answer",
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-answer-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("assistant-item"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:assistant-item" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:assistant-item",
    );
    expect(message?.text).toBe("answer");
    expect(message?.reasoningText).toBe("thinking...");
  });

  it("preserves reasoning buffered before the first assistant token in streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-reasoning-streaming"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-reasoning-streaming"),
          role: "user",
          text: "stream reasoning please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-reasoning-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-streaming"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-reasoning-streaming",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-prefix"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-streaming"),
      itemId: asItemId("reasoning-prefix"),
      payload: {
        streamKind: "reasoning_text",
        delta: "a",
      },
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-assistant-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-streaming"),
      itemId: asItemId("assistant-streaming"),
      payload: {
        streamKind: "assistant_text",
        delta: "x",
      },
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-suffix"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-streaming"),
      itemId: asItemId("reasoning-suffix"),
      payload: {
        streamKind: "reasoning_text",
        delta: "b",
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-streaming-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-streaming"),
      itemId: asItemId("assistant-streaming"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:assistant-streaming" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:assistant-streaming",
    );
    expect(message?.text).toBe("x");
    expect(message?.reasoningText).toBe("ab");
  });
});
