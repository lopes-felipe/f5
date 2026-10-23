import { makeProjectionTurnRepository } from "../../persistence/Layers/ProjectionTurns.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { createPersistentOrchestrationSystem } from "../testUtils/persistentOrchestration.ts";
import { AcceptedShutdownWork, ServerShutdown, ShutdownRegistry } from "../../shutdown.ts";
import { ProviderControlTarget } from "../../provider/controlTarget.ts";
import { WorkspaceWriteContext } from "../../project/workspaceTransitionContext.ts";
import { workflowArchiveFixture } from "../workflowArchive.testUtils.ts";
import { workflowEntries, reconcileWorkflowArchives } from "../workflowArchiveLifecycle.ts";
import { WorkspaceTransitionsLive } from "../../persistence/Layers/WorkspaceTransitions.ts";
import { WorkspaceTransitions } from "../../persistence/Services/WorkspaceTransitions.ts";
import {
  NextTurnQueueStore,
  type NextTurnQueueStoreShape,
} from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../../git/testDoubles.ts";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

import {
  CheckpointRef,
  CommandId,
  EventId,
  ProviderInstanceId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  Deferred,
  Effect,
  Fiber,
  Exit,
  Scope,
  Layer,
  ManagedRuntime,
  Metric,
  Queue,
  Stream,
  Tracer,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ControlDeliveryClock, OrchestrationEngineLive } from "./OrchestrationEngine.ts";
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
import { DiskSpaceMonitor } from "../../storage/DiskSpaceMonitor.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeLocalFileTracer } from "../../observability/LocalFileTracer.ts";
import { makeTraceSink } from "../../observability/TraceSink.ts";

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

/** A monitor whose turn-start hold the test controls. */
function diskSpaceMonitorLayer(hold: { current: string | null }) {
  return Layer.succeed(DiskSpaceMonitor, {
    getStatus: () => Effect.die("unused"),
    turnStartHold: Effect.sync(() => hold.current),
    changes: Stream.empty,
    noteStorageChanged: Effect.void,
    start: () => Effect.void,
  });
}

async function createOrchestrationSystem(input?: {
  readonly tracePath?: string;
  readonly controlClock?: () => number;
  readonly git?: GitCoreShape;
  readonly queue?: NextTurnQueueStoreShape;
  readonly diskSpaceHold?: { current: string | null };
  readonly shutdown?: ShutdownRegistry;
}) {
  if (input?.tracePath) {
    fs.mkdirSync(path.dirname(input.tracePath), { recursive: true });
  }
  let flushTraces = Effect.void;
  const traceOptions = input?.tracePath
    ? {
        filePath: input.tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 1,
      }
    : null;
  const tracerLayer = traceOptions
    ? Layer.effect(
        Tracer.Tracer,
        Effect.gen(function* () {
          const sink = yield* makeTraceSink(traceOptions);
          flushTraces = sink.flush;
          return yield* makeLocalFileTracer({ ...traceOptions, sink });
        }),
      )
    : Layer.empty;
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(
      input?.controlClock ? Layer.succeed(ControlDeliveryClock, input.controlClock) : Layer.empty,
    ),
    Layer.provide(input?.shutdown ? Layer.succeed(ServerShutdown, input.shutdown) : Layer.empty),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(WorkspaceTransitionsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(input?.queue ? Layer.succeed(NextTurnQueueStore, input.queue) : Layer.empty),
    Layer.provide(input?.git ? Layer.succeed(GitCore, input.git) : Layer.empty),
    Layer.provide(input?.diskSpaceHold ? diskSpaceMonitorLayer(input.diskSpaceHold) : Layer.empty),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(tracerLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    engine,
    sql,
    transitions: await runtime.runPromise(Effect.service(WorkspaceTransitions)),
    flushTraces: () => runtime.runPromise(flushTraces),
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
  it("retains a retried message consistently in live, SQL, and replayed conversations", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.makeUnsafe("retried-revert");
    const projectId = ProjectId.makeUnsafe("retried-project");
    const at = "2026-10-22T12:00:00.000Z";
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("retry-project"),
          projectId,
          title: "Retry",
          workspaceRoot: process.cwd(),
          createdAt: at,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("retry-thread"),
          threadId,
          projectId,
          title: "Retry",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at,
        }),
      );
      for (let index = 1; index <= 3; index++) {
        await system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`retry-start-${index}`),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(`retry-message-${index}`),
              role: "user",
              text: `Prompt ${index}`,
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date(Date.parse(at) + index * 1000).toISOString(),
          }),
        );
      }
      const turns = await system.run(
        makeProjectionTurnRepository.pipe(Effect.provideService(SqlClient.SqlClient, system.sql)),
      );
      for (let index = 1; index <= 2; index++) {
        await system.run(
          turns.upsertByTurnId({
            threadId,
            turnId: TurnId.makeUnsafe(`retry-turn-${index}`),
            pendingMessageId: null,
            assistantMessageId: null,
            state: "completed",
            requestedAt: new Date(Date.parse(at) + index * 1000).toISOString(),
            startedAt: at,
            completedAt: at,
            processingQuiescedAt: at,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          }),
        );
        await system.run(
          system.sql`UPDATE provider_turn_deliveries SET state = 'accepted', provider_turn_id = ${`retry-turn-${index}`} WHERE command_id = ${`retry-start-${index + 1}`}`,
        );
      }
      const retained = (await system.run(turns.listByThreadId({ threadId }))).slice(0, 1);
      const retainedMessageIds = retained.flatMap((turn) =>
        turn.pendingMessageId ? [turn.pendingMessageId] : [],
      );
      expect(retainedMessageIds).toEqual(["retry-message-2"]);
      await system.run(
        system.engine.dispatch({
          type: "thread.revert.complete",
          commandId: CommandId.makeUnsafe("retry-revert"),
          threadId,
          turnCount: 1,
          retainedTurnIds: [TurnId.makeUnsafe("retry-turn-1")],
          retainedMessageIds,
          createdAt: at,
        }),
      );
      const live = (await system.run(system.engine.getReadModel())).threads[0]!.messages.map(
        (message) => message.id,
      );
      expect(live).toEqual(["retry-message-2"]);
      const stored = await system.run(
        system.sql<{
          id: string;
        }>`SELECT message_id AS id FROM projection_thread_messages WHERE thread_id = ${threadId}`,
      );
      expect(stored.map((message) => message.id)).toEqual(live);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      let replayed = createEmptyReadModel(at);
      for (const event of events) replayed = await Effect.runPromise(projectEvent(replayed, event));
      expect(replayed.threads[0]!.messages.map((message) => message.id)).toEqual(live);
    } finally {
      await system.dispose();
    }
  });

  it.each(["planning", "codeReview", "investigation"] as const)(
    "persists and replays an atomic %s workflow archive and restore",
    async (kind) => {
      const fixture = workflowArchiveFixture(kind);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-workflow-archive-"));
      const dbPath = path.join(directory, "state.sqlite");
      let system = await createPersistentOrchestrationSystem({ dbPath });
      try {
        const project = fixture.model.projects[0]!;
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("project"),
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            createdAt: project.createdAt,
          }),
        );
        for (const thread of fixture.model.threads) {
          await system.run(
            system.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe(thread.id),
              threadId: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              model: thread.model,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: thread.createdAt,
            }),
          );
        }
        const entry = fixture.entry;
        const commandId = CommandId.makeUnsafe("seed-workflow");
        if (entry.kind === "planning")
          await system.run(
            system.engine.dispatch({
              type: "project.workflow.upsert",
              commandId,
              projectId: project.id,
              workflow: entry.workflow,
              createdAt: project.createdAt,
            }),
          );
        else if (entry.kind === "codeReview")
          await system.run(
            system.engine.dispatch({
              type: "project.code-review-workflow.upsert",
              commandId,
              projectId: project.id,
              workflow: entry.workflow,
              updatedAt: project.createdAt,
            }),
          );
        else
          await system.run(
            system.engine.dispatch({
              type: "project.investigation-workflow.upsert",
              commandId,
              projectId: project.id,
              workflow: entry.workflow,
              updatedAt: project.createdAt,
            }),
          );
        const archive = fixture.archive();
        const accepted = await system.run(system.engine.dispatch(archive));
        expect(await system.run(system.engine.dispatch(archive))).toEqual(accepted);
        let model = await system.run(system.engine.getReadModel());
        expect(model.threads.every((thread) => thread.archivedAt !== null)).toBe(true);
        expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toHaveLength(2);
        const pauses = await system.run(system.sql<{
          threadId: string;
          paused: number;
          reason: string;
        }>`SELECT thread_id AS "threadId", paused, pause_reason_code AS reason
          FROM next_turn_queue_state ORDER BY thread_id`);
        expect(pauses).toEqual([
          { threadId: fixture.a, paused: 1, reason: "thread_archived" },
          { threadId: fixture.b, paused: 1, reason: "thread_archived" },
        ]);
        await system.dispose();
        system = await createPersistentOrchestrationSystem({ dbPath });
        model = await system.run(system.engine.getReadModel());
        expect(model.threads.every((thread) => thread.archivedAt !== null)).toBe(true);
        expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toHaveLength(2);
        await system.run(reconcileWorkflowArchives(system.engine));
        await system.run(system.engine.dispatch(fixture.archive(true)));
        model = await system.run(system.engine.getReadModel());
        expect(model.threads.every((thread) => thread.archivedAt === null)).toBe(true);
        expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toEqual([]);
        expect(await system.run(system.sql`SELECT paused FROM next_turn_queue_state`)).toEqual([
          { paused: 1 },
          { paused: 1 },
        ]);
      } finally {
        await system.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rolls back the workflow and all children if an archive projection fails", async () => {
    const system = await createOrchestrationSystem();
    const fixture = workflowArchiveFixture("planning");
    try {
      const project = fixture.model.projects[0]!;
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("project"),
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          createdAt: project.createdAt,
        }),
      );
      for (const thread of fixture.model.threads)
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(thread.id),
            threadId: thread.id,
            projectId: project.id,
            title: thread.title,
            model: thread.model,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: thread.createdAt,
          }),
        );
      await system.run(
        system.engine.dispatch({
          type: "project.workflow.upsert",
          commandId: CommandId.makeUnsafe("workflow"),
          projectId: project.id,
          workflow: fixture.model.planningWorkflows[0]!,
          createdAt: project.createdAt,
        }),
      );
      await system.run(
        system.sql.unsafe(
          "CREATE TRIGGER refuse_archive BEFORE UPDATE OF archived_at ON projection_threads " +
            "WHEN NEW.thread_id = 'archive-b' AND NEW.archived_at IS NOT NULL " +
            "BEGIN SELECT RAISE(ABORT, 'injected archive failure'); END",
        ),
      );
      await expect(system.run(system.engine.dispatch(fixture.archive()))).rejects.toThrow();
      const model = await system.run(system.engine.getReadModel());
      expect(model.planningWorkflows[0]!.archivedAt).toBeNull();
      expect(model.threads.every((thread) => thread.archivedAt === null)).toBe(true);
      const rows = await system.run(
        system.sql.unsafe<{ archivedAt: string | null }>(
          "SELECT archived_at AS archivedAt FROM projection_threads",
        ),
      );
      expect(rows.every((row) => row.archivedAt === null)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("commits transition completion, metadata and receipt atomically and replays a lost response", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.makeUnsafe("transition-thread");
    const projectId = ProjectId.makeUnsafe("transition-project");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("transition-project"),
          projectId,
          title: "Project",
          workspaceRoot: "/repo",
          defaultModel: "gpt-5-codex",
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("transition-thread"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "main",
          worktreePath: null,
          createdAt,
        }),
      );
      const expected = { branch: "main", worktreePath: null, sessionUpdatedAt: null };
      const identity = { path: "/repo", repository: "/repo/.git", branch: "main", headSha: "a" };
      let record = await system.run(
        system.transitions.reserve({
          operationId: "switch",
          threadId,
          version: 0,
          intent: "attach_existing",
          phase: "reserved",
          source: identity,
          target: { ...identity, path: "/managed/topic", branch: "topic" },
          observed: null,
          fingerprint: null,
          mutationAttempted: false,
          request: { operationId: "switch", threadId, intent: "attach_existing", expected },
          requestHash: "switch",
          commandId: "workspace:switch",
          setupOwnerToken: null,
          result: null,
          error: null,
          createdAt,
          updatedAt: createdAt,
        }),
      );
      // Neither a public metadata write nor a queue resume may bypass reservation.
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("bypass"),
            threadId,
            branch: "bypass",
          }),
        ),
      ).rejects.toThrow(/transition/);
      const turn = {
        type: "thread.turn.start" as const,
        commandId: CommandId.makeUnsafe("blocked-turn"),
        threadId,
        message: {
          messageId: asMessageId("blocked-message"),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required" as const,
        createdAt,
      };
      await expect(system.run(system.engine.dispatch(turn))).rejects.toThrow(/transition/);
      record = await system.run(
        system.transitions.update(record, {
          phase: "applied",
          result: { ...expected, branch: "topic", worktreePath: "/managed/topic" },
        }),
      );
      const command = {
        type: "thread.meta.update" as const,
        commandId: CommandId.makeUnsafe(record.commandId),
        threadId,
        branch: "topic",
        worktreePath: "/managed/topic",
      };
      await expect(
        system.run(
          system.engine.dispatch(command).pipe(
            Effect.provideService(WorkspaceWriteContext, {
              expected,
              operationId: record.operationId,
              version: record.version - 1,
            }),
          ),
        ),
      ).rejects.toThrow(/changed/);
      // A rejected command receipt cannot be reused; completion uses its reserved unique command.
      const valid = { ...command, commandId: CommandId.makeUnsafe("workspace:switch:commit") };
      await system.run(
        system.engine.dispatch(valid).pipe(
          Effect.provideService(WorkspaceWriteContext, {
            expected,
            operationId: record.operationId,
            version: record.version,
          }),
        ),
      );
      expect((await system.run(system.transitions.get("switch")))?.phase).toBe("completed");
      expect(
        (await system.run(system.engine.getReadModel())).threads.find(
          (thread) => thread.id === threadId,
        ),
      ).toMatchObject({ branch: "topic", worktreePath: "/managed/topic" });
      expect(await system.run(system.engine.dispatch(valid))).toEqual(
        await system.run(system.engine.dispatch(valid)),
      );
      const receipts = await system.run(
        system.sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${valid.commandId} AND status='accepted'`,
      );
      expect(receipts).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });

  it("keeps the command worker available during workspace verification and rejects changed metadata", async () => {
    const target = await canonicalWorktreePath(
      fs.mkdtempSync(path.join(os.tmpdir(), "f5-engine-workspace-")),
    );
    const commonDir = await canonicalWorktreePath(path.join(target, ".git"));
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const fake = makeFakeGitCore({
      listWorktrees: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as([
            {
              path: target,
              canonicalPath: target,
              branch: "feature",
              headSha: "abc",
              isMain: false,
              bare: false,
              detached: false,
              locked: null,
              prunable: null,
            },
          ]),
        ),
      inspectCheckoutIdentity: () =>
        Effect.succeed({ canonicalRoot: target, commonDir, branch: "feature" }),
      resolveCommonDir: () => Effect.succeed(commonDir),
    });
    const system = await createOrchestrationSystem({ git: fake.service });
    const threadId = ThreadId.makeUnsafe("workspace-thread");
    const projectId = asProjectId("workspace-project");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("workspace-project"),
          projectId,
          title: "Project",
          workspaceRoot: target,
          defaultModel: "gpt-5-codex",
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("workspace-thread"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "feature",
          worktreePath: target,
          createdAt,
        }),
      );
      const pending = system.run(
        system.engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("workspace-start"),
            threadId,
            message: {
              messageId: asMessageId("workspace-message"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          })
          .pipe(Effect.flip),
      );
      await system.run(Deferred.await(entered));
      // This must finish while the Git probe remains deliberately blocked.
      await system.run(
        system.engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("workspace-change"),
            threadId,
            branch: "main",
            worktreePath: null,
          })
          .pipe(
            Effect.provideService(WorkspaceWriteContext, {
              expected: { branch: "feature", worktreePath: target, sessionUpdatedAt: null },
            }),
            Effect.timeout("2 seconds"),
          ),
      );
      await system.run(Deferred.succeed(release, undefined));
      expect((await pending).message).toContain("workspace changed");
    } finally {
      await system.run(Deferred.succeed(release, undefined));
      await system.dispose();
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("admits steers into the live turn on a drifted branch but not new turns", async () => {
    const target = await canonicalWorktreePath(
      fs.mkdtempSync(path.join(os.tmpdir(), "f5-engine-drift-")),
    );
    const commonDir = await canonicalWorktreePath(path.join(target, ".git"));
    // The agent switched the recorded `feature` worktree to another branch.
    const fake = makeFakeGitCore({
      listWorktrees: () =>
        Effect.succeed([
          {
            path: target,
            canonicalPath: target,
            branch: "agent-branch",
            headSha: "abc",
            isMain: false,
            bare: false,
            detached: false,
            locked: null,
            prunable: null,
          },
        ]),
      inspectCheckoutIdentity: () =>
        Effect.succeed({ canonicalRoot: target, commonDir, branch: "agent-branch" }),
      resolveCommonDir: () => Effect.succeed(commonDir),
    });
    const system = await createOrchestrationSystem({ git: fake.service });
    const threadId = ThreadId.makeUnsafe("drift-thread");
    const projectId = asProjectId("drift-project");
    const createdAt = now();
    const turn = (id: string) => ({
      commandId: CommandId.makeUnsafe(id),
      threadId,
      message: { messageId: asMessageId(id), role: "user" as const, text: id, attachments: [] },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    });
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("drift-project"),
          projectId,
          title: "Project",
          workspaceRoot: target,
          defaultModel: "gpt-5-codex",
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("drift-thread"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "feature",
          worktreePath: target,
          createdAt,
        }),
      );
      const liveTurn = TurnId.makeUnsafe("live-turn");
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("drift-session"),
          threadId,
          createdAt,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: null,
            runtimeMode: "approval-required",
            activeTurnId: liveTurn,
            lastError: null,
            lastErrorId: null,
            lastErrorOccurredAt: null,
            lastErrorRetryability: null,
            updatedAt: createdAt,
          },
        }),
      );
      const rejected = await system.run(
        system.engine
          .dispatch({ type: "thread.turn.start", ...turn("drift-start") })
          .pipe(Effect.flip),
      );
      expect(rejected.message).toContain("does not match this repository and branch");
      const steerError = await system.run(
        system.engine
          .dispatch({
            type: "thread.turn.steer",
            ...turn("drift-steer"),
            expectedTurnId: liveTurn,
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.message),
            Effect.orElseSucceed(() => null),
          ),
      );
      expect(steerError).toBeNull();
    } finally {
      await system.dispose();
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it.each([
    "transient",
    "barrier",
    "steer-fallback",
    "direct-transient",
    "direct-barrier",
  ] as const)("accepts work after %s without poisoning the command receipt", async (scenario) => {
    const target = await canonicalWorktreePath(
      fs.mkdtempSync(path.join(os.tmpdir(), "f5-engine-retry-")),
    );
    const commonDir = await canonicalWorktreePath(path.join(target, ".git"));
    let failProbe = scenario.endsWith("transient");
    let blocked = scenario.endsWith("barrier");
    const fake = makeFakeGitCore({
      listWorktrees: () =>
        failProbe
          ? Effect.fail(
              new GitCommandError({
                operation: "test",
                command: "git worktree list",
                cwd: target,
                detail: "temporarily unavailable",
              }),
            )
          : Effect.succeed([
              {
                path: target,
                canonicalPath: target,
                branch: "feature",
                headSha: "abc",
                isMain: false,
                bare: false,
                detached: false,
                locked: null,
                prunable: null,
              },
            ]),
      inspectCheckoutIdentity: () =>
        Effect.succeed({ canonicalRoot: target, commonDir, branch: "feature" }),
      resolveCommonDir: () => Effect.succeed(commonDir),
    });
    const system = await createOrchestrationSystem({
      git: fake.service,
      queue: {
        listByThread: () =>
          Effect.succeed({
            state: { worktreeBlockToken: blocked ? "recovery:test" : null },
            items: [],
          }),
      } as unknown as NextTurnQueueStoreShape,
    });
    const threadId = ThreadId.makeUnsafe("retry-thread");
    const projectId = asProjectId("retry-project");
    const createdAt = now();
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("retry-turn"),
      threadId,
      ...(!scenario.startsWith("direct-") ? { dispatchSource: "next-turn-queue" as const } : {}),
      message: {
        messageId: asMessageId("retry-message"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("retry-project"),
          projectId,
          title: "Project",
          workspaceRoot: target,
          defaultModel: "gpt-5-codex",
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("retry-thread"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "feature",
          worktreePath: target,
          createdAt,
        }),
      );
      if (scenario === "steer-fallback") {
        // An accepted receipt whose delivery was confirmed not sent and requeued as a start.
        await system.run(system.engine.dispatch(command));
        await system.run(
          system.sql`UPDATE provider_turn_deliveries SET state = 'rejected', certainty = 'not_sent', event_json = json_set(event_json, '$.type', 'thread.turn-steer-requested', '$.payload.expectedTurnId', 'prior-turn') WHERE command_id = ${command.commandId}`,
        );
        await system.run(
          system.sql`INSERT INTO next_turn_queue (item_id, thread_id, submission_id, command_id, message_id, position, command_json, last_error_code, created_at, updated_at) VALUES ('fallback', ${threadId}, 'fallback', ${command.commandId}, ${command.message.messageId}, 0, '{}', 'steer_queued', ${createdAt}, ${createdAt})`,
        );
      } else {
        expect(await system.run(system.engine.dispatch(command).pipe(Effect.flip))).toMatchObject({
          _tag: "ThreadTurnNotReadyError",
        });
      }
      failProbe = false;
      blocked = false;
      await system.run(system.engine.dispatch(command));
      const deliveries = await system.run(
        system.sql<{
          state: string;
          type: string;
        }>`SELECT state, json_extract(event_json, '$.type') AS type FROM provider_turn_deliveries WHERE command_id = ${command.commandId}`,
      );
      expect(deliveries).toEqual([{ state: "pending", type: "thread.turn-start-requested" }]);
      expect(fake.calls.listWorktrees.length).toBeGreaterThanOrEqual(2);
    } finally {
      await system.dispose();
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

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

  it("holds turn starts while disk space is critical", async () => {
    const createdAt = now();
    const hold = { current: "Only 1 GB of disk space is free." as string | null };
    const system = await createOrchestrationSystem({ diskSpaceHold: hold });
    const { engine } = system;
    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-disk-project"),
          projectId: asProjectId("disk-project"),
          title: "Disk project",
          workspaceRoot: "/tmp/disk-project",
          defaultModel: "gpt-5-codex",
          createdAt,
        }),
      );
      // Other commands are not held.
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-disk-thread"),
          threadId: ThreadId.makeUnsafe("disk-thread"),
          projectId: asProjectId("disk-project"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const turnStart = (commandId: string, dispatchSource?: "next-turn-queue") => ({
        type: "thread.turn.start" as const,
        commandId: CommandId.makeUnsafe(commandId),
        threadId: ThreadId.makeUnsafe("disk-thread"),
        message: {
          messageId: asMessageId(`${commandId}-message`),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required" as const,
        ...(dispatchSource ? { dispatchSource } : {}),
        createdAt,
      });

      const direct = await system.run(Effect.flip(engine.dispatch(turnStart("cmd-disk-direct"))));
      expect(direct._tag).toBe("OrchestrationCommandInvariantError");
      expect(direct.message).toContain("Only 1 GB of disk space is free.");
      expect(direct.message).toContain("send the turn again");

      // The queue retries a not-ready turn on its own, without spending an attempt.
      const queued = await system.run(
        Effect.flip(engine.dispatch(turnStart("cmd-disk-queued", "next-turn-queue"))),
      );
      expect(queued._tag).toBe("ThreadTurnNotReadyError");
      expect(queued.message).toContain("starts once there is room");

      // A held turn records nothing, so the same command goes through once space is free.
      hold.current = null;
      await system.run(engine.dispatch(turnStart("cmd-disk-queued", "next-turn-queue")));
      const readModel = await system.run(engine.getReadModel());
      const thread = readModel.threads.find((entry) => entry.id === "disk-thread");
      expect(thread?.messages.map((message) => message.id)).toEqual([
        asMessageId("cmd-disk-queued-message"),
      ]);

      // A held direct start is rejected for good, as its message says.
      const replayed = await system.run(Effect.flip(engine.dispatch(turnStart("cmd-disk-direct"))));
      expect(replayed._tag).toBe("OrchestrationCommandPreviouslyRejectedError");
    } finally {
      await system.dispose();
    }
  });

  it("rejects cross-aggregate command reuse without replacing the original receipt", async () => {
    const system = await createOrchestrationSystem();
    try {
      const command = {
        type: "project.create" as const,
        commandId: CommandId.makeUnsafe("shared-command"),
        projectId: asProjectId("receipt-project"),
        title: "Receipt project",
        workspaceRoot: "/tmp/receipt-project",
        defaultModel: "gpt-5-codex",
        createdAt: now(),
      };
      const accepted = await system.run(system.engine.dispatch(command));
      await expect(
        system.run(
          system.engine.dispatch({
            ...command,
            projectId: asProjectId("other-project"),
          }),
        ),
      ).rejects.toThrow("belongs to project 'receipt-project'");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.delete",
            commandId: command.commandId,
            threadId: ThreadId.makeUnsafe("receipt-project"),
          }),
        ),
      ).rejects.toThrow("not thread 'receipt-project'");
      expect(await system.run(system.engine.dispatch(command))).toEqual(accepted);
      const rejected = {
        type: "thread.delete" as const,
        commandId: CommandId.makeUnsafe("rejected-command"),
        threadId: ThreadId.makeUnsafe("absent-thread"),
      };
      await expect(system.run(system.engine.dispatch(rejected))).rejects.toThrow();
      await expect(
        system.run(
          system.engine.dispatch({
            ...rejected,
            threadId: ThreadId.makeUnsafe("other-thread"),
          }),
        ),
      ).rejects.toThrow("belongs to thread 'absent-thread'");
      await expect(system.run(system.engine.dispatch(rejected))).rejects.toThrow(
        "previously rejected",
      );
      expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(
        accepted.sequence,
      );
    } finally {
      await system.dispose();
    }
  });

  it.each(["thread.pins.replace", "thread.pins.import-legacy"] as const)(
    "%s retries current and legacy receipts without accepting another anchor",
    async (type) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-pin-receipts-"));
      const dbPath = path.join(directory, "state.sqlite");
      let system = await createPersistentOrchestrationSystem({ dbPath });
      try {
        const createdAt = now();
        const projectId = asProjectId("pin-project");
        const threadId = ThreadId.makeUnsafe("pin-anchor");
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("pin-project"),
            projectId,
            title: "Pins",
            workspaceRoot: directory,
            defaultModel: "gpt-5-codex",
            createdAt,
          }),
        );
        for (const id of [threadId, ThreadId.makeUnsafe("other-anchor")]) {
          await system.run(
            system.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe(`create-${id}`),
              threadId: id,
              projectId,
              title: "Pins",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt,
            }),
          );
        }
        const command = {
          type,
          commandId: CommandId.makeUnsafe("pin-command"),
          threadId,
          pinnedThreadIds: [threadId],
          legacyThreadIds: [threadId],
          expectedRevision: 0,
          createdAt,
        };
        const accepted = await system.run(system.engine.dispatch(command));
        const model = await system.run(system.engine.getReadModel());
        expect(await system.run(system.engine.dispatch(command))).toEqual(accepted);
        await expect(
          system.run(
            system.engine.dispatch({ ...command, threadId: ThreadId.makeUnsafe("other-anchor") }),
          ),
        ).rejects.toThrow("belongs to thread");
        await system.dispose();
        const db = new DatabaseSync(dbPath);
        try {
          expect(
            db
              .prepare(
                "SELECT aggregate_kind, aggregate_id FROM orchestration_command_receipts WHERE command_id = ?",
              )
              .get(command.commandId),
          ).toMatchObject({ aggregate_kind: "thread", aggregate_id: threadId });
          db.prepare(
            "UPDATE orchestration_command_receipts SET aggregate_kind = 'project', aggregate_id = 'f5-global-pins' WHERE command_id = ?",
          ).run(command.commandId);
        } finally {
          db.close();
        }
        system = await createPersistentOrchestrationSystem({ dbPath });
        expect(await system.run(system.engine.dispatch(command))).toEqual(accepted);
        await expect(
          system.run(
            system.engine.dispatch({ ...command, threadId: ThreadId.makeUnsafe("other-anchor") }),
          ),
        ).rejects.toThrow("belongs to project");
        expect(await system.run(system.engine.dispatch(command))).toEqual(accepted);
        expect((await system.run(system.engine.getReadModel())).pinRevision).toBe(
          model.pinRevision,
        );
        expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(
          accepted.sequence,
        );
      } finally {
        await system.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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
    await seededSystem.run(
      seededSystem.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-snapshot-delete"),
        threadId: ThreadId.makeUnsafe("thread-snapshot"),
      }),
    );

    const checkpointReadModel = await seededSystem.run(seededSystem.engine.getReadModel());
    for (let index = 0; index < 1001; index++) {
      await seededSystem.run(
        seededSystem.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe(`cmd-warm-update-${index}`),
          projectId: asProjectId("project-snapshot"),
          title: `Updated ${index}`,
        }),
      );
    }

    const seededReadModel = await seededSystem.run(seededSystem.engine.getReadModel());
    const latestSequence = seededReadModel.snapshotSequence;
    await seededSystem.dispose();

    const readCursors: number[] = [];
    const warmSystem = await createPersistentOrchestrationSystem({
      dbPath,
      eventStoreLayer: makeRecordingEventStoreLayer(readCursors),
      projectionSnapshotQueryLayer: Layer.effect(
        ProjectionSnapshotQuery,
        Effect.gen(function* () {
          const live = yield* ProjectionSnapshotQuery;
          return { ...live, getBootstrapSnapshot: () => Effect.succeed(checkpointReadModel) };
        }),
      ).pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive)),
    });
    const warmReadModel = await warmSystem.run(warmSystem.engine.getReadModel());

    expect(warmReadModel.snapshotSequence).toBe(latestSequence);
    expect(warmReadModel.projects.map((project) => project.id)).toContain("project-snapshot");
    expect(warmReadModel.threads.map((thread) => thread.id)).toContain("thread-snapshot");
    expect(
      warmReadModel.threads.find((thread) => thread.id === "thread-snapshot")?.deletedAt,
    ).toEqual(seededReadModel.threads.find((thread) => thread.id === "thread-snapshot")?.deletedAt);
    expect(readCursors).toContain(checkpointReadModel.snapshotSequence);
    expect(readCursors).not.toContain(0);

    await warmSystem.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }, 60_000);

  it("gives each scratch thread its own folder and keeps it across a restart", async () => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-scratch-engine-")));
    const dbPath = path.join(tempDir, "state.sqlite");
    const scratchRoot = path.join(tempDir, "scratch");
    const createdAt = "2026-10-22T09:30:00.000Z";
    const threadId = ThreadId.makeUnsafe("0f9e8d7c-1111-2222-3333-444455556666");
    const system = await createPersistentOrchestrationSystem({ dbPath });
    await system.run(
      system.engine.dispatch({
        type: "project.scratch.create",
        commandId: CommandId.makeUnsafe("cmd-scratch-create"),
        projectId: asProjectId("scratch"),
        workspaceRoot: scratchRoot,
        createdAt,
      }),
    );
    const create = {
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-scratch-thread"),
      threadId,
      projectId: asProjectId("scratch"),
      title: "New thread",
      scratchFolderWords: "Fix the login page, please! Then more words",
      model: "gpt-5-codex",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    } as const;
    await system.run(system.engine.dispatch(create));
    // A retried create replays its receipt and allocates nothing new.
    await system.run(system.engine.dispatch(create));
    const folder = path.join(scratchRoot, "2026-10-22-fix-the-login-page-please-0f9e8d7c");
    const model = await system.run(system.engine.getReadModel());
    expect(model.threads.find((thread) => thread.id === threadId)?.scratchPath).toBe(folder);
    expect(fs.statSync(folder).isDirectory()).toBe(true);
    expect(fs.readdirSync(scratchRoot)).toEqual([path.basename(folder)]);
    // A rejected create leaves no folder behind, and one the decider would refuse is never made.
    for (const rejected of [
      { commandId: "cmd-scratch-duplicate", scratchFolderWords: "Another folder" },
      { commandId: "cmd-scratch-branch", threadId: "other-thread", branch: "feature" },
    ])
      await expect(
        system.run(
          system.engine.dispatch({
            ...create,
            ...rejected,
            commandId: CommandId.makeUnsafe(rejected.commandId),
            threadId: ThreadId.makeUnsafe(rejected.threadId ?? threadId),
          }),
        ),
      ).rejects.toThrow();
    expect(fs.readdirSync(scratchRoot)).toEqual([path.basename(folder)]);
    // A creation time that is not a date stays out of the name, so it cannot leave the root.
    await system.run(
      system.engine.dispatch({
        ...create,
        commandId: CommandId.makeUnsafe("cmd-scratch-escape"),
        threadId: ThreadId.makeUnsafe("escape-thread"),
        scratchFolderWords: "Escape",
        createdAt: "../../evil",
      }),
    );
    expect(fs.readdirSync(scratchRoot).sort()).toEqual(
      [path.basename(folder), "escape-escapeth"].sort(),
    );
    expect(fs.existsSync(path.join(tempDir, "evil"))).toBe(false);
    await system.dispose();

    const restarted = await createPersistentOrchestrationSystem({ dbPath });
    const restored = await restarted.run(restarted.engine.getReadModel());
    expect(restored.projects.find((project) => project.id === "scratch")?.kind).toBe("scratch");
    expect(restored.threads.find((thread) => thread.id === threadId)?.scratchPath).toBe(folder);
    await restarted.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }, 60_000);

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

    for (let index = 0; index < 1001; index++) {
      await seededSystem.run(
        seededSystem.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`cmd-fallback-update-${index}`),
          threadId: ThreadId.makeUnsafe("thread-snapshot-fallback"),
          title: `Updated ${index}`,
        }),
      );
    }

    const seededReadModel = await seededSystem.run(seededSystem.engine.getReadModel());
    const latestSequence = seededReadModel.snapshotSequence;
    await seededSystem.dispose();

    const readCursors: number[] = [];
    const failingSnapshotQueryLayer = Layer.succeed(ProjectionSnapshotQuery, {
      searchThread: () => Effect.die("unused thread search"),
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
      getRewindDrafts: ({ threadId }) => Effect.succeed({ threadId, drafts: [] }),
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
  }, 60_000);

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

    await system.flushTraces();
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

  it("deletes a project after child threads are deleted through dispatch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-delete-dispatch");
    const threadId = ThreadId.makeUnsafe("thread-delete-dispatch");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-delete-dispatch-create"),
        projectId,
        title: "Delete Dispatch Project",
        workspaceRoot: "/tmp/project-delete-dispatch",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-delete-dispatch-create"),
        threadId,
        projectId,
        title: "delete me",
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
        commandId: CommandId.makeUnsafe("cmd-thread-delete-dispatch-delete"),
        threadId,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("cmd-project-delete-dispatch-delete"),
        projectId,
      }),
    );

    const readModel = await system.run(engine.getReadModel());
    expect(readModel.threads.find((thread) => thread.id === threadId)?.deletedAt).not.toBeNull();
    expect(
      readModel.projects.find((project) => project.id === projectId)?.deletedAt,
    ).not.toBeNull();
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
      collectCommandIdsForThread(threadId) {
        return Effect.succeed(
          events
            .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
            .map((event) => event.commandId)
            .filter((commandId): commandId is CommandId => commandId !== null),
        );
      },
      deleteForThreadStream(threadId) {
        return Effect.sync(() => {
          const retained = events.filter(
            (event) => event.aggregateKind !== "thread" || event.aggregateId !== threadId,
          );
          events.splice(0, events.length, ...retained);
        });
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
      readFromSequence(sequenceExclusive, limit = 1000) {
        return Stream.fromIterable(
          events.filter((event) => event.sequence > sequenceExclusive).slice(0, limit),
        );
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      collectCommandIdsForThread(threadId) {
        return Effect.succeed(
          events
            .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
            .map((event) => event.commandId)
            .filter((commandId): commandId is CommandId => commandId !== null),
        );
      },
      deleteForThreadStream(threadId) {
        return Effect.sync(() => {
          const retained = events.filter(
            (event) => event.aggregateKind !== "thread" || event.aggregateId !== threadId,
          );
          events.splice(0, events.length, ...retained);
        });
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
          for (let index = 0; index < 1001; index++) {
            events.push({
              ...event,
              eventId: `recovery-${index}` as OrchestrationEvent["eventId"],
              sequence: nextSequence++,
            } as StoredEvent);
          }
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

    // The recovery-* events stand in for events another server appended to a
    // shared state directory; reconcile must not republish them.
    const publishedEventIds: string[] = [];
    const subscription = runtime.runFork(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        Effect.sync(() => {
          publishedEventIds.push(event.eventId);
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.runPromise(Fiber.interrupt(subscription));
    expect(publishedEventIds).toHaveLength(1);
    expect(publishedEventIds.some((id) => id.startsWith("recovery-"))).toBe(false);

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(1004);
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

  it("CAS-updates a thread branch and rejects stale branch drift decisions", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-branch-cas");
    const threadId = ThreadId.makeUnsafe("thread-branch-cas");
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-branch-cas"),
        projectId,
        title: "Branch CAS",
        workspaceRoot: "/tmp/project-branch-cas",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-branch-cas"),
        threadId,
        projectId,
        title: "branch-cas",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "feature/original",
        worktreePath: null,
        createdAt,
      }),
    );
    // A session event can land after a verified branch observation captured its expected context.
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("session-during-observation"),
        threadId,
        createdAt,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: null,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          lastErrorId: null,
          lastErrorOccurredAt: null,
          lastErrorRetryability: null,
          updatedAt: createdAt,
        },
      }),
    );
    await system.run(
      engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-branch-cas-success"),
          threadId,
          branch: "feature/current",
          expectedBranch: "feature/original",
        })
        .pipe(
          Effect.provideService(WorkspaceWriteContext, {
            expected: { branch: "feature/original", worktreePath: null, sessionUpdatedAt: null },
            observation: true,
          }),
        ),
    );

    await expect(
      system.run(
        engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-thread-branch-cas-stale"),
            threadId,
            branch: "feature/stale",
            expectedBranch: "feature/original",
          })
          .pipe(
            Effect.provideService(WorkspaceWriteContext, {
              expected: { branch: "feature/current", worktreePath: null, sessionUpdatedAt: null },
              observation: true,
            }),
          ),
      ),
    ).rejects.toThrow("branch changed before metadata update");
    expect(
      (await system.run(engine.getReadModel())).threads.find((entry) => entry.id === threadId),
    ).toMatchObject({ branch: "feature/current" });

    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-for-root-guard"),
        threadId,
        createdAt,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("move-project-root"),
          projectId,
          workspaceRoot: "/tmp/moved-checkout",
        }),
      ),
    ).rejects.toThrow("Conversations still reference this project workspace");
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

describe("usage recovery stop durability", () => {
  it.each(["queued", "dispatching"] as const)(
    "commits %s resume cancellation before subscribers and retains it on restart",
    async (queueStatus) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-stop-resume-"));
      const dbPath = path.join(directory, "state.sqlite");
      let system = await createPersistentOrchestrationSystem({ dbPath });
      const threadId = ThreadId.makeUnsafe("stop-resume-thread");
      const at = now();
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("stop-project"),
            projectId: asProjectId("stop-project"),
            title: "Project",
            workspaceRoot: directory,
            defaultModel: "gpt-5-codex",
            createdAt: at,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("stop-thread"),
            threadId,
            projectId: asProjectId("stop-project"),
            title: "Thread",
            model: "gpt-5-codex",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: at,
          }),
        );
        const db = new DatabaseSync(dbPath);
        db.prepare(
          "INSERT INTO next_turn_queue_state(thread_id, revision, updated_at) VALUES (?, 1, ?)",
        ).run(threadId, at);
        db.prepare(
          "INSERT INTO next_turn_queue(item_id, thread_id, submission_id, command_id, message_id, position, command_json, created_at, updated_at, schedule_reason, schedule_limit_key) VALUES ('resume', ?, 'resume', 'resume', 'resume', 0, '{}', ?, ?, 'usage_limit_reset', 'failure')",
        ).run(threadId, at, at);
        db.prepare(
          "INSERT INTO turn_submissions(submission_id, thread_id, request_hash, message_id, disposition, created_at) VALUES ('resume', ?, 'hash', 'resume', 'queued', ?)",
        ).run(threadId, at);
        db.prepare(
          "INSERT INTO usage_limit_resumes(thread_id, limit_key, state, source, auto_eligible_at_failure, item_id, created_at, updated_at) VALUES (?, 'failure', 'scheduled', 'auto', 1, 'resume', ?, ?)",
        ).run(threadId, at, at);
        db.prepare("UPDATE next_turn_queue SET status=? WHERE item_id='resume'").run(queueStatus);
        db.close();
        // No dispatcher or event subscriber is running in this engine-only fixture.
        await system.run(
          system.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("stop-intent"),
            threadId,
            createdAt: at,
          }),
        );
        if (queueStatus === "dispatching") {
          await expect(
            system.run(
              system.engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.makeUnsafe("resume"),
                threadId,
                dispatchSource: "next-turn-queue",
                presentation: "continuation",
                runtimeMode: "approval-required",
                interactionMode: "default",
                message: {
                  messageId: MessageId.makeUnsafe("resume"),
                  role: "user",
                  text: "continue",
                  attachments: [],
                },
                createdAt: at,
              }),
            ),
          ).rejects.toThrow("cancelled before acceptance");
        }
        await system.dispose();
        system = await createPersistentOrchestrationSystem({ dbPath });
        const restarted = new DatabaseSync(dbPath);
        expect(
          restarted.prepare("SELECT deleted_at FROM next_turn_queue WHERE item_id='resume'").get()
            ?.deleted_at,
        ).toBe(queueStatus === "queued" ? at : null);
        expect(
          restarted.prepare("SELECT state FROM usage_limit_resumes WHERE item_id='resume'").get()
            ?.state,
        ).toBe("cancelled");
        expect(
          restarted
            .prepare("SELECT disposition FROM turn_submissions WHERE submission_id='resume'")
            .get()?.disposition,
        ).toBe(queueStatus === "queued" ? "canceled" : "queued");
        expect(
          restarted
            .prepare("SELECT revision FROM next_turn_queue_state WHERE thread_id=?")
            .get(threadId)?.revision,
        ).toBe(queueStatus === "queued" ? 2 : 1);
        expect(
          restarted
            .prepare(
              "SELECT count(*) AS count FROM provider_turn_deliveries WHERE command_id='resume'",
            )
            .get()?.count,
        ).toBe(0);
        restarted.close();
      } finally {
        await system.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

it("reconciles proven native rewind turns durably while preserving other providers and the active command", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-native-rewind-"));
  const dbPath = path.join(directory, "state.sqlite");
  let system = await createPersistentOrchestrationSystem({ dbPath });
  try {
    const { engine, run, sql } = system;
    const threadId = ThreadId.make("native-rewind-thread");
    const projectId = ProjectId.make("native-rewind-project");
    const instanceId = ProviderInstanceId.make("pi-native");
    const createdAt = "2026-10-19T00:00:00.000Z";
    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("native-project"),
        projectId,
        title: "Native",
        workspaceRoot: "/tmp/native-rewind-project",
        defaultModel: "default",
        createdAt,
      }),
    );
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("native-thread"),
        threadId,
        projectId,
        title: "Native",
        model: "default",
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const ids = ["other-provider", "kept-pi", "removed-pi", "rewinding-command"].map((id) =>
      TurnId.make(id),
    );
    for (const [index, turnId] of ids.entries()) {
      await run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`user-command-${index}`),
          threadId,
          message: {
            messageId: MessageId.make(`user-${index}`),
            role: "user",
            text: `Prompt ${index}`,
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt,
        }),
      );
      const session = {
        threadId,
        status: "running" as const,
        providerName: index === 0 ? ("codex" as const) : ("pi" as const),
        providerInstanceId: instanceId,
        runtimeMode: "approval-required" as const,
        activeTurnId: turnId,
        lastError: null,
        lastErrorId: null,
        lastErrorOccurredAt: null,
        lastErrorRetryability: null,
        updatedAt: createdAt,
      };
      await run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`session-${index}`),
          threadId,
          session,
          createdAt,
        }),
      );
      await run(
        engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`message-${index}`),
          threadId,
          messageId: MessageId.make(`message-${index}`),
          turnId,
          delta: `Reply ${turnId}`,
          createdAt,
        }),
      );
      await run(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`activity-${index}`),
          threadId,
          activity: {
            id: EventId.make(`activity-${index}`),
            kind: "tool.completed",
            tone: "tool",
            summary: turnId,
            turnId,
            payload: {},
            createdAt,
          },
          createdAt,
        }),
      );
      if (index < 3) {
        await run(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`ready-${index}`),
            threadId,
            session: { ...session, status: "ready", activeTurnId: null },
            settledTurnId: turnId,
            createdAt,
          }),
        );
      }
    }
    const reconcile = {
      type: "thread.native-history.reconcile" as const,
      commandId: CommandId.make("native-reconcile"),
      threadId,
      providerInstanceId: instanceId,
      expectedTurnId: ids[3]!,
      removedTurnIds: [ids[2]!],
      createdAt,
    };
    const result = await run(engine.dispatch(reconcile));
    expect(await run(engine.dispatch(reconcile))).toEqual(result);
    const thread = (await run(engine.getReadModel())).threads.find(
      (thread) => thread.id === threadId,
    )!;
    expect(
      thread.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.turnId),
    ).toEqual([ids[0], ids[1], ids[3]]);
    expect(
      thread.messages.filter((message) => message.role === "user").map((message) => message.id),
    ).toEqual(["user-0", "user-1", "user-3"]);
    expect(thread.activities.map((activity) => activity.turnId)).toEqual([ids[0], ids[1], ids[3]]);
    expect(thread.latestTurn?.turnId).toBe(ids[3]);
    expect(thread.session?.activeTurnId).toBe(ids[3]);
    const rows = await run(
      sql<{
        turnId: string;
      }>`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id=${threadId} ORDER BY turn_id`,
    );
    expect(rows.map((row) => row.turnId)).toEqual([ids[1], ids[0], ids[3]].toSorted());
    const messages = await run(
      sql<{
        turnId: string;
      }>`SELECT turn_id AS "turnId" FROM projection_thread_messages WHERE thread_id=${threadId} ORDER BY message_id`,
    );
    expect(messages.map((row) => row.turnId)).toEqual([ids[0], ids[1], ids[3], null, null, null]);
    const queue = await run(
      sql<{
        paused: number;
        reason: string;
      }>`SELECT paused,pause_reason_code AS reason FROM next_turn_queue_state WHERE thread_id=${threadId}`,
    );
    expect(queue).toEqual([{ paused: 1, reason: "thread_reverted" }]);
    await expect(
      run(
        engine.dispatch({
          ...reconcile,
          commandId: CommandId.make("stale-native-reconcile"),
          expectedTurnId: ids[1]!,
        }),
      ),
    ).rejects.toThrow("native history owner changed");
    const lateCheckpoint = {
      type: "thread.turn.diff.complete" as const,
      commandId: CommandId.make("late-native-checkpoint"),
      threadId,
      turnId: ids[2]!,
      checkpointTurnCount: 3,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/native/3"),
      files: [],
      status: "ready" as const,
      completedAt: createdAt,
      createdAt,
    };
    await expect(run(engine.dispatch(lateCheckpoint))).rejects.toThrow(
      "retired by verified native history",
    );
    await system.dispose();
    system = await createPersistentOrchestrationSystem({ dbPath });
    const recovered = (await system.run(system.engine.getReadModel())).threads.find(
      (thread) => thread.id === threadId,
    )!;
    expect(
      recovered.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.turnId),
    ).toEqual([ids[0], ids[1], ids[3]]);
    expect(
      recovered.messages.filter((message) => message.role === "user").map((message) => message.id),
    ).toEqual(["user-0", "user-1", "user-3"]);
    expect(recovered.latestTurn?.turnId).toBe(ids[3]);
    await expect(
      system.run(
        system.engine.dispatch({
          ...lateCheckpoint,
          commandId: CommandId.make("late-native-checkpoint-after-restart"),
        }),
      ),
    ).rejects.toThrow("retired by verified native history");
  } finally {
    await system.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("command admission", () => {
  it("rejects an oversized ordinary command before committing any intent", async () => {
    const system = await createOrchestrationSystem();
    try {
      const failure = await system.run(
        system.engine
          .dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("oversized"),
            projectId: asProjectId("oversized-project"),
            title: "x".repeat(32 * 1024 * 1024),
            workspaceRoot: process.cwd(),
            createdAt: now(),
          })
          .pipe(Effect.flip),
      );
      expect(failure).toMatchObject({
        _tag: "OrchestrationOverloadError",
        lane: "ordinary",
        retryable: true,
        deliveryCertainty: "not_sent",
      });
      expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(0);
      expect(system.engine.inspectQueue!().entries).toBe(0);
    } finally {
      await system.dispose();
    }
  });
  it("a stop overtakes queued starts and atomically rejects unsent durable deliveries", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("cancel-project"),
      threadId = ThreadId.makeUnsafe("cancel-thread");
    let maintenance: Scope.Closeable | undefined;
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cancel-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cancel-thread-create"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      maintenance = await system.run(system.engine.acquireMaintenanceLock());
      const start = (id: string) =>
        system.run(
          system.engine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(id),
              threadId,
              message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: now(),
            })
            .pipe(Effect.exit),
        );
      const first = start("active-start");
      await expect.poll(() => system.engine.inspectQueue!().entries).toBe(1);
      const second = start("queued-start");
      await expect.poll(() => system.engine.inspectQueue!().entries).toBe(2);
      const stop = system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("overtaking-stop"),
          threadId,
          createdAt: now(),
        }),
      );
      await expect.poll(() => system.engine.inspectQueue!().entries).toBe(3);
      await system.run(Scope.close(maintenance, Exit.void));
      maintenance = undefined;
      expect(Exit.isSuccess(await first)).toBe(true);
      expect(await second).toMatchObject({ _tag: "Failure" });
      await stop;
      const model = await system.run(system.engine.getReadModel());
      expect(model.threads[0]!.messages.map((message) => message.id)).toEqual(["active-start"]);
      const deliveries = await system.run(
        system.sql<{
          state: string;
          certainty: string;
        }>`SELECT state, certainty FROM provider_turn_deliveries`,
      );
      expect(deliveries).toEqual([{ state: "rejected", certainty: "not_sent" }]);
      await system.run(system.engine.completeControl!("overtaking-stop"));
      expect(system.engine.inspectQueue!().entries).toBe(0);
    } finally {
      if (maintenance) await system.run(Scope.close(maintenance, Exit.void));
      await system.dispose();
    }
  });
  it("preserves command-id conflicts while a control reservation is still held", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("conflict-project"),
      firstThread = ThreadId.makeUnsafe("conflict-a"),
      secondThread = ThreadId.makeUnsafe("conflict-b");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("conflict-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      for (const threadId of [firstThread, secondThread])
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(threadId),
            threadId,
            projectId,
            title: "Thread",
            model: "gpt-5-codex",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
      const commandId = CommandId.makeUnsafe("shared-control-id");
      await system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId,
          threadId: firstThread,
          createdAt: now(),
        }),
      );
      const conflict = await system.run(
        system.engine
          .dispatch({
            type: "thread.session.stop",
            commandId,
            threadId: secondThread,
            createdAt: now(),
          })
          .pipe(Effect.flip),
      );
      expect(conflict).toMatchObject({
        _tag: "OrchestrationCommandIdConflictError",
        receiptAggregateId: firstThread,
        commandAggregateId: secondThread,
      });
      expect(system.engine.inspectQueue!().entries).toBe(1);
      await system.run(system.engine.completeControl!(commandId));
    } finally {
      await system.dispose();
    }
  });
  for (const controlType of ["thread.session.stop", "thread.turn.interrupt"] as const)
    it(`${controlType} supersedes older queued starts/steers and retains later starts`, async () => {
      const system = await createOrchestrationSystem();
      const projectId = asProjectId("ordered-project"),
        threadId = ThreadId.makeUnsafe("ordered-thread");
      let maintenance: Scope.Closeable | undefined;
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("ordered-project-create"),
            projectId,
            title: "Project",
            workspaceRoot: process.cwd(),
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("ordered-thread-create"),
            threadId,
            projectId,
            title: "Thread",
            model: "gpt-5-codex",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        maintenance = await system.run(system.engine.acquireMaintenanceLock());
        const blocker = system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("ordered-blocker"),
            threadId,
            title: "Blocker",
          }),
        );
        await expect.poll(() => system.engine.inspectQueue!().entries).toBe(1);
        const start = (id: string) =>
          system.run(
            system.engine
              .dispatch({
                type: "thread.turn.start",
                commandId: CommandId.makeUnsafe(id),
                threadId,
                message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                runtimeMode: "approval-required",
                createdAt: now(),
              })
              .pipe(Effect.exit),
          );
        const older = start("older");
        await expect.poll(() => system.engine.inspectQueue!().entries).toBe(2);
        const steer = system.run(
          system.engine
            .dispatch({
              type: "thread.turn.steer",
              commandId: CommandId.makeUnsafe("older-steer"),
              threadId,
              expectedTurnId: TurnId.makeUnsafe("previous-turn"),
              message: {
                messageId: asMessageId("older-steer"),
                role: "user",
                text: "steer",
                attachments: [],
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: now(),
            })
            .pipe(Effect.exit),
        );
        await expect.poll(() => system.engine.inspectQueue!().entries).toBe(3);
        const stop = system.run(
          system.engine.dispatch({
            type: controlType,
            commandId: CommandId.makeUnsafe("ordered-stop"),
            threadId,
            createdAt: now(),
          }),
        );
        await expect.poll(() => system.engine.inspectQueue!().entries).toBe(4);
        const newer = start("newer");
        await expect.poll(() => system.engine.inspectQueue!().entries).toBe(5);
        await system.run(Scope.close(maintenance, Exit.void));
        maintenance = undefined;
        await blocker;
        await stop;
        for (const pending of [older, steer]) {
          const result = await pending;
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) expect(String(result.cause)).toContain("superseded");
        }
        expect(Exit.isSuccess(await newer)).toBe(true);
        expect(
          (await system.run(system.engine.getReadModel())).threads[0]!.messages.map(
            (message) => message.id,
          ),
        ).toEqual(["newer"]);
        await system.run(system.engine.completeControl!("ordered-stop"));
      } finally {
        if (maintenance) await system.run(Scope.close(maintenance, Exit.void));
        await system.dispose();
      }
    });
  it("persists a control's outcome ahead of a saturated ordinary queue using its existing reservation", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("saturated-project"),
      threadId = ThreadId.makeUnsafe("saturated-thread");
    let maintenance: Scope.Closeable | undefined;
    const bulk: Array<Promise<unknown>> = [];
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("saturated-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("saturated-thread-create"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const commandId = CommandId.makeUnsafe("saturated-stop");
      await system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId,
          threadId,
          createdAt: now(),
        }),
      );
      maintenance = await system.run(system.engine.acquireMaintenanceLock());
      let finished = 0;
      for (let index = 0; index < 1024; index++)
        bulk.push(
          system
            .run(
              system.engine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.makeUnsafe("saturated-bulk"),
                  threadId,
                  title: "Metadata",
                })
                .pipe(Effect.exit),
            )
            .then((result) => {
              finished++;
              return result;
            }),
        );
      await expect.poll(() => system.engine.inspectQueue!().entries).toBe(1025);
      const beforeBytes = system.engine.inspectQueue!().bytes;
      const outcome = system.run(
        system.engine
          .dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("saturated-stop-result"),
            threadId,
            session: {
              threadId,
              status: "stopped",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now(),
            },
            createdAt: now(),
          })
          .pipe(
            Effect.provideService(ProviderControlTarget, system.engine.controlOrigin!(commandId)),
            Effect.exit,
          ),
      );
      await expect.poll(() => system.engine.inspectQueue!().bytes).toBeGreaterThan(beforeBytes);
      await system.run(Scope.close(maintenance, Exit.void));
      maintenance = undefined;
      expect(Exit.isSuccess(await outcome)).toBe(true);
      expect(finished).toBeLessThan(1024);
      await Promise.all(bulk);
      await system.run(system.engine.completeControl!(commandId));
      expect(system.engine.inspectQueue!().entries).toBe(0);
    } finally {
      if (maintenance) await system.run(Scope.close(maintenance, Exit.void));
      await Promise.allSettled(bulk);
      await system.dispose();
    }
  });
  it("rejects new work on shutdown while accepted source work can persist through producer closure", async () => {
    const shutdown = new ShutdownRegistry();
    const system = await createOrchestrationSystem({ shutdown });
    const projectId = asProjectId("shutdown-project");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("shutdown-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      shutdown.register({
        name: "fixture-source",
        phase: "producers",
        run: async () => {
          expect(
            await system.run(
              system.engine
                .dispatch({
                  type: "project.meta.update",
                  commandId: CommandId.makeUnsafe("shutdown-new-work"),
                  projectId,
                  title: "Rejected",
                })
                .pipe(Effect.flip),
            ),
          ).toMatchObject({ _tag: "OrchestrationOverloadError", reason: "closed" });
          await system.run(
            system.engine
              .dispatch({
                type: "project.meta.update",
                commandId: CommandId.makeUnsafe("shutdown-source-work"),
                projectId,
                title: "Final source output",
              })
              .pipe(Effect.provideService(AcceptedShutdownWork, true)),
          );
        },
      });
      const results = await shutdown.run();
      expect(results.every((result) => result.outcome === "complete")).toBe(true);
      expect((await system.run(system.engine.getReadModel())).projects[0]!.title).toBe(
        "Final source output",
      );
    } finally {
      await system.dispose();
    }
  });
  it("expires undelivered controls without expiring claimed work or allowing late execution", async () => {
    let time = 0;
    const system = await createOrchestrationSystem({ controlClock: () => time });
    const projectId = asProjectId("watchdog-project"),
      threadId = ThreadId.makeUnsafe("watchdog-thread");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("watchdog-project"),
          projectId,
          title: "Project",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("watchdog-thread"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      for (let i = 0; i < 64; i++)
        await system.run(
          system.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe(`watchdog-${i}`),
            threadId,
            createdAt: now(),
          }),
        );
      expect(await system.run(system.engine.claimControl!("watchdog-0"))).toBe(true);
      const progress = system.run(
        system.engine.waitForControlProgress!(threadId).pipe(Effect.exit),
      );
      time = 30_001;
      expect(Exit.isFailure(await progress)).toBe(true);
      await expect.poll(() => system.engine.inspectQueue!().entries, { timeout: 5_000 }).toBe(1);
      const thread = (await system.run(system.engine.getReadModel())).threads[0]!;
      expect(
        thread.activities.filter((a) => a.kind === "provider.session.stop.failed"),
      ).toHaveLength(63);
      expect(await system.run(system.engine.claimControl!("watchdog-1"))).toBe(false);
      expect(system.engine.controlOrigin!("watchdog-0")).toBeDefined();
      await system.run(system.engine.completeControl!("watchdog-0"));
      expect(system.engine.inspectQueue!().entries).toBe(0);
      await system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("watchdog-recovered"),
          threadId,
          createdAt: now(),
        }),
      );
      expect(await system.run(system.engine.claimControl!("watchdog-recovered"))).toBe(true);
      await system.run(system.engine.completeControl!("watchdog-recovered"));
    } finally {
      await system.dispose();
    }
  });

  it("reserves controls before commit and releases slots only after reactor completion", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("control-project"),
      threadId = ThreadId.makeUnsafe("control-thread");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("control-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("control-thread-create"),
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      for (let index = 0; index < 64; index++)
        await system.run(
          system.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe(`control-${index}`),
            threadId,
            createdAt: now(),
          }),
        );
      const sequence = (await system.run(system.engine.getReadModel())).snapshotSequence;
      expect(
        await system.run(
          system.engine
            .dispatch({
              type: "thread.session.stop",
              commandId: CommandId.makeUnsafe("control-full"),
              threadId,
              createdAt: now(),
            })
            .pipe(Effect.flip),
        ),
      ).toMatchObject({ _tag: "OrchestrationOverloadError", lane: "control" });
      const duplicateOverload = {
        type: "thread.session.stop" as const,
        commandId: CommandId.makeUnsafe("duplicate-full-control"),
        threadId,
        createdAt: now(),
      };
      const duplicateResults = await system.run(
        Effect.all(
          [
            system.engine.dispatch(duplicateOverload).pipe(Effect.exit),
            system.engine.dispatch(duplicateOverload).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("2 seconds")),
      );
      expect(duplicateResults.every(Exit.isFailure)).toBe(true);
      expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(sequence);
      await system.run(system.engine.completeControl!("control-0"));
      await system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("control-recovered"),
          threadId,
          createdAt: now(),
        }),
      );
      expect(system.engine.inspectQueue!().entries).toBe(64);
      for (let index = 1; index < 64; index++)
        await system.run(system.engine.completeControl!(`control-${index}`));
      await system.run(system.engine.completeControl!("control-recovered"));
      expect(system.engine.inspectQueue!().entries).toBe(0);
    } finally {
      await system.dispose();
    }
  });
});
