import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Metric, Queue, Stream, Tracer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeLocalFileTracer } from "../../observability/LocalFileTracer.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

function counterValue(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Counter" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Counter" ? Number(snapshot.state.count) : 0;
}

function histogramCount(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Histogram" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Histogram" ? snapshot.state.count : 0;
}

async function createOrchestrationSystem(input?: { readonly tracePath?: string }) {
  if (input?.tracePath) {
    fs.mkdirSync(path.dirname(input.tracePath), { recursive: true });
  }
  const tracerLayer = input?.tracePath
    ? Layer.effect(
        Tracer.Tracer,
        makeLocalFileTracer({
          filePath: input.tracePath,
          maxBytes: 1024 * 1024,
          maxFiles: 2,
          batchWindowMs: 1,
        }),
      )
    : Layer.empty;
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(tracerLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

async function createPersistentOrchestrationSystem(input: {
  readonly dbPath: string;
  readonly eventStoreLayer?: Layer.Layer<OrchestrationEventStore, never, SqlClient.SqlClient>;
  readonly projectionSnapshotQueryLayer?: Layer.Layer<
    ProjectionSnapshotQuery,
    never,
    SqlClient.SqlClient
  >;
}) {
  const persistenceLayer = makeSqlitePersistenceLive(input.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(input.projectionSnapshotQueryLayer ?? OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(input.eventStoreLayer ?? OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(persistenceLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function makeRecordingEventStoreLayer(readCursors: number[]) {
  return Layer.effect(
    OrchestrationEventStore,
    Effect.gen(function* () {
      const live = yield* OrchestrationEventStore;
      return {
        ...live,
        readFromSequence(sequenceExclusive, limit) {
          readCursors.push(sequenceExclusive);
          return live.readFromSequence(sequenceExclusive, limit);
        },
      } satisfies OrchestrationEventStoreShape;
    }),
  ).pipe(Layer.provide(OrchestrationEventStoreLive));
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine", () => {
  it("returns deterministic read models for repeated reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-1-create"),
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
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.run(engine.getReadModel());
    const readModelB = await system.run(engine.getReadModel());
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("hydrates warm startup from the projection snapshot instead of replaying from sequence 0", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-orchestration-snapshot-"));
    const dbPath = path.join(tempDir, "state.sqlite");
    const createdAt = now();
    const seededSystem = await createPersistentOrchestrationSystem({ dbPath });

    await seededSystem.run(
      seededSystem.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-snapshot-create"),
        projectId: asProjectId("project-snapshot"),
        title: "Snapshot Project",
        workspaceRoot: "/tmp/project-snapshot",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await seededSystem.run(
      seededSystem.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-snapshot-create"),
        threadId: ThreadId.makeUnsafe("thread-snapshot"),
        projectId: asProjectId("project-snapshot"),
        title: "snapshot-thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const seededReadModel = await seededSystem.run(seededSystem.engine.getReadModel());
    const latestSequence = seededReadModel.snapshotSequence;
    await seededSystem.dispose();

    const readCursors: number[] = [];
    const warmSystem = await createPersistentOrchestrationSystem({
      dbPath,
      eventStoreLayer: makeRecordingEventStoreLayer(readCursors),
    });
    const warmReadModel = await warmSystem.run(warmSystem.engine.getReadModel());

    expect(warmReadModel.snapshotSequence).toBe(latestSequence);
    expect(warmReadModel.projects.map((project) => project.id)).toContain("project-snapshot");
    expect(warmReadModel.threads.map((thread) => thread.id)).toContain("thread-snapshot");
    expect(readCursors).toContain(latestSequence);
    expect(readCursors).not.toContain(0);

    await warmSystem.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("falls back to full replay when projection snapshot hydration fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-orchestration-snapshot-fallback-"));
    const dbPath = path.join(tempDir, "state.sqlite");
    const createdAt = now();
    const seededSystem = await createPersistentOrchestrationSystem({ dbPath });

    await seededSystem.run(
      seededSystem.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-snapshot-fallback-create"),
        projectId: asProjectId("project-snapshot-fallback"),
        title: "Snapshot Fallback Project",
        workspaceRoot: "/tmp/project-snapshot-fallback",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await seededSystem.run(
      seededSystem.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-snapshot-fallback-create"),
        threadId: ThreadId.makeUnsafe("thread-snapshot-fallback"),
        projectId: asProjectId("project-snapshot-fallback"),
        title: "snapshot-fallback-thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const seededReadModel = await seededSystem.run(seededSystem.engine.getReadModel());
    const latestSequence = seededReadModel.snapshotSequence;
    await seededSystem.dispose();

    const readCursors: number[] = [];
    const failingSnapshotQueryLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getBootstrapSnapshot: () =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.snapshot.bootstrap",
            detail: "bootstrap snapshot load failed",
          }),
        ),
      getSnapshot: () => Effect.succeed(seededReadModel),
      getStartupSnapshot: () =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.snapshot.startup",
            detail: "unused in orchestration engine test",
          }),
        ),
      getThreadTailDetails: (_input) =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.snapshot.threadTailDetails",
            detail: "unused in orchestration engine test",
          }),
        ),
      getThreadHistoryPage: (_input) =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.snapshot.threadHistoryPage",
            detail: "unused in orchestration engine test",
          }),
        ),
      getThreadDetails: (_input) =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.snapshot.threadDetails",
            detail: "unused in orchestration engine test",
          }),
        ),
    } satisfies ProjectionSnapshotQueryShape);
    const fallbackSystem = await createPersistentOrchestrationSystem({
      dbPath,
      eventStoreLayer: makeRecordingEventStoreLayer(readCursors),
      projectionSnapshotQueryLayer: failingSnapshotQueryLayer,
    });
    const fallbackReadModel = await fallbackSystem.run(fallbackSystem.engine.getReadModel());

    expect(fallbackReadModel.snapshotSequence).toBe(latestSequence);
    expect(fallbackReadModel.projects.map((project) => project.id)).toContain(
      "project-snapshot-fallback",
    );
    expect(fallbackReadModel.threads.map((thread) => thread.id)).toContain(
      "thread-snapshot-fallback",
    );
    expect(readCursors).toContain(0);

    await fallbackSystem.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records orchestration command metrics and traces", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-orchestration-observability-"));
    const tracePath = path.join(tempDir, "traces.ndjson");
    const before = await Effect.runPromise(Metric.snapshot);
    const system = await createOrchestrationSystem({ tracePath });
    const createdAt = now();

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-observability"),
        projectId: asProjectId("project-observability"),
        title: "Observability Project",
        workspaceRoot: "/tmp/project-observability",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(Effect.sleep("25 millis"));

    const after = await system.run(Metric.snapshot);
    expect(
      counterValue(after, "t3_orchestration_commands_total", {
        commandType: "project.create",
        aggregateKind: "project",
        outcome: "success",
      }) -
        counterValue(before, "t3_orchestration_commands_total", {
          commandType: "project.create",
          aggregateKind: "project",
          outcome: "success",
        }),
    ).toBe(1);
    expect(
      histogramCount(after, "t3_orchestration_command_duration", {
        commandType: "project.create",
        aggregateKind: "project",
      }) -
        histogramCount(before, "t3_orchestration_command_duration", {
          commandType: "project.create",
          aggregateKind: "project",
        }),
    ).toBe(1);
    expect(
      histogramCount(after, "t3_orchestration_command_ack_duration", {
        commandType: "project.create",
        aggregateKind: "project",
        ackEventType: "project.created",
      }) -
        histogramCount(before, "t3_orchestration_command_ack_duration", {
          commandType: "project.create",
          aggregateKind: "project",
          ackEventType: "project.created",
        }),
    ).toBe(1);

    const traces = fs
      .readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name: string; attributes?: Record<string, unknown> });

    expect(
      traces.some(
        (record) =>
          record.name === "orchestration.command.project.create" &&
          record.attributes?.["orchestration.command_id"] === "cmd-project-observability" &&
          record.attributes?.["orchestration.command_type"] === "project.create" &&
          record.attributes?.["orchestration.aggregate_kind"] === "project" &&
          record.attributes?.["orchestration.aggregate_id"] === "project-observability",
      ),
    ).toBe(true);

    await system.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-create"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-delete"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-update"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-turn-diff-create"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-complete"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-flaky-1"),
          threadId: ThreadId.makeUnsafe("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-flaky-2"),
        threadId: ThreadId.makeUnsafe("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-atomic-create"),
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-turn-start-atomic"),
      threadId: ThreadId.makeUnsafe("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-sync-create"),
        threadId: ThreadId.makeUnsafe("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("projection failed");

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(3);
    expect(updatedThread?.title).toBe("sync-after-failed-projection");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-invariant-missing-thread"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
