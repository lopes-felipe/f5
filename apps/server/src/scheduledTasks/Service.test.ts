import { scheduledSendGate } from "./sendGate.ts";
import { scheduledContinuationFor, linkScheduledContinuation } from "./continuations.ts";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber } from "effect";
import { ServerShutdown, ShutdownRegistry } from "../shutdown.ts";
import { TestClock } from "effect/testing";
import { ScheduledTaskRunId } from "@t3tools/contracts";
import { scheduleError } from "./Store.ts";
import { makeScheduledTaskService, userScheduleActor as actor } from "./Service.ts";
import { setup, testLayer } from "./testing.ts";
import { AgentBridgeHostError } from "../agentBridge/AgentBridgeHost.ts";

it.effect("stops admitting scheduled work at shutdown and drains the admitted submission", () =>
  Effect.gen(function* () {
    const shutdown = new ShutdownRegistry();
    const admissionStopped = yield* Deferred.make<void>();
    shutdown.register({
      name: "test-scheduler-admission",
      phase: "flush",
      run: () => Effect.runPromise(Deferred.succeed(admissionStopped, undefined)),
    });
    yield* Effect.gen(function* () {
      const { create, store, service, host } = yield* setup;
      const { task } = yield* create();
      host.submissionGate = yield* Deferred.make<void>();
      const run = yield* service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
      yield* service.dispatch;
      // A claimed worker is waiting in the host, independently of source timers.
      expect((yield* store.run(run.id))!.capacity).toBe(true);
      const closing = shutdown.run();
      yield* Deferred.await(admissionStopped);
      yield* TestClock.adjust("5 minutes");
      yield* service.start;
      yield* service.dispatch;
      expect(yield* store.history(task.id)).toHaveLength(1);
      yield* Deferred.succeed(host.submissionGate, undefined);
      const results = yield* Effect.promise(() => closing);
      expect(results.find((step) => step.name === "scheduled-task-work")?.outcome).toBe("complete");
      expect(host.submissions).toHaveLength(1);
    }).pipe(Effect.provideService(ServerShutdown, shutdown));
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("coalesces missed occurrences and is idempotent across repeated evaluations", () =>
  Effect.gen(function* () {
    const { create, store, service } = yield* setup;
    const { task } = yield* create();
    yield* TestClock.adjust("5 minutes");
    yield* service.evaluate(true);
    yield* service.evaluate(true);
    const rows = yield* store.history(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run.trigger).toBe("catch_up");
    expect(rows[0]!.run.scheduledFor).toBe("1970-01-01T00:01:00.000Z");
    expect((yield* store.task(task.id))!.task.nextRunAt).toBe("1970-01-01T00:06:00.000Z");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("keeps one pending owner and records suppressed fires", () =>
  Effect.gen(function* () {
    const { create, store, service } = yield* setup;
    const { task } = yield* create();
    yield* TestClock.adjust("1 minute");
    yield* service.evaluate(false);
    yield* TestClock.adjust("1 minute");
    yield* service.evaluate(false);
    const rows = yield* store.history(task.id);
    expect(rows.filter((r) => r.owner)).toHaveLength(1);
    expect(rows.some((r) => r.run.reason === "already_pending")).toBe(true);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("manual retries return the same run and conflicting reuse fails", () =>
  Effect.gen(function* () {
    const { create, service } = yield* setup;
    const { task } = yield* create();
    const input = {
      taskId: task.id,
      runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
      requestedAt: new Date(0).toISOString(),
    };
    const one = yield* service.runNow(input, actor),
      two = yield* service.runNow(input, actor);
    expect(one.id).toBe(two.id);
    const other = yield* create();
    expect(
      (yield* Effect.result(service.runNow({ ...input, taskId: other.task.id }, actor)))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("requires optimistic versions and expires old create requests", () =>
  Effect.gen(function* () {
    const { create, service } = yield* setup;
    const { task } = yield* create();
    expect(
      (yield* Effect.result(
        service.setEnabled({ id: task.id, expectedVersion: 99, enabled: false }, actor),
      ))._tag,
    ).toBe("Failure");
    yield* TestClock.adjust("25 hours");
    expect((yield* Effect.result(create()))._tag).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("does not turn disabled intervals into catch-up work", () =>
  Effect.gen(function* () {
    const { create, service, settings, store } = yield* setup;
    const { task } = yield* create();
    yield* settings.updateSettings({ scheduledTasks: { enabled: false } });
    yield* service.evaluate(false);
    yield* TestClock.adjust("1 hour");
    yield* settings.updateSettings({ scheduledTasks: { enabled: true } });
    yield* service.evaluate(true);
    expect((yield* store.history(task.id)).map((r) => r.run.reason)).toEqual(["disabled_interval"]);
    expect((yield* store.task(task.id))!.task.nextRunAt).toBe("1970-01-01T01:01:00.000Z");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "consumes a one-run budget once before side effects and keeps ownership on unknown delivery",
  () =>
    Effect.gen(function* () {
      const { create, service, store, host } = yield* setup;
      const { task } = yield* create({ maxRuns: 1 });
      yield* service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
      yield* service.dispatch;
      const current = (yield* store.task(task.id))!.task;
      expect(current.enabled).toBe(false);
      expect(current.runsConsumed).toBe(1);
      expect(yield* store.active).toHaveLength(1);
      yield* service.reconcile;
      yield* service.reconcile;
      expect(host.submissions.length).toBeLessThanOrEqual(1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("manual run while started records overlap and preserves the active run", () =>
  Effect.gen(function* () {
    const { create, service, store } = yield* setup;
    const { task } = yield* create();
    const run = () =>
      service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
    yield* run();
    yield* service.dispatch;
    const second = yield* run();
    expect(second.reason).toBe("overlap");
    expect(yield* store.active).toHaveLength(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("respects capacity without dropping pending work", () =>
  Effect.gen(function* () {
    const { create, service, store } = yield* setup;
    for (let i = 0; i < 3; i++) {
      const { task } = yield* create();
      yield* service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
    }
    yield* service.dispatch;
    const active = yield* store.active;
    expect(active.filter((r) => r.capacity)).toHaveLength(2);
    expect(active.filter((r) => !r.budgetConsumed)).toHaveLength(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("fences startup replay and disabled queued sends at the same gate", () =>
  Effect.gen(function* () {
    const { create, store, service, settings } = yield* setup;
    const { task } = yield* create();
    const run = yield* service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: new Date(0).toISOString(),
      },
      actor,
    );
    yield* service.dispatch;
    const current = (yield* store.run(run.id))!;
    expect(
      yield* scheduledSendGate(store.sql, yield* settings.getSettings, current.submissionId!),
    ).toBe("wait");
    yield* store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
    expect(
      yield* scheduledSendGate(store.sql, yield* settings.getSettings, current.submissionId!),
    ).toBe("ready");
    const latest = (yield* store.task(task.id))!.task;
    yield* service.setEnabled(
      { id: task.id, expectedVersion: latest.version, enabled: false },
      actor,
    );
    expect(
      yield* scheduledSendGate(store.sql, yield* settings.getSettings, current.submissionId!),
    ).toBe("cancel");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("continuations link only to their associated source turn and do not consume budget", () =>
  Effect.gen(function* () {
    const { create, store, service } = yield* setup;
    const { task } = yield* create();
    const run = yield* service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: new Date(0).toISOString(),
      },
      actor,
    );
    yield* service.dispatch;
    const current = (yield* store.run(run.id))!;
    yield* store.sql`UPDATE scheduled_run_submissions SET turn_id='source-turn' WHERE run_id=${run.id}`;
    expect(
      yield* scheduledContinuationFor(current.run.threadId!, "independent-turn", "restart"),
    ).toBeUndefined();
    const context = yield* scheduledContinuationFor(
      current.run.threadId!,
      "source-turn",
      "usage_limit",
    );
    expect(context?.runId).toBe(run.id);
    yield* store.transaction(
      linkScheduledContinuation(context!, {
        submissionId: "child-submission",
        messageId: "child-message",
        threadId: current.run.threadId!,
      }),
    );
    expect((yield* store.run(run.id))!.capacity).toBe(false);
    expect((yield* store.run(run.id))!.owner).toBe(true);
    expect((yield* store.task(task.id))!.task.runsConsumed).toBe(1);
    yield* store.sql`UPDATE scheduled_task_runs SET canceled=1 WHERE id=${run.id}`;
    expect(
      (yield* Effect.result(
        store.transaction(
          linkScheduledContinuation(context!, {
            submissionId: "revoked-child",
            messageId: "revoked-message",
            threadId: current.run.threadId!,
          }),
        ),
      ))._tag,
    ).toBe("Failure");
    expect(
      yield* store.sql`SELECT submission_id FROM scheduled_run_submissions WHERE submission_id='revoked-child'`,
    ).toHaveLength(0);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("keeps schedule cursors consumed across backward wall clock evaluations", () =>
  Effect.gen(function* () {
    const { create, store, service } = yield* setup;
    const { task } = yield* create();
    yield* TestClock.adjust("5 minutes");
    yield* service.evaluate(true);
    const cursor = (yield* store.task(task.id))!.task.nextRunAt;
    yield* TestClock.setTime(0);
    yield* service.evaluate(false);
    expect((yield* store.task(task.id))!.task.nextRunAt).toBe(cursor);
    yield* TestClock.adjust("5 minutes");
    yield* service.evaluate(true);
    expect(yield* store.history(task.id)).toHaveLength(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("disable cancels a claimed queued receipt and releases both ownership and capacity", () =>
  Effect.gen(function* () {
    const { create, store, service, host } = yield* setup;
    const { task } = yield* create();
    const run = yield* service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: new Date(0).toISOString(),
      },
      actor,
    );
    yield* service.dispatch;
    yield* service.drainDispatches;
    const current = (yield* store.run(run.id))!;
    host.records.set(current.submissionId!, {
      submissionId: current.command!.commandId,
      threadId: current.command!.threadId,
      requestHash: "hash",
      itemId: current.command!.commandId,
      messageId: current.command!.message.messageId,
      disposition: "queued",
      resultSequence: null,
      reasonCode: null,
      createdAt: new Date(0).toISOString(),
      settledAt: null,
    });
    yield* store.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${task.projectId},'Project','/repo','[]',${new Date(0).toISOString()},${new Date(0).toISOString()})`;
    yield* store.sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES(${current.run.threadId},${task.projectId},'Scheduled','model-a',${new Date(0).toISOString()},${new Date(0).toISOString()},${new Date(0).toISOString()})`;
    yield* store.sql`INSERT INTO turn_submissions(submission_id,thread_id,request_hash,message_id,disposition,created_at) VALUES(${current.submissionId},${current.run.threadId},'hash',${current.command!.message.messageId},'queued',${new Date(0).toISOString()})`;
    yield* store.sql`INSERT INTO provider_turn_deliveries(delivery_id,thread_id,command_id,message_id,state,event_json,created_at,updated_at) VALUES(${current.submissionId},${current.run.threadId},${current.submissionId},${current.command!.message.messageId},'pending','{}',${new Date(0).toISOString()},${new Date(0).toISOString()})`;
    host.providers = [];
    const latest = (yield* store.task(task.id))!.task;
    yield* service.setEnabled(
      { id: task.id, expectedVersion: latest.version, enabled: false },
      actor,
    );
    const settled = (yield* store.run(run.id))!;
    expect(settled.owner).toBe(false);
    expect(settled.capacity).toBe(false);
    expect(settled.run.status).toBe("skipped");
    const receipt = yield* store.sql<{
      disposition: string;
    }>`SELECT disposition FROM turn_submissions WHERE submission_id=${current.submissionId}`;
    const delivery = yield* store.sql<{
      state: string;
    }>`SELECT state FROM provider_turn_deliveries WHERE command_id=${current.submissionId}`;
    expect(receipt[0]!.disposition).toBe("canceled");
    expect(delivery[0]!.state).toBe("abandoned");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "expired and exhausted one-shots can always be disabled after their provider disappears",
  () =>
    Effect.gen(function* () {
      const { create, store, service, host } = yield* setup;
      const { task } = yield* create({
        cron: "0 1 0 1 1 * 1970",
        maxRuns: 1,
        oneShotAt: "1970-01-01T00:01:00.000Z",
      });
      yield* TestClock.adjust("2 minutes");
      host.providers = [];
      yield* service.setEnabled(
        { id: task.id, expectedVersion: task.version, enabled: false },
        actor,
      );
      expect((yield* store.task(task.id))!.task.enabled).toBe(false);
      const disabled = (yield* store.task(task.id))!.task;
      const renamed = yield* service.update(
        {
          id: task.id,
          expectedVersion: disabled.version,
          configuration: { ...disabled, name: "Archived schedule" },
        },
        actor,
      );
      expect(renamed.task.name).toBe("Archived schedule");
      expect(renamed.task.enabled).toBe(false);
      expect(
        (yield* Effect.result(
          service.setEnabled(
            { id: task.id, expectedVersion: renamed.task.version, enabled: true },
            actor,
          ),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("metadata edits preserve the unconsumed schedule cursor", () =>
  Effect.gen(function* () {
    const { create, store, service } = yield* setup;
    const { task } = yield* create();
    yield* TestClock.adjust("90 seconds");
    const result = yield* service.update(
      {
        id: task.id,
        expectedVersion: task.version,
        configuration: { ...task, name: "Renamed", notify: "none" },
      },
      actor,
    );
    expect(result.task.nextRunAt).toBe(task.nextRunAt);
    yield* service.evaluate(true);
    expect((yield* store.history(task.id))[0]!.run.scheduledFor).toBe(task.nextRunAt);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
for (const failure of ["worktree_unavailable", "delivery_unknown"] as const)
  it.effect(`classifies ${failure} without losing uncertain execution ownership`, () =>
    Effect.gen(function* () {
      const { create, store, host, settings } = yield* setup;
      const { task } = yield* create({ maxRuns: 1 });
      const runtime = yield* makeScheduledTaskService({
        store,
        settings,
        publish: () => Effect.void,
        host: {
          ...host.shape,
          submitTurnSubmission: () =>
            Effect.fail(
              new AgentBridgeHostError({
                message: "Submission failed",
                submissionFailure: failure,
              }),
            ),
        },
      });
      const run = yield* runtime.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
      yield* TestClock.adjust("1 second");
      yield* runtime.dispatch;
      yield* runtime.drainDispatches;
      const result = (yield* store.run(run.id))!;
      expect(result.run.status).toBe(
        failure === "worktree_unavailable" ? "failed" : "needs_attention",
      );
      expect(result.run.reason).toBe(
        failure === "worktree_unavailable" ? "setup_failed" : "delivery_unknown",
      );
      expect(result.owner).toBe(failure === "delivery_unknown");
      expect(result.capacity).toBe(failure === "delivery_unknown");
      expect(result.run.startedAt).toBe("1970-01-01T00:00:01.000Z");
      expect((yield* store.task(task.id))!.task.runsConsumed).toBe(1);
      expect((yield* store.task(task.id))!.task.enabled).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
for (const workspace of [
  { kind: "projectRoot" } as const,
  { kind: "worktree", baseBranch: "main" } as const,
])
  it.effect(
    `reuses the exact reserved ${workspace.kind} command after a crash before bootstrap`,
    () =>
      Effect.gen(function* () {
        const { create, store, service, host, settings } = yield* setup;
        const { task } = yield* create({ workspace, maxRuns: 1 });
        const run = yield* service.runNow(
          {
            taskId: task.id,
            runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
            requestedAt: new Date(0).toISOString(),
          },
          actor,
        );
        const reserved = yield* service.reserve((yield* store.run(run.id))!);
        expect(reserved).not.toBeNull();
        expect((yield* store.run(run.id))!.started).toBe(false);
        const restarted = yield* makeScheduledTaskService({
          store,
          host: host.shape,
          settings,
          publish: () => Effect.void,
        });
        yield* restarted.reconcile;
        yield* restarted.dispatch;
        yield* restarted.drainDispatches;
        expect(host.submissions).toHaveLength(1);
        expect(host.submissions[0]!.command).toEqual(reserved!.command);
        expect((yield* store.task(task.id))!.task.runsConsumed).toBe(1);
        expect((yield* store.run(run.id))!.submissionId).toBe(reserved!.submissionId);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
it.effect("a long capacity wait is not mistaken for a long-running interrupted bootstrap", () =>
  Effect.gen(function* () {
    const { create, store, service, host } = yield* setup;
    const { task } = yield* create();
    const run = yield* service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: new Date(0).toISOString(),
      },
      actor,
    );
    yield* TestClock.adjust("20 minutes");
    yield* service.dispatch;
    yield* service.drainDispatches;
    yield* service.reconcile;
    expect((yield* store.run(run.id))!.run.status).toBe("pending");
    expect(host.submissions).toHaveLength(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("startup retries a transient storage failure before opening delivery", () =>
  Effect.gen(function* () {
    const { create, store, host, settings } = yield* setup;
    const { task } = yield* create();
    const failed = yield* Deferred.make<void>();
    let failOnce = true;
    const runtime = yield* makeScheduledTaskService({
      store: {
        ...store,
        tasks: (includeDeleted) =>
          Effect.suspend(() => {
            if (failOnce) {
              failOnce = false;
              return Deferred.succeed(failed, undefined).pipe(
                Effect.andThen(Effect.fail(scheduleError("storage", "temporary"))),
              );
            }
            return store.tasks(includeDeleted);
          }),
      },
      host: host.shape,
      settings,
      publish: () => Effect.void,
    });
    const started = yield* runtime.start.pipe(Effect.forkChild);
    yield* Deferred.await(failed);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(started);
    yield* runtime.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: new Date(1000).toISOString(),
      },
      actor,
    );
    yield* runtime.dispatch;
    yield* runtime.drainDispatches;
    expect(host.submissions).toHaveLength(1);
    const control = yield* store.sql<{
      ready: number;
    }>`SELECT ready FROM scheduled_control WHERE id=1`;
    expect(control[0]!.ready).toBe(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "a running engine recovers from a transient evaluation failure and dispatches automatically",
  () =>
    Effect.gen(function* () {
      const { create, store, host, settings } = yield* setup;
      const { task } = yield* create();
      const failed = yield* Deferred.make<void>();
      const submitted = yield* Deferred.make<void>();
      let failNext = false;
      const runtime = yield* makeScheduledTaskService({
        store: {
          ...store,
          tasks: (includeDeleted) =>
            Effect.suspend(() => {
              if (!failNext) return store.tasks(includeDeleted);
              failNext = false;
              return Deferred.succeed(failed, undefined).pipe(
                Effect.andThen(Effect.fail(scheduleError("storage", "temporary"))),
              );
            }),
        },
        host: {
          ...host.shape,
          submitTurnSubmission: (body, options) =>
            host.shape
              .submitTurnSubmission(body, options)
              .pipe(Effect.tap(() => Deferred.succeed(submitted, undefined))),
        },
        settings,
        publish: () => Effect.void,
      });
      yield* runtime.start;
      failNext = true;
      yield* runtime.signal;
      yield* Deferred.await(failed);
      yield* runtime.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(submitted);
      yield* runtime.drainDispatches;
      expect(host.submissions).toHaveLength(1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("ordinary single fires delayed by a few seconds remain schedule triggers", () =>
  Effect.gen(function* () {
    const { create, store, service } = yield* setup;
    const { task } = yield* create();
    yield* TestClock.adjust("70 seconds");
    yield* service.evaluate(false);
    expect((yield* store.history(task.id))[0]!.run.trigger).toBe("schedule");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("history cursors are validated and paginate tied timestamps without duplicates", () =>
  Effect.gen(function* () {
    const { create, service } = yield* setup;
    const { task } = yield* create();
    for (let i = 0; i < 3; i++)
      yield* service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: new Date(0).toISOString(),
        },
        actor,
      );
    const first = yield* service.listRuns({ taskId: task.id, limit: 2 }, actor);
    const second = yield* service.listRuns(
      { taskId: task.id, limit: 2, before: first.nextCursor! },
      actor,
    );
    expect(first.runs).toHaveLength(2);
    expect(second.runs).toHaveLength(1);
    expect(new Set([...first.runs, ...second.runs].map((r) => r.id)).size).toBe(3);
    expect(
      (yield* Effect.result(service.listRuns({ taskId: task.id, before: "broken" }, actor)))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
