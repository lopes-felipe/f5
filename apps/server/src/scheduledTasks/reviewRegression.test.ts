import { AgentBridgeHostError } from "../agentBridge/AgentBridgeHost.ts";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  CommandId,
  EventId,
  ScheduledTaskRunId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { makeScheduledTaskService, userScheduleActor as actor } from "./Service.ts";
import { scheduleError } from "./Store.ts";
import { linkScheduledContinuation } from "./continuations.ts";
import { makeScheduledRunProjector } from "./projector.ts";
import { scheduledSendGate } from "./sendGate.ts";
import { setup, testLayer, seedScheduledThread } from "./testing.ts";

const admitted = Effect.gen(function* () {
  const fixture = yield* setup;
  const { task } = yield* fixture.create();
  const run = yield* fixture.service.runNow(
    {
      taskId: task.id,
      runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
      requestedAt: new Date(0).toISOString(),
    },
    actor,
  );
  yield* fixture.service.dispatch;
  yield* fixture.service.drainDispatches;
  const current = (yield* fixture.store.run(run.id))!;
  return { ...fixture, task, current, run };
});

for (const disposition of ["rejected", "canceled", "cleared"] as const)
  it.effect(
    `settles a ${disposition} continuation before acceptance instead of retaining capacity`,
    () =>
      Effect.gen(function* () {
        const f = yield* admitted;
        const { sql } = f.store;
        yield* sql`UPDATE scheduled_run_submissions SET turn_id='parent' WHERE run_id=${f.run.id}`;
        yield* sql`UPDATE scheduled_task_runs SET turn_id='parent' WHERE id=${f.run.id}`;
        yield* linkScheduledContinuation(
          { runId: f.run.id, parentSubmissionId: f.current.submissionId!, kind: "restart" },
          { submissionId: "child", messageId: "child-message", threadId: f.current.run.threadId! },
        );
        yield* sql`UPDATE scheduled_task_runs SET capacity=1 WHERE id=${f.run.id}`;
        yield* seedScheduledThread(f.store, f.task, f.current.run.threadId!);
        yield* sql`INSERT INTO turn_submissions(submission_id,thread_id,request_hash,message_id,disposition,created_at)
        VALUES('child',${f.current.run.threadId},'hash','child-message',${disposition},${f.task.createdAt})`;
        f.host.records.set("child", {
          submissionId: CommandId.makeUnsafe("child"),
          threadId: f.current.run.threadId!,
          requestHash: "hash",
          itemId: null,
          messageId: "child-message",
          disposition,
          resultSequence: null,
          reasonCode: "test",
          createdAt: f.task.createdAt,
          settledAt: f.task.createdAt,
        });
        yield* f.service.reconcile;
        const result = (yield* f.store.run(f.run.id))!;
        expect(result.run.status).toBe("failed");
        expect(result.capacity).toBe(false);
        expect(result.owner).toBe(false);
        expect(result.canceled).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

for (const kind of ["approval.resolved", "user-input.resolved"] as const)
  it.effect(`settles native ${kind} after the associated turn has quiesced`, () =>
    Effect.gen(function* () {
      const f = yield* admitted;
      const { sql } = f.store;
      const turnId = TurnId.makeUnsafe("completed");
      yield* sql`UPDATE scheduled_task_runs SET turn_id=${turnId} WHERE id=${f.run.id}`;
      yield* sql`UPDATE scheduled_run_submissions SET turn_id=${turnId} WHERE run_id=${f.run.id}`;
      yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,processing_quiesced_at,checkpoint_files_json)
        VALUES(${f.current.run.threadId},${turnId},'completed',${f.task.createdAt},${f.task.createdAt},'[]')`;
      yield* f.store.transition(
        f.run.id,
        "needs_attention",
        kind === "approval.resolved" ? "approval" : "user_input",
        f.task.createdAt,
      );
      yield* makeScheduledRunProjector(f.store)({
        sequence: 1,
        eventId: EventId.makeUnsafe("resolution"),
        aggregateKind: "thread",
        aggregateId: f.current.run.threadId!,
        occurredAt: f.task.createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.activity-appended",
        payload: {
          threadId: f.current.run.threadId!,
          activity: {
            id: "native",
            kind,
            turnId,
            createdAt: f.task.createdAt,
            payload: { requestId: "question" },
          },
        },
      } as OrchestrationEvent);
      const result = (yield* f.store.run(f.run.id))!;
      expect(result.run.status).toBe("succeeded");
      expect(result.owner).toBe(false);
      expect(result.capacity).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

it.effect(
  "streaming and unrelated activities neither project bookkeeping nor publish or wake dispatch",
  () =>
    Effect.gen(function* () {
      const f = yield* admitted;
      let publishes = 0;
      let probes = 0;
      const drained = yield* Deferred.make<void>();
      const runtime = yield* makeScheduledTaskService({
        store: f.store,
        settings: f.settings,
        host: {
          ...f.host.shape,
          listProviderInstances: Effect.sync(() => {
            probes++;
            return f.host.providers;
          }),
          domainEvents: f.host.shape.domainEvents.pipe(
            Stream.tap((e) =>
              e.sequence === 101 ? Deferred.succeed(drained, undefined) : Effect.void,
            ),
          ),
        },
        publish: () =>
          Effect.sync(() => {
            publishes++;
          }),
      });
      yield* runtime.start;
      // Drain the initial engine pass using its clock-independent query barrier.
      yield* Effect.yieldNow;
      const before = yield* f.store.readRevision;
      const baselineProbes = probes;
      const baselinePublishes = publishes;
      const projector = makeScheduledRunProjector(f.store);
      for (let i = 1; i <= 101; i++) {
        const event = {
          sequence: i,
          eventId: EventId.makeUnsafe(`delta-${i}`),
          aggregateKind: "thread",
          aggregateId: f.current.run.threadId!,
          occurredAt: f.task.createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: { streaming: true },
        } as OrchestrationEvent;
        yield* projector(event);
        yield* PubSub.publish(f.host.domainEvents, event);
      }
      yield* Deferred.await(drained);
      expect(yield* f.store.readRevision).toBe(before);
      expect(
        (yield* f.store.sql<{
          last_event_sequence: number;
        }>`SELECT last_event_sequence FROM scheduled_task_runs WHERE id=${f.run.id}`)[0]!
          .last_event_sequence,
      ).toBe(0);
      expect(publishes).toBe(baselinePublishes);
      expect(probes).toBe(baselineProbes);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("isolates an invalid schedule during global cutover", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const { task: bad } = yield* f.create();
    const { task: good } = yield* f.create();
    yield* f.store
      .sql`UPDATE scheduled_tasks SET definition_json=json_set(definition_json,'$.timezone','Not/AZone') WHERE id=${bad.id}`;
    yield* f.settings.updateSettings({ scheduledTasks: { enabled: false } });
    yield* f.service.evaluate(false);
    yield* f.settings.updateSettings({ scheduledTasks: { enabled: true } });
    yield* f.service.evaluate(true);
    expect((yield* f.store.task(bad.id))!.task.disabledReason).toBe("invalid_schedule");
    expect((yield* f.store.task(bad.id))!.task.enabled).toBe(false);
    expect((yield* f.store.task(good.id))!.task.enabled).toBe(true);
    expect(
      (yield* f.store.sql<{ enabled: number }>`SELECT enabled FROM scheduled_control`)[0]!.enabled,
    ).toBe(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

for (const field of ["state_json", "snapshot_json", "command_json"] as const)
  it.effect(`quarantines invalid ${field} without blocking healthy runs`, () =>
    Effect.gen(function* () {
      const f = yield* admitted;
      yield* f.store.sql.unsafe(`UPDATE scheduled_task_runs SET ${field}='{' WHERE id=?`, [
        f.run.id,
      ]);
      expect(yield* f.store.active).toEqual([]);
      expect(
        (yield* f.store.sql`SELECT * FROM scheduled_task_quarantine WHERE entity_kind='run'`)
          .length,
      ).toBe(1);
      expect((yield* f.store.task(f.task.id))!.task.enabled).toBe(false);
      const { task } = yield* f.create();
      yield* f.service.runNow(
        {
          taskId: task.id,
          runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
          requestedAt: f.task.createdAt,
        },
        actor,
      );
      yield* f.service.dispatch;
      yield* f.service.drainDispatches;
      expect(f.host.submissions).toHaveLength(2);
      expect(yield* f.store.run(f.run.id)).toBeNull();
      expect(
        (yield* f.store.sql`SELECT * FROM scheduled_task_quarantine WHERE entity_kind='run'`)
          .length,
      ).toBe(1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

it.effect("does not invalidate a user's version when reserving a recurring run", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const { task } = yield* f.create();
    const run = yield* f.service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: task.createdAt,
      },
      actor,
    );
    yield* f.service.reserve((yield* f.store.run(run.id))!);
    const result = yield* f.service.update(
      {
        id: task.id,
        expectedVersion: task.version,
        configuration: { ...task, name: "Edited while running" },
      },
      actor,
    );
    expect(result.task.runsConsumed).toBe(1);
    expect(result.task.lastRunAt).not.toBeNull();
    expect(result.task.name).toBe("Edited while running");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("retries a non-host preflight failure without an uncertain-delivery notification", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const { task } = yield* f.create();
    const run = yield* f.service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: task.createdAt,
      },
      actor,
    );
    yield* f.service.reserve((yield* f.store.run(run.id))!);
    // claim reads twice before the worker's final read.
    let reads = 0;
    const retryRuntime = yield* makeScheduledTaskService({
      store: {
        ...f.store,
        run: (id) =>
          Effect.suspend(() => {
            if (++reads === 3)
              return Effect.fail(scheduleError("storage", "Temporary final preflight read"));
            return f.store.run(id);
          }),
      },
      host: f.host.shape,
      settings: f.settings,
      publish: () => Effect.void,
    });
    yield* retryRuntime.dispatch;
    yield* retryRuntime.drainDispatches;
    const waiting = (yield* f.store.run(run.id))!;
    expect(waiting.started).toBe(false);
    expect(waiting.run.status).toBe("pending");
    expect(waiting.retryAt).toBe("1970-01-01T00:00:30.000Z");
    expect((yield* f.service.claimNotifications({ owner: "test" })).notifications).toHaveLength(0);
    yield* TestClock.adjust("30 seconds");
    yield* retryRuntime.dispatch;
    yield* retryRuntime.drainDispatches;
    expect(f.host.submissions).toHaveLength(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("human answers remain deliverable while startup reconciliation is retrying", () =>
  Effect.gen(function* () {
    const f = yield* admitted;
    yield* linkScheduledContinuation(
      { runId: f.run.id, parentSubmissionId: f.current.submissionId!, kind: "user_input" },
      { submissionId: "human-answer", messageId: "answer", threadId: f.current.run.threadId! },
    );
    const failed = yield* Deferred.make<void>();
    const runtime = yield* makeScheduledTaskService({
      store: f.store,
      settings: f.settings,
      host: {
        ...f.host.shape,
        readSnapshot: Deferred.succeed(failed, undefined).pipe(
          Effect.andThen(
            Effect.fail(new AgentBridgeHostError({ message: "persistent snapshot failure" })),
          ),
        ),
      },
      publish: () => Effect.void,
    });
    const startup = yield* runtime.start.pipe(Effect.forkChild);
    yield* Deferred.await(failed);
    const config = yield* f.settings.getSettings;
    expect(
      (yield* f.store.sql<{ ready: number }>`SELECT ready FROM scheduled_control`)[0]!.ready,
    ).toBe(0);
    expect(yield* scheduledSendGate(f.store.sql, config, f.current.submissionId!)).toBe("wait");
    expect(yield* scheduledSendGate(f.store.sql, config, "human-answer")).toBe("ready");
    yield* Fiber.interrupt(startup);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("fences a run whose reconciliation keeps failing and starts unrelated pending work", () =>
  Effect.gen(function* () {
    const f = yield* admitted;
    const { task: healthy } = yield* f.create();
    const other = yield* f.service.runNow(
      {
        taskId: healthy.id,
        runId: ScheduledTaskRunId.makeUnsafe("healthy-run"),
        requestedAt: healthy.createdAt,
      },
      actor,
    );
    const submitted = yield* Deferred.make<void>();
    const runtime = yield* makeScheduledTaskService({
      store: f.store,
      settings: f.settings,
      host: {
        ...f.host.shape,
        getSubmission: (id) =>
          id === f.current.submissionId
            ? Effect.fail(new AgentBridgeHostError({ message: "bad receipt" }))
            : f.host.shape.getSubmission(id),
        submitTurnSubmission: (body, options) =>
          f.host.shape
            .submitTurnSubmission(body, options)
            .pipe(Effect.tap(() => Deferred.succeed(submitted, undefined))),
      },
      publish: () => Effect.void,
    });
    yield* runtime.start;
    yield* Deferred.await(submitted);
    yield* runtime.drainDispatches;
    expect(
      (yield* f.store.sql<{ ready: number }>`SELECT ready FROM scheduled_control`)[0]!.ready,
    ).toBe(1);
    expect((yield* f.store.run(f.run.id))!.canceled).toBe(true);
    expect((yield* f.store.run(other.id))!.started).toBe(true);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("quarantines a malformed definition once while keeping healthy definitions usable", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const { task: bad } = yield* f.create();
    const { task: healthy } = yield* f.create();
    yield* f.store.sql`UPDATE scheduled_tasks SET definition_json='{' WHERE id=${bad.id}`;
    expect((yield* f.store.tasks()).map((t) => t.id)).toEqual([healthy.id]);
    expect(yield* f.store.task(bad.id)).toBeNull();
    expect((yield* f.store.sql`SELECT * FROM scheduled_task_quarantine`).length).toBe(1);
    yield* f.service.start;
    expect(
      (yield* f.store.sql<{ ready: number }>`SELECT ready FROM scheduled_control`)[0]!.ready,
    ).toBe(1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("project removal uses a live version check and preserves a concurrent user edit", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const { task } = yield* f.create();
    const run = yield* f.service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe("project-missing"),
        requestedAt: task.createdAt,
      },
      actor,
    );
    const runtime = yield* makeScheduledTaskService({
      store: f.store,
      settings: f.settings,
      host: {
        ...f.host.shape,
        readSnapshot: f.service
          .update(
            {
              id: task.id,
              expectedVersion: task.version,
              configuration: { ...task, name: "Concurrent edit" },
            },
            actor,
          )
          .pipe(
            Effect.andThen(f.host.shape.readSnapshot),
            Effect.map((s) => ({ ...s, projects: [] })),
            Effect.mapError((error) => new AgentBridgeHostError({ message: String(error) })),
          ),
      },
      publish: () => Effect.void,
    });
    yield* runtime.reserve((yield* f.store.run(run.id))!);
    const result = (yield* f.store.task(task.id))!.task;
    expect(result.name).toBe("Concurrent edit");
    expect(result.enabled).toBe(true);
    expect(result.version).toBe(task.version + 1);
    expect((yield* f.store.run(run.id))!.run.reason).toBe("project_missing");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

for (const state of ["rejected", "abandoned"] as const)
  it.effect(`reconciles a continuation's ${state} delivery while recovery is pending`, () =>
    Effect.gen(function* () {
      const f = yield* admitted;
      yield* linkScheduledContinuation(
        { runId: f.run.id, parentSubmissionId: f.current.submissionId!, kind: "restart" },
        {
          submissionId: "failed-child",
          messageId: "failed-message",
          threadId: f.current.run.threadId!,
        },
      );
      yield* f.store.sql`UPDATE scheduled_task_runs SET capacity=1 WHERE id=${f.run.id}`;
      yield* f.store
        .sql`INSERT INTO provider_turn_deliveries(delivery_id,thread_id,command_id,message_id,state,certainty,event_json,error_detail,created_at,updated_at)
        VALUES('failed-child',${f.current.run.threadId},'failed-child','failed-message',${state},'not_sent','{}','Child failed',${f.task.createdAt},${f.task.createdAt})`;
      yield* f.service.reconcile;
      const result = (yield* f.store.run(f.run.id))!;
      expect(result.run.status).toBe("failed");
      expect(result.run.error).toBe("Child failed");
      expect(result.capacity).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

it.effect("schedule cursor writes preserve budget counters reserved after the task-list read", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    const { task } = yield* f.create();
    const run = yield* f.service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe("cursor-counter-race"),
        requestedAt: task.createdAt,
      },
      actor,
    );
    let reserved = false;
    const runtime = yield* makeScheduledTaskService({
      store: {
        ...f.store,
        tasks: (deleted) =>
          Effect.gen(function* () {
            const rows = yield* f.store.tasks(deleted);
            if (!reserved) {
              reserved = true;
              yield* f.service
                .reserve((yield* f.store.run(run.id))!)
                .pipe(Effect.mapError(() => scheduleError("storage", "Test reservation failed")));
            }
            return rows;
          }),
      },
      host: f.host.shape,
      settings: f.settings,
      publish: () => Effect.void,
    });
    yield* TestClock.adjust("1 minute");
    yield* runtime.evaluate(false);
    const current = (yield* f.store.task(task.id))!.task;
    expect(current.runsConsumed).toBe(1);
    expect(current.lastRunAt).toBe("1970-01-01T00:01:00.000Z");
    expect(current.nextRunAt).toBe("1970-01-01T00:02:00.000Z");
    expect(current.version).toBe(task.version);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "publishes a disabled cutover revision once without waking clients for unchanged evaluations",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.create();
      const revisions: number[] = [];
      const runtime = yield* makeScheduledTaskService({
        store: f.store,
        host: f.host.shape,
        settings: f.settings,
        publish: (change) =>
          Effect.sync(() => {
            revisions.push(change.revision);
          }),
      });
      yield* f.settings.updateSettings({ scheduledTasks: { enabled: false } });
      yield* runtime.evaluate(false);
      expect(revisions).toEqual([yield* f.store.readRevision]);
      yield* runtime.evaluate(false);
      expect(revisions).toHaveLength(1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
