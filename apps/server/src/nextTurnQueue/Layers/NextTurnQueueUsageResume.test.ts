import {
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream, Tracer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import { ThreadTurnNotReadyError } from "../../orchestration/Errors.ts";
import { UsageService, type UsageServiceShape } from "../../usage/Services/UsageService.ts";
import type { OrchestrationCommand } from "@t3tools/contracts";
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

async function fixture(
  model: OrchestrationThread[],
  automatic = false,
  refresh?: UsageServiceShape["refreshAccount"],
  notReady?: () => ThreadTurnNotReadyError,
) {
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
    refresh ? Layer.succeed(UsageService, { refreshAccount: refresh } as never) : Layer.empty,
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
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if (command.type === "thread.turn.start" && notReady) return yield* notReady();
          if (command.type === "thread.session.set") {
            const target = model.find((thread) => thread.id === command.threadId);
            if (target) Object.assign(target, { session: command.session });
            yield* PubSub.publish(events, {
              aggregateKind: "thread",
              aggregateId: command.threadId,
              type: "thread.session-set",
              payload: { threadId: command.threadId, settledTurnId: null },
            } as unknown as OrchestrationEvent);
          }
          return { sequence: 1 };
        }),
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
    publishLifecycle: (threadId: ThreadId) =>
      run(
        PubSub.publish(events, {
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.checkpoint-revert-requested",
          payload: { threadId },
        } as unknown as OrchestrationEvent),
      ),
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

it("retries a throttled unknown reset after its deadline and schedules from fresh account data", async () => {
  let nowMs = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  const thread = blockedThread(0, null);
  Object.assign(thread.session!.usageLimit!, {
    windows: [{ id: "five_hour", label: "5-hour", resetsAt: null }],
  });
  let calls = 0;
  const refresh: UsageServiceShape["refreshAccount"] = () =>
    Effect.sync(() => {
      calls++;
      if (calls === 1)
        return {
          fresh: false,
          snapshot: null,
          nextAllowedAt: new Date(nowMs + 90_000).toISOString(),
        };
      const fetchedAt = new Date(nowMs + 1_000).toISOString();
      return {
        fresh: true,
        snapshot: {
          key: "codex",
          provider: "claudeAgent",
          providerInstanceId: "codex",
          displayName: "test",
          enabled: true,
          refreshState: "idle",
          sections: [
            {
              kind: "claude-usage",
              outcome: "available",
              lastAttemptAt: fetchedAt,
              errorCode: null,
              snapshot: {
                fetchedAt,
                data: {
                  subscriptionLabel: "Max",
                  limitsAvailable: true,
                  windows: [
                    {
                      key: "five_hour",
                      label: "5-hour",
                      utilization: 100,
                      resetsAt: new Date(nowMs + 3_600_000).toISOString(),
                    },
                  ],
                  extraUsage: null,
                },
              },
            },
          ],
        } as never,
      };
    });
  const f = await fixture([thread], true, refresh);
  try {
    await f.run(f.dispatcher.start);
    await expect.poll(() => calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    nowMs += 60_000;
    await f.run(f.settings.updateSettings({ autoResumeUsageLimitedThreads: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    nowMs += 60_000;
    await f.run(f.settings.updateSettings({ autoResumeUsageLimitedThreads: true }));
    await expect
      .poll(async () => (await f.run(f.store.listByThread(thread.id))).items.length)
      .toBe(1);
    expect(calls).toBe(2);
    expect(thread.session!.usageLimit!.resetSource).toBe("account");
  } finally {
    await f.dispose();
    clock.mockRestore();
  }
});

it("drops an obsolete continuation without removing queued follow-ups", async () => {
  const thread = blockedThread(0);
  const f = await fixture([thread]);
  try {
    await f.run(f.dispatcher.scheduleUsageLimitResume({ threadId: thread.id }));
    const recovery = (await f.run(f.store.listByThread(thread.id))).items[0]!;
    await f.run(
      f.store.insertSubmission({
        submissionId: (recovery.submissionId + "-followup") as never,
        itemId: (recovery.itemId + "-followup") as never,
        requestHash: "followup",
        atHead: false,
        command: {
          ...recovery.command,
          commandId: (recovery.command.commandId + "-followup") as never,
          presentation: undefined,
          message: {
            ...recovery.command.message,
            messageId: (recovery.command.message.messageId + "-followup") as never,
            text: "follow up",
          },
        },
      }),
    );
    Object.assign(thread.session!, { status: "ready", lastError: null, usageLimit: null });
    await f.run(f.dispatcher.notify(thread.id));
    await f.run(f.dispatcher.drain);
    expect(
      (await f.run(f.store.listByThread(thread.id))).items.some(
        (item) => item.scheduleReason === "usage_limit_reset",
      ),
    ).toBe(false);
    expect((await f.run(f.store.listByThread(thread.id))).items).toHaveLength(1);
    expect((await f.run(f.store.getUsageResumeLedger(thread.id)))?.state).toBe("cancelled");
  } finally {
    await f.dispose();
  }
});

it("a cancellation failure cannot suppress the lifecycle pause", async () => {
  const thread = blockedThread(0);
  const f = await fixture([thread]);
  try {
    await f.run(f.dispatcher.start);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.run(f.dispatcher.scheduleUsageLimitResume({ threadId: thread.id }));
    const sql = await f.run(Effect.service(SqlClient.SqlClient));
    await f.run(
      sql`CREATE TRIGGER fail_resume_cancellation BEFORE UPDATE OF deleted_at ON next_turn_queue WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'cancel failed'); END`,
    );
    await f.publishLifecycle(thread.id);
    await expect
      .poll(async () => (await f.run(f.store.listByThread(thread.id))).state.pauseReasonCode)
      .toBe("thread_reverted");
    expect((await f.run(f.store.listByThread(thread.id))).items).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

it("backs off repeated rewind readiness failures without consuming delivery attempts", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let nowMs = Date.now();
  let attempts = 0;
  const thread = blockedThread(0);
  const f = await fixture([thread], false, undefined, () => {
    attempts++;
    return new ThreadTurnNotReadyError({
      threadId: thread.id,
      detail: "Rewind is awaiting reconciliation",
    });
  });
  try {
    const snapshot = await f.run(f.dispatcher.scheduleUsageLimitResume({ threadId: thread.id }));
    await f.run(
      f.dispatcher.promote({
        itemId: snapshot.items[0]!.itemId,
        expectedRevision: snapshot.revision,
        interruptActive: false,
      }),
    );
    await f.run(f.dispatcher.drain);
    for (const [index, base] of [1_000, 2_000, 4_000].entries()) {
      const item = (await f.run(f.store.listByThread(thread.id))).items[0]!;
      expect(attempts).toBe(index + 1);
      expect(item.attemptCount).toBe(0);
      expect(Date.parse(item.notBefore!) - nowMs).toBeGreaterThanOrEqual(base * 0.8);
      expect(Date.parse(item.notBefore!) - nowMs).toBeLessThanOrEqual(base * 1.2);
      nowMs += 10_000;
      vi.setSystemTime(nowMs);
      if (index < 2) {
        await f.run(f.dispatcher.notify(thread.id));
        await f.run(f.dispatcher.drain);
      }
    }
  } finally {
    await f.dispose();
    vi.useRealTimers();
  }
});
