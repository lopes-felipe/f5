import type { WebSocket } from "ws";
import { makeServerPushBus } from "../../src/wsServer/pushBus.ts";
import { PerformanceStageProbe } from "../../src/observability/Metrics.ts";
import { once } from "node:events";
import { Writable } from "node:stream";
import { makeBackupService } from "../../src/backupService.ts";
/**
 * Streaming assistant workload through the production ingestion path:
 * ProviderRuntimeIngestion -> OrchestrationEngine.dispatch -> ProjectionPipeline,
 * against a disposable on-disk SQLite database.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Ref, Scope, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, vi } from "vitest";
import { COALESCE_STREAMING_DELTAS_DRIVERS } from "../../src/orchestration/streamingAssistantDeltas.ts";
import {
  ORCHESTRATION_WS_CHANNELS,
  type OrchestrationEvent,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { ServerConfig } from "../../src/config.ts";
import { OrchestrationEngineLive } from "../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ThreadBackgroundWorkLive } from "../../src/orchestration/Layers/ThreadBackgroundWork.ts";
import { ThreadCommandExecutionQueryLive } from "../../src/orchestration/Layers/ThreadCommandExecutionQuery.ts";
import { ThreadFileChangeQueryLive } from "../../src/orchestration/Layers/ThreadFileChangeQuery.ts";
import { OrchestrationEngineService } from "../../src/orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../../src/persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ProjectionThreadFileChangeRepositoryLive } from "../../src/persistence/Layers/ProjectionThreadFileChanges.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../../src/persistence/Layers/Sqlite.ts";
import { UsageFactRepositoryLive } from "../../src/persistence/Layers/UsageFacts.ts";
import { ProjectionThreadMessageRepository } from "../../src/persistence/Services/ProjectionThreadMessages.ts";
import { ProviderSessionDirectoryLive } from "../../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../src/provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../src/provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../src/serverSettings.ts";
import {
  assistantStreamDelta,
  fixture,
  messageFixture,
} from "../../../../scripts/lib/performance/fixtures.ts";
import {
  maximumObservation,
  measure,
  type Observation,
  type Samples,
} from "../../../../scripts/lib/performance/report.ts";
import { SERVER_COMPONENT_BOUNDS } from "../../../../scripts/lib/performance/coverage.ts";

const workload = fixture.assistantStream;
// Per-delta latency is ~100 ms today; a missing commit is a harness or ingestion bug.
const DELTA_COMMIT_TIMEOUT_MS = 30_000;
const READ_MODEL_MEMORY_RUNS = 3;
const epochMs = Date.parse(fixture.epoch);
const at = (offsetMs: number) => new Date(epochMs + offsetMs).toISOString();
const projectId = ProjectId.makeUnsafe("perf-stream-project");
const streamThreadId = (stream: number) => ThreadId.makeUnsafe(`perf-stream-${stream}`);

/** Only the calls ingestion makes; anything else is a harness bug. */
function makeProviderService() {
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const sessions: ProviderSession[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in perf")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    replaceSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    respondToElicitation: () => unsupported(),
    stopSession: () => unsupported(),
    listStartingWorkspaces: () => Effect.succeed([]),
    listSessions: () => Effect.succeed([...sessions]),
    getSessionCapabilities: () => Effect.succeed(null),
    assertSessionAction: () => unsupported(),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackConversation: () => unsupported(),
    runOneOffPrompt: () => unsupported(),
    compactConversation: () => unsupported(),
    reloadMcpConfigForProject: () => unsupported(),
    streamEvents: Stream.fromPubSub(events),
  };
  return {
    service,
    sessions,
    emit: (event: Record<string, unknown>) =>
      Effect.runSync(PubSub.publish(events, event as unknown as ProviderRuntimeEvent)),
  };
}

function makeLayer(
  directory: string,
  database: string,
  provider: ProviderServiceShape,
  probe: ((stage: string, durationMs: number) => void) | null = null,
) {
  const sessionDirectory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const engine = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  return ProviderRuntimeIngestionLive.pipe(
    Layer.provide(ServerSettingsService.layerTest({ enableAssistantStreaming: true })),
    Layer.provideMerge(engine),
    Layer.provideMerge(
      ThreadCommandExecutionQueryLive.pipe(
        Layer.provideMerge(ProjectionThreadCommandExecutionRepositoryLive),
      ),
    ),
    Layer.provideMerge(
      ThreadFileChangeQueryLive.pipe(Layer.provideMerge(ProjectionThreadFileChangeRepositoryLive)),
    ),
    Layer.provideMerge(sessionDirectory),
    Layer.provideMerge(ThreadBackgroundWorkLive.pipe(Layer.provideMerge(sessionDirectory))),
    Layer.provideMerge(UsageFactRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(database)),
    Layer.provideMerge(Layer.succeed(ProviderService, provider)),
    Layer.provideMerge(ServerConfig.layerTest(directory, path.join(directory, "state"))),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(PerformanceStageProbe, probe)),
  );
}

/** Creates threads by dispatch, then seeds projected history through the repository. */
async function seed(
  directory: string,
  database: string,
  threadIds: ReadonlyArray<ThreadId>,
  messagesPerThread: number,
) {
  const runtime = ManagedRuntime.make(
    makeLayer(directory, database, makeProviderService().service),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const messages = yield* ProjectionThreadMessageRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("perf-stream-project-create"),
          projectId,
          title: "Perf stream project",
          workspaceRoot: directory,
          defaultModel: "gpt-5-codex",
          createdAt: at(0),
        });
        for (const threadId of threadIds)
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`${threadId}-create`),
            threadId,
            projectId,
            title: threadId,
            model: "gpt-5-codex",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at(0),
          });
        for (const threadId of threadIds)
          yield* sql.withTransaction(
            Effect.forEach(
              Array.from({ length: messagesPerThread }, (_, index) => messageFixture(index)),
              (message) =>
                messages.upsert({
                  messageId: MessageId.makeUnsafe(`${threadId}:${message.id}`),
                  threadId,
                  turnId: null,
                  role: message.role,
                  text: message.text,
                  isStreaming: false,
                  createdAt: message.createdAt,
                  updatedAt: message.createdAt,
                }),
              { discard: true },
            ),
          );
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

export async function measureAssistantStream(
  method: typeof fixture.method,
  providerKind: "codex" | "claudeAgent" = "codex",
): Promise<{ samples: Samples; observations: Observation[]; diagnostics: Record<string, number> }> {
  const coalescingSpy =
    process.env.F5_PERF_STREAM_COALESCE === "0"
      ? vi.spyOn(COALESCE_STREAMING_DELTAS_DRIVERS, "has").mockReturnValue(false)
      : undefined;
  const directory = mkdtempSync(path.join(tmpdir(), "f5-performance-stream-"));
  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as StatementSync;
  probe.close();
  const storageGate = process.env.F5_PERF_STREAM_STORAGE_GATE === "1";
  const counts = {
    statements: 0,
    projectionStatements: 0,
    eventRows: 0,
    domainEvents: 0,
    sqlMaxMs: 0,
  };
  const count = (statement: StatementSync) => {
    counts.statements++;
    if (statement.sourceSQL.includes("projection_")) counts.projectionStatements++;
    if (/INSERT\s+INTO\s+orchestration_events\b/i.test(statement.sourceSQL)) counts.eventRows++;
  };
  // A plain patch rather than vi.spyOn: spies retain every call's result rows.
  const originalAll = statementPrototype.all;
  const originalRun = statementPrototype.run;
  statementPrototype.all = function (this: StatementSync, ...params: unknown[]) {
    count(this);
    const start = storageGate ? performance.now() : 0;
    try {
      return Reflect.apply(originalAll, this, params);
    } finally {
      if (storageGate) counts.sqlMaxMs = Math.max(counts.sqlMaxMs, performance.now() - start);
    }
  } as typeof originalAll;
  statementPrototype.run = function (this: StatementSync, ...params: unknown[]) {
    count(this);
    const start = storageGate ? performance.now() : 0;
    try {
      return Reflect.apply(originalRun, this, params);
    } finally {
      if (storageGate) counts.sqlMaxMs = Math.max(counts.sqlMaxMs, performance.now() - start);
    }
  } as typeof originalRun;
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  try {
    const threadIds = Array.from({ length: workload.threads }, (_, i) => streamThreadId(i));
    const database = path.join(directory, "stream.sqlite");
    await seed(directory, database, threadIds, workload.seededMessages);

    const provider = makeProviderService();
    const stages = new Map<string, number[]>();
    let recording = false;
    const probeStage = (stage: string, ms: number) => {
      if (!recording) return;
      const samples = stages.get(stage) ?? [];
      samples.push(ms);
      stages.set(stage, samples);
    };
    const runtime = ManagedRuntime.make(
      makeLayer(directory, database, provider.service, probeStage),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
      const sessions = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
      const hydrated = await runtime.runPromise(engine.getReadModel());
      for (const threadId of threadIds)
        expect(hydrated.threads.find((thread) => thread.id === threadId)?.messages.length).toBe(
          workload.seededMessages,
        );

      const committedLengths = new Map<string, number>();
      const waiters = new Map<string, Array<{ length: number; resolve: () => void }>>();
      const onPushedEvent = (event: OrchestrationEvent) => {
        counts.domainEvents++;
        if (event.type !== "thread.message-sent") return;
        const length =
          (committedLengths.get(event.payload.messageId) ?? 0) + event.payload.text.length;
        committedLengths.set(event.payload.messageId, length);
        const pending = waiters.get(event.payload.messageId);
        if (!pending) return;
        const remaining = pending.filter((waiter) => {
          if (length < waiter.length) return true;
          waiter.resolve();
          return false;
        });
        if (remaining.length) waiters.set(event.payload.messageId, remaining);
        else waiters.delete(event.payload.messageId);
      };
      const pushBus = await runtime.runPromise(
        makeServerPushBus({
          clients: Effect.runSync(Ref.make(new Set([{} as WebSocket]))),
          logOutgoingPush: () => {},
          sendClient: (_client, frame) =>
            Effect.sync(() => {
              const decoded = JSON.parse(frame) as { data: OrchestrationEvent };
              onPushedEvent(decoded.data);
              return true;
            }),
        }).pipe(Scope.provide(scope)),
      );
      runtime.runFork(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          const started = performance.now();
          return pushBus
            .publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event)
            .pipe(
              Effect.ensuring(
                Effect.sync(() => probeStage("push.admission", performance.now() - started)),
              ),
            );
        }),
      );
      const queueDepths: number[] = [];
      const queueBytes: number[] = [];
      const emit = provider.emit;
      provider.emit = (event) => {
        if (recording) {
          const queue = engine.inspectQueue?.();
          queueDepths.push(queue?.entries ?? 0);
          queueBytes.push(queue?.bytes ?? 0);
        }
        return emit(event);
      };
      await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const threadId of threadIds) {
        provider.sessions.push({
          provider: providerKind,
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: at(0),
          updatedAt: at(0),
        });
        await runtime.runPromise(
          sessions.upsert({
            threadId,
            provider: providerKind,
            status: "running",
            runtimeMode: "full-access",
            runtimePayload: { activeTurnId: null },
          }),
        );
        // The turn request selects streaming delivery, so every delta is dispatched.
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`${threadId}-turn-request`),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(`${threadId}-request`),
              role: "user",
              text: "Stream a long answer",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            assistantDeliveryMode: "streaming",
            createdAt: at(1),
          }),
        );
      }
      await runtime.runPromise(ingestion.drain);

      let repetition = 0;
      const latencies: number[][] = [];
      const perRepetition: Array<typeof counts> = [];
      const runStream = async (stream: number, rep: number) => {
        const threadId = streamThreadId(stream);
        const turnId = `perf-turn-${rep}`;
        const itemId = `perf-item-${stream}-${rep}`;
        const base = { provider: providerKind, threadId, turnId, sessionGeneration: 0 };
        const createdAt = at(86_400_000 + rep * 1000);
        const id = (suffix: string) => `perf-${rep}-${stream}-${suffix}`;
        provider.emit({ ...base, type: "turn.started", eventId: id("turn-started"), createdAt });
        let projectedLength = 0;
        let burst: Promise<void>[] = [];
        for (let index = 0; index < workload.deltasPerStream; index++) {
          if (stream === 0 && index > 0 && index % workload.toolEvery === 0) {
            for (const [itemType, title] of [
              ["command_execution", "bun test"],
              ["dynamic_tool_call", "Read file"],
            ] as const) {
              const toolItem = `${itemType}-${rep}-${index}`;
              provider.emit({
                ...base,
                type: "item.started",
                eventId: id(`${toolItem}-started`),
                itemId: toolItem,
                createdAt,
                payload: { itemType, status: "in_progress", title, detail: "src/index.ts" },
              });
              provider.emit({
                ...base,
                type: "item.completed",
                eventId: id(`${toolItem}-completed`),
                itemId: toolItem,
                createdAt,
                payload: { itemType, status: "completed", title, detail: "src/index.ts" },
              });
            }
          }
          const eventId = id(`delta-${index}`);
          const messageId = `assistant:${itemId}`;
          const delta = assistantStreamDelta(stream, index);
          projectedLength += delta.length;
          const expectedLength = projectedLength;
          const committed = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Stream ${stream} delta ${index} did not commit within ${DELTA_COMMIT_TIMEOUT_MS} ms`,
                  ),
                ),
              DELTA_COMMIT_TIMEOUT_MS,
            );
            const pending = waiters.get(messageId) ?? [];
            pending.push({
              length: expectedLength,
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
            });
            waiters.set(messageId, pending);
          });
          const startedAt = performance.now();
          provider.emit({
            ...base,
            type: "content.delta",
            eventId,
            itemId,
            createdAt,
            payload: { streamKind: "assistant_text", delta },
          });
          burst.push(
            committed.then(() => {
              latencies[rep]!.push(performance.now() - startedAt);
            }),
          );
          // Bounded concurrent deltas exercise coalescing without an unbounded publisher queue.
          if (
            burst.length === workload.maxInFlightDeltasPerStream ||
            index === workload.deltasPerStream - 1
          ) {
            await Promise.all(burst);
            burst = [];
          }
        }
        provider.emit({
          ...base,
          type: "item.completed",
          eventId: id("message-completed"),
          itemId,
          createdAt,
          payload: { itemType: "assistant_message", status: "completed" },
        });
        provider.emit({
          ...base,
          type: "turn.completed",
          eventId: id("turn-completed"),
          createdAt,
          payload: { state: "completed" },
        });
      };
      const backup = storageGate
        ? await runtime.runPromise(
            Effect.gen(function* () {
              const config = yield* ServerConfig;
              return yield* makeBackupService.pipe(
                Effect.provideService(ServerConfig, { ...config, dbPath: database }),
              );
            }),
          )
        : null;
      let backupExports = 0;
      const withStorageContention = async (work: () => Promise<void>) => {
        if (!backup) return work();
        const reader = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1], { readOnly: true });
          db.exec('BEGIN');
          db.prepare('SELECT COUNT(*) FROM projection_thread_messages').get();
          process.stdout.write('ready');
          process.stdin.resume();
          process.stdin.on('end', () => db.close());
        `,
            database,
          ],
          { stdio: ["pipe", "pipe", "ignore"] },
        );
        const closed = once(reader, "close");
        try {
          await Promise.race([
            once(reader.stdout, "data"),
            closed.then(() => {
              throw new Error("External SQLite reader exited before readiness");
            }),
          ]);
          await Promise.all([
            work(),
            runtime
              .runPromise(
                backup.exportArchive({
                  includeSecrets: false,
                  output: new Writable({
                    write(_chunk, _encoding, done) {
                      done();
                    },
                  }),
                }),
              )
              .then(() => {
                backupExports++;
              }),
          ]);
        } finally {
          reader.stdin.end();
          await closed;
        }
      };
      const pageProbe = new DatabaseSync(database, { readOnly: true });
      const initialPages = Number(
        (pageProbe.prepare("PRAGMA page_count").get() as { page_count: number }).page_count,
      );
      pageProbe.close();
      loopDelay.enable();
      const samples = await measure(
        async () => {
          const rep = repetition++;
          recording = rep >= method.warmups;
          latencies[rep] = [];
          await withStorageContention(() =>
            Promise.all(threadIds.map((_, stream) => runStream(stream, rep))).then(() => {}),
          );
          await runtime.runPromise(ingestion.drain);
          perRepetition.push({ ...counts });
        },
        method,
        async () => {
          counts.statements = counts.projectionStatements = counts.eventRows = 0;
          counts.domainEvents = 0;
          counts.sqlMaxMs = 0;
          // Like the other stream observations, the delay histogram covers measured runs only.
          if (repetition === method.warmups) loopDelay.reset();
        },
      );
      loopDelay.disable();
      recording = false;
      const finalPageProbe = new DatabaseSync(database, { readOnly: true });
      const finalPages = Number(
        (finalPageProbe.prepare("PRAGMA page_count").get() as { page_count: number }).page_count,
      );
      finalPageProbe.close();

      // Correctness outside timing: every stream produced its complete text.
      const finalModel = await runtime.runPromise(engine.getReadModel());
      for (const [stream, threadId] of threadIds.entries()) {
        const message = finalModel.threads
          .find((thread) => thread.id === threadId)
          ?.messages.find(
            (entry) => entry.id === `assistant:perf-item-${stream}-${repetition - 1}`,
          );
        expect(message?.streaming).toBe(false);
        expect(message?.text).toBe(
          Array.from({ length: workload.deltasPerStream }, (_, i) =>
            assistantStreamDelta(stream, i),
          ).join(""),
        );
      }

      if (storageGate) expect(backupExports).toBe(method.warmups + method.repetitions);
      const measured = latencies.slice(-method.repetitions).flat();
      const measuredCounts = perRepetition.slice(-method.repetitions);
      const most = (key: keyof typeof counts) =>
        Math.max(...measuredCounts.map((entry) => entry[key]));
      const bounded = (name: keyof typeof SERVER_COMPONENT_BOUNDS, actual: number) =>
        maximumObservation(name, actual, SERVER_COMPONENT_BOUNDS[name]);
      const diagnostics: Record<string, number> = {
        deltaToPushP95Ms: percentile(measured, 0.95),
        commandQueueP95: percentile(queueDepths, 0.95),
        commandQueueMax: Math.max(0, ...queueDepths),
        commandQueueBytesMax: Math.max(0, ...queueBytes),
        sqlitePageGrowth: finalPages - initialPages,
        walBytes: (() => {
          try {
            return statSync(`${database}-wal`).size;
          } catch {
            return 0;
          }
        })(),
        eventLoopDelayP50Ms: loopDelay.percentile(50) / 1e6,
        eventLoopDelayP95Ms: loopDelay.percentile(95) / 1e6,
        eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
        sqlStatements: most("statements"),
        projectionSqlStatements: most("projectionStatements"),
      };
      for (const [stage, values] of stages) {
        diagnostics[`${stage}.p95Ms`] = percentile(values, 0.95);
        diagnostics[`${stage}.count`] = values.length;
        diagnostics[`${stage}.totalMs`] = values.reduce((sum, value) => sum + value, 0);
      }
      return {
        samples,
        diagnostics,
        observations:
          providerKind === "codex"
            ? [
                bounded("stream.deltaLatencyP50Ms", percentile(measured, 0.5)),
                bounded("stream.deltaLatencyP95Ms", percentile(measured, 0.95)),
                bounded("stream.eventRowsWritten", most("eventRows")),
                bounded("stream.domainEvents", most("domainEvents")),
                bounded("stream.sqlStatements", most("statements")),
                bounded("stream.projectionSqlStatements", most("projectionStatements")),
                bounded("stream.eventLoopDelayP99Ms", loopDelay.percentile(99) / 1e6),
                ...(storageGate
                  ? [
                      maximumObservation(
                        "stream.storageGate.sqlExecutionMaxMs",
                        most("sqlMaxMs"),
                        1000,
                      ),
                      maximumObservation(
                        "stream.storageGate.completedBackups",
                        backupExports,
                        method.warmups + method.repetitions,
                      ),
                    ]
                  : []),
              ]
            : [],
      };
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  } finally {
    coalescingSpy?.mockRestore();
    loopDelay.disable();
    statementPrototype.all = originalAll;
    statementPrototype.run = originalRun;
    rmSync(directory, { recursive: true, force: true });
  }
}

const readModelThreadId = (index: number) => ThreadId.makeUnsafe(`perf-read-model-${index}`);
const readModelDatabase = (directory: string) => path.join(directory, "read-model.sqlite");

export interface EngineHydrationMemory {
  readonly deletedMessages: number;
  readonly heapBytes: number;
  readonly rssBytes: number;
}

/**
 * Memory retained by engine startup (projection bootstrap, snapshot hydration and
 * catch-up replay), sampled before the engine layer exists. Runs in a fresh process
 * via readModelMemory.perf.ts so seeding never warms this allocator.
 */
export async function measureEngineHydration(directory: string): Promise<EngineHydrationMemory> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("Read-model memory measurement requires --expose-gc");
  gc();
  const before = process.memoryUsage();
  const runtime = ManagedRuntime.make(
    makeLayer(directory, readModelDatabase(directory), makeProviderService().service),
  );
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    gc();
    const after = process.memoryUsage();
    const model = await runtime.runPromise(engine.getReadModel());
    const hydrated = model.threads.filter((thread) => thread.id.startsWith("perf-read-model-"));
    expect(hydrated).toHaveLength(workload.readModelThreads);
    const deletedPercent = Number(process.env.F5_PERF_READ_MODEL_DELETED_PERCENT ?? "0");
    const deletedCount = Math.floor((workload.readModelThreads * deletedPercent) / 100);
    expect(hydrated.filter((t) => t.deletedAt !== null)).toHaveLength(deletedCount);
    expect(
      hydrated
        .filter((t) => t.deletedAt === null)
        .every((t) => t.messages.length === workload.readModelMessages),
    ).toBe(true);
    return {
      deletedMessages: hydrated
        .filter((t) => t.deletedAt !== null)
        .reduce((count, thread) => count + thread.messages.length, 0),
      heapBytes: Math.max(0, after.heapUsed - before.heapUsed),
      rssBytes: Math.max(0, after.rss - before.rss),
    };
  } finally {
    await runtime.dispose();
  }
}

/** Seeds once here, then takes the median of several fresh-process hydrations. */
export async function measureReadModelMemory(
  options: { deletedPercent?: number } = {},
): Promise<Observation[]> {
  const deletedPercent = options.deletedPercent ?? 0;
  if (!Number.isFinite(deletedPercent) || deletedPercent < 0 || deletedPercent > 100)
    throw new Error("Invalid deleted thread percentage");
  const directory = mkdtempSync(path.join(tmpdir(), "f5-performance-read-model-"));
  try {
    const threadIds = Array.from({ length: workload.readModelThreads }, (_, i) =>
      readModelThreadId(i),
    );
    await seed(directory, readModelDatabase(directory), threadIds, workload.readModelMessages);
    if (deletedPercent > 0) {
      const db = new DatabaseSync(readModelDatabase(directory));
      try {
        const remove = db.prepare(
          "UPDATE projection_threads SET deleted_at = ? WHERE thread_id = ?",
        );
        for (const id of threadIds.slice(0, Math.floor((threadIds.length * deletedPercent) / 100)))
          remove.run(at(1), id);
      } finally {
        db.close();
      }
    }
    const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
    // A nested vitest must not inherit this worker's pool identity.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
    );
    const heap: number[] = [];
    const rss: number[] = [];
    const deletedMessages: number[] = [];
    for (let run = 0; run < READ_MODEL_MEMORY_RUNS; run++) {
      const output = path.join(directory, `hydration-${run}.json`);
      const child = spawnSync(
        process.execPath,
        [
          path.join(serverRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          "vitest.performance.config.ts",
        ],
        {
          cwd: serverRoot,
          encoding: "utf8",
          env: {
            ...env,
            F5_PERF_READ_MODEL: "1",
            F5_PERF_READ_MODEL_DIR: directory,
            F5_PERF_READ_MODEL_DELETED_PERCENT: String(deletedPercent),
            F5_PERF_READ_MODEL_OUTPUT: output,
          },
        },
      );
      if (child.status !== 0)
        throw new Error(
          `Read-model hydration process failed (${child.status ?? child.signal}): ${child.stderr.slice(-4096) || child.stdout.slice(-4096)}`,
        );
      const result = JSON.parse(readFileSync(output, "utf8")) as EngineHydrationMemory;
      deletedMessages.push(result.deletedMessages);
      heap.push(result.heapBytes);
      rss.push(result.rssBytes);
    }
    return [
      ...(deletedPercent > 0
        ? [maximumObservation("readModel.deletedMessages", percentile(deletedMessages, 0.5), 0)]
        : []),
      maximumObservation(
        "readModel.heapBytes",
        percentile(heap, 0.5),
        SERVER_COMPONENT_BOUNDS["readModel.heapBytes"],
      ),
      maximumObservation(
        "readModel.rssBytes",
        percentile(rss, 0.5),
        SERVER_COMPONENT_BOUNDS["readModel.rssBytes"],
      ),
    ];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
