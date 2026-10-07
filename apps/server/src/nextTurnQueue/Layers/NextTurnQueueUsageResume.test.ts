import {
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream, Tracer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../../git/testDoubles.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderTurnDeliveryRepository } from "../../orchestration/Services/ProviderTurnDeliveryRepository.ts";
import { RuntimeReceiptBus } from "../../orchestration/Services/RuntimeReceiptBus.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NextTurnQueueDispatcher } from "../Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcherLive } from "./NextTurnQueueDispatcher.ts";
import { NextTurnQueueStoreLive } from "./NextTurnQueueStore.ts";

function blockedThread(
  index: number,
  resetsAt: string | null = new Date(Date.now() + 3_600_000).toISOString(),
): OrchestrationThread {
  const id = ThreadId.makeUnsafe(`policy-thread-${index}`);
  return {
    id,
    projectId: ProjectId.makeUnsafe(index % 2 ? "project-override" : "project-default"),
    deletedAt: null,
    archivedAt: null,
    model: "gpt-5.1-codex",
    runtimeMode: "approval-required",
    interactionMode: "default",
    pendingUserInputs: [],
    session: {
      threadId: id,
      providerInstanceId: "codex",
      status: "error",
      activeTurnId: null,
      lastError: "Usage limit reached",
      updatedAt: new Date().toISOString(),
      usageLimit: {
        providerInstanceId: "codex",
        turnId: `failure-${index}`,
        deliveryId: null,
        windows: [],
        resetsAt,
        resetSource: "provider",
        evidence: "typed",
      },
    },
  } as unknown as OrchestrationThread;
}

async function fixture(model: OrchestrationThread[], automatic = false) {
  const events = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const queries: string[] = [];
  let reads = 0;
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        if (key === "db.query.text") queries.push(String(value));
        attribute(key, value);
      };
      return span;
    },
  });
  const persistence = Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "f5-policy-regression-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitCore, makeFakeGitCore().service),
    Layer.succeed(ProjectionThreadRepository, {
      getById: ({ threadId }: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.some({
            threadId,
            archivedAt: null,
            deletedAt: null,
            worktreePath: null,
            branch: null,
            projectId: model.find((thread) => thread.id === threadId)?.projectId,
          }),
        ),
    } as never),
    Layer.succeed(ProjectionThreadSessionRepository, {
      getByThreadId: ({ threadId }: { threadId: ThreadId }) =>
        Effect.sync(() =>
          Option.fromNullishOr(model.find((thread) => thread.id === threadId)?.session),
        ),
    } as never),
    Layer.succeed(OrchestrationCommandReceiptRepository, {
      getByCommandId: () => Effect.succeed(Option.none()),
    } as never),
    Layer.succeed(ProviderTurnDeliveryRepository, {
      getByCommandId: () => Effect.succeed(null),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      getReadModel: () =>
        Effect.sync(() => {
          reads++;
          return { threads: model, projects: [] };
        }),
      dispatch: () => Effect.succeed({ sequence: 1 }),
      streamDomainEvents: Stream.fromPubSub(events),
    } as never),
    Layer.succeed(RuntimeReceiptBus, { publish: () => Effect.void, stream: Stream.empty }),
    ServerSettingsService.layerTest({ autoResumeUsageLimitedThreads: automatic }),
    ProjectionTurnRepositoryLive.pipe(Layer.provide(persistence)),
    NextTurnQueueStoreLive.pipe(Layer.provide(persistence)),
  );
  const runtime = ManagedRuntime.make(
    NextTurnQueueDispatcherLive.pipe(
      Layer.provideMerge(dependencies),
      Layer.provideMerge(persistence),
    ),
  );
  const scope = Effect.runSync(Scope.make());
  type RuntimeServices =
    typeof runtime extends ManagedRuntime.ManagedRuntime<infer R, unknown> ? R : never;
  const run = <A, E>(effect: Effect.Effect<A, E, RuntimeServices | Scope.Scope>) =>
    runtime.runPromise(
      effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.withTracer(tracer)),
    );
  const dispose = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  };
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = new Date().toISOString();
      for (const projectId of ["project-default", "project-override"])
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'project','/tmp','[]',${at},${at})`;
      for (const thread of model)
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES(${thread.id},${thread.projectId},'thread','gpt-5.1-codex',${at},${at},${at})`;
    }),
  );
  const dispatcher = await run(Effect.service(NextTurnQueueDispatcher));
  const store = await run(Effect.service(NextTurnQueueStore));
  const settings = await run(Effect.service(ServerSettingsService));
  const publish = (thread: OrchestrationThread) =>
    run(
      PubSub.publish(events, {
        aggregateKind: "thread",
        aggregateId: thread.id,
        type: "thread.session-set",
        payload: { threadId: thread.id, settledTurnId: null },
      } as unknown as OrchestrationEvent),
    );
  return {
    runtime,
    dispose,
    run,
    dispatcher,
    store,
    settings,
    publish,
    queries,
    readCount: () => reads,
    resetCounts: () => {
      queries.length = 0;
      reads = 0;
    },
  };
}

it("keeps disabled multi-thread scans constant and records only the triggering failure", async () => {
  const model = Array.from({ length: 150 }, (_, index) => blockedThread(index));
  const f = await fixture(model);
  try {
    f.resetCounts();
    await f.run(f.dispatcher.start);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.run(f.dispatcher.drain);
    const revocations = f.queries.filter((query) => query.includes("l.source='auto'"));
    expect(revocations.length).toBe(1);
    expect(revocations[0]).toMatch(/thread_id.*IN/i);
    expect(f.readCount()).toBeLessThan(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.resetCounts();
    await f.publish(model[0]!);
    await expect.poll(() => f.run(f.store.getUsageResumeLedger(model[0]!.id))).not.toBeNull();
    expect(
      f.queries.filter((query) => query.includes("INSERT INTO usage_limit_resumes")).length,
    ).toBe(1);
    expect(f.queries.filter((query) => query.includes("l.source='auto'"))).toHaveLength(0);
    expect(f.readCount()).toBeLessThan(10);
    const sql = await f.run(Effect.service(SqlClient.SqlClient));
    expect(
      (await f.run(sql<{ count: number }>`SELECT COUNT(*) AS count FROM usage_limit_resumes`))[0]
        ?.count,
    ).toBe(1);
  } finally {
    await f.dispose();
  }
});

it("enables only current blocks, honors project overrides, and revokes only automatic schedules", async () => {
  const model = [
    blockedThread(0),
    blockedThread(1),
    blockedThread(2),
    blockedThread(3),
    blockedThread(4, new Date(Date.now() - 86_400_000).toISOString()),
  ];
  const f = await fixture(model);
  try {
    await f.run(f.dispatcher.start);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.run(f.dispatcher.scheduleUsageLimitResume({ threadId: model[2]!.id }));
    await f.run(
      f.settings.updateSettings({
        autoResumeUsageLimitedThreads: true,
        projectSettingsOverrides: {
          [ProjectId.makeUnsafe("project-override")]: { autoResumeUsageLimitedThreads: false },
        },
      }),
    );
    await expect
      .poll(async () => (await f.run(f.store.listByThread(model[0]!.id))).items.length)
      .toBe(1);
    expect((await f.run(f.store.listByThread(model[1]!.id))).items).toHaveLength(0);
    expect((await f.run(f.store.listByThread(model[4]!.id))).items).toHaveLength(0);
    const snapshot = await f.run(f.dispatcher.getSnapshot(model[0]!.id));
    await f.run(
      f.dispatcher.cancelUsageLimitResume({
        threadId: model[0]!.id,
        itemId: snapshot.items[0]!.itemId,
        expectedRevision: snapshot.revision,
      }),
    );
    await f.run(
      f.settings.updateSettings({
        autoResumeUsageLimitedThreads: false,
        projectSettingsOverrides: {
          [ProjectId.makeUnsafe("project-override")]: { autoResumeUsageLimitedThreads: true },
        },
      }),
    );
    await expect
      .poll(async () => (await f.run(f.store.listByThread(model[1]!.id))).items.length)
      .toBe(1);
    const second = await f.run(f.dispatcher.getSnapshot(model[1]!.id));
    await f.run(
      f.settings.updateSettings({
        projectSettingsOverrides: {
          [ProjectId.makeUnsafe("project-override")]: { autoResumeUsageLimitedThreads: false },
        },
      }),
    );
    await expect
      .poll(async () => (await f.run(f.store.listByThread(model[1]!.id))).items.length)
      .toBe(0);
    expect((await f.run(f.store.getUsageResumeLedger(model[1]!.id)))?.state).toBe("revoked");
    expect((await f.run(f.store.listByThread(model[2]!.id))).items).toHaveLength(1);
    await f.run(f.settings.updateSettings({ autoResumeUsageLimitedThreads: true }));
    await expect
      .poll(async () => (await f.run(f.store.listByThread(model[3]!.id))).items.length)
      .toBe(0);
    expect((await f.run(f.store.listByThread(model[0]!.id))).items).toHaveLength(0);
    await f.run(
      f.settings.updateSettings({
        projectSettingsOverrides: {
          [ProjectId.makeUnsafe("project-override")]: { autoResumeUsageLimitedThreads: true },
        },
      }),
    );
    await expect
      .poll(async () => (await f.run(f.store.listByThread(model[1]!.id))).items.length)
      .toBe(1);
    expect((await f.run(f.store.listByThread(model[1]!.id))).items[0]?.itemId).toBe(
      second.items[0]?.itemId,
    );
  } finally {
    await f.dispose();
  }
});

it("another thread's scan cannot suppress an unknown reset failure", async () => {
  const unknown = blockedThread(0, null);
  const other = blockedThread(1);
  const f = await fixture([unknown, other], true);
  try {
    await f.run(f.dispatcher.start);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.run(f.store.getUsageResumeLedger(unknown.id))).toBeNull();
    await f.publish(other);
    await f.publish(unknown);
    await expect.poll(() => f.run(f.store.getUsageResumeLedger(unknown.id))).not.toBeNull();
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    (unknown.session!.usageLimit as { resetsAt: string | null }).resetsAt = reset;
    await f.publish(unknown);
    await expect
      .poll(async () => (await f.run(f.store.listByThread(unknown.id))).items.length)
      .toBe(1);
  } finally {
    await f.dispose();
  }
});
