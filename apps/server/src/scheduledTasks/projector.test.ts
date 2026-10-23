import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { ScheduledTaskRunId, EventId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";
import { projectScheduledRunEvent } from "./projector.ts";
import { scheduledContinuationFor, linkScheduledContinuation } from "./continuations.ts";
import { userScheduleActor as actor } from "./Service.ts";
import { setup, testLayer } from "./testing.ts";
it.effect(
  "projects ordered attention episodes and completion without reopening independent turns",
  () =>
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
      const current = (yield* store.run(run.id))!,
        { sql } = store,
        turnId = TurnId.makeUnsafe("turn-1");
      yield* sql`UPDATE scheduled_task_runs SET turn_id=${turnId} WHERE id=${run.id}`;
      yield* sql`UPDATE scheduled_run_submissions SET turn_id=${turnId} WHERE run_id=${run.id}`;
      const event = (
        sequence: number,
        type: OrchestrationEvent["type"],
        payload: unknown,
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.makeUnsafe(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: current.run.threadId!,
          occurredAt: new Date(sequence * 1000).toISOString(),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload,
        }) as OrchestrationEvent;
      const activity = (kind: string) => ({
        threadId: current.run.threadId,
        activity: {
          id: "request-1",
          kind,
          turnId,
          createdAt: new Date(0).toISOString(),
          payload: { requestId: "request-1" },
        },
      });
      yield* projectScheduledRunEvent(
        event(1, "thread.activity-appended", activity("approval.requested")),
      );
      expect((yield* store.run(run.id))!.run.status).toBe("needs_attention");
      yield* projectScheduledRunEvent(
        event(1, "thread.activity-appended", activity("approval.requested")),
      );
      yield* projectScheduledRunEvent(
        event(2, "thread.activity-appended", activity("approval.resolved")),
      );
      expect((yield* store.run(run.id))!.run.status).toBe("running");
      yield* projectScheduledRunEvent(
        event(3, "thread.activity-appended", activity("user-input.requested")),
      );
      yield* projectScheduledRunEvent(
        event(4, "thread.activity-appended", activity("user-input.resolved")),
      );
      yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,processing_quiesced_at,checkpoint_files_json) VALUES(${current.run.threadId},${turnId},'completed',${new Date(0).toISOString()},${new Date(5000).toISOString()},'[]')`;
      yield* projectScheduledRunEvent(
        event(5, "thread.turn-diff-completed", {
          threadId: current.run.threadId,
          turnId,
          status: "ready",
        }),
      );
      expect((yield* store.run(run.id))!.run.status).toBe("succeeded");
      yield* projectScheduledRunEvent(
        event(6, "thread.activity-appended", activity("approval.requested")),
      );
      expect((yield* store.run(run.id))!.run.status).toBe("succeeded");
      const notifications = yield* service.claimNotifications({ owner: "browser" });
      expect(notifications.notifications).toHaveLength(3);
      expect(new Set(notifications.notifications.map((n) => n.id)).size).toBe(3);
      expect(
        (yield* service.claimNotifications({ owner: "other-browser" })).notifications,
      ).toHaveLength(0);
      yield* service.acknowledgeNotifications({
        owner: "browser",
        ids: notifications.notifications.map((n) => n.id),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "an interrupted turn followed by a missing checkpoint retains ownership and continuation gates",
  () =>
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
      yield* service.drainDispatches;
      const current = (yield* store.run(run.id))!;
      yield* store.sql`UPDATE scheduled_task_runs SET turn_id='interrupted' WHERE id=${run.id}`;
      yield* store.sql`UPDATE scheduled_run_submissions SET turn_id='interrupted' WHERE run_id=${run.id}`;
      yield* store.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES(${current.run.threadId},'interrupted','interrupted',${new Date(0).toISOString()},'[]')`;
      yield* store.transition(run.id, "needs_attention", "interrupted", new Date(0).toISOString());
      yield* projectScheduledRunEvent({
        sequence: 10,
        eventId: EventId.makeUnsafe("missing-diff"),
        aggregateKind: "thread",
        aggregateId: current.run.threadId!,
        occurredAt: new Date(0).toISOString(),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.turn-diff-completed",
        payload: {
          threadId: current.run.threadId!,
          turnId: TurnId.makeUnsafe("interrupted"),
          status: "missing",
        },
      } as OrchestrationEvent);
      expect((yield* store.run(run.id))!.run.status).toBe("needs_attention");
      expect((yield* store.run(run.id))!.owner).toBe(true);
      expect(
        (yield* scheduledContinuationFor(current.run.threadId!, "interrupted", "restart"))?.runId,
      ).toBe(run.id);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("late usage settlement cannot overwrite an already-linked recovery decision", () =>
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
    yield* service.drainDispatches;
    const current = (yield* store.run(run.id))!;
    yield* store.sql`UPDATE scheduled_task_runs SET turn_id='limited' WHERE id=${run.id}`;
    yield* store.sql`UPDATE scheduled_run_submissions SET turn_id='limited' WHERE run_id=${run.id}`;
    const context = yield* scheduledContinuationFor(
      current.run.threadId!,
      "limited",
      "usage_limit",
    );
    yield* store.transaction(
      linkScheduledContinuation(context!, {
        submissionId: "resume-child",
        messageId: "resume-message",
        threadId: current.run.threadId!,
      }),
    );
    const revision = yield* store.readRevision;
    yield* projectScheduledRunEvent({
      sequence: 10,
      eventId: EventId.makeUnsafe("late-limit"),
      aggregateKind: "thread",
      aggregateId: current.run.threadId!,
      occurredAt: new Date(0).toISOString(),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId: current.run.threadId!,
        settledTurnId: TurnId.makeUnsafe("limited"),
        session: { status: "error", activeTurnId: null, usageLimit: {} },
      },
    } as OrchestrationEvent);
    yield* projectScheduledRunEvent({
      sequence: 11,
      eventId: EventId.makeUnsafe("late-running"),
      aggregateKind: "thread",
      aggregateId: current.run.threadId!,
      occurredAt: new Date(0).toISOString(),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId: current.run.threadId!,
        session: { status: "running", activeTurnId: "limited" },
      },
    } as OrchestrationEvent);
    yield* projectScheduledRunEvent({
      sequence: 12,
      eventId: EventId.makeUnsafe("late-approval-resolved"),
      aggregateKind: "thread",
      aggregateId: current.run.threadId!,
      occurredAt: new Date(0).toISOString(),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: current.run.threadId!,
        activity: { kind: "approval.resolved", turnId: "limited" },
      },
    } as OrchestrationEvent);
    expect((yield* store.run(run.id))!.run.reason).toBe("recovery_pending");
    expect((yield* service.claimNotifications({ owner: "browser" })).notifications).toHaveLength(0);
    yield* service.dispatch;
    expect((yield* store.run(run.id))!.capacity).toBe(true);
    expect(yield* store.readRevision).toBe(revision);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

for (const active of [false, true])
  it.effect(
    `removing a thread ${active ? "retains a running turn until stopped" : "settles a provably unsent run"}`,
    () =>
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
        yield* service.drainDispatches;
        const current = (yield* store.run(run.id))!;
        if (active) {
          yield* store.sql`UPDATE scheduled_task_runs SET turn_id='active' WHERE id=${run.id}`;
          yield* store.sql`UPDATE scheduled_run_submissions SET turn_id='active' WHERE run_id=${run.id}`;
          yield* store.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES(${current.run.threadId},'active','running',${new Date(0).toISOString()},'[]')`;
        }
        yield* projectScheduledRunEvent({
          sequence: 99,
          eventId: EventId.makeUnsafe("archive-run"),
          aggregateKind: "thread",
          aggregateId: current.run.threadId!,
          occurredAt: new Date(0).toISOString(),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.archived",
          payload: { threadId: current.run.threadId! },
        } as OrchestrationEvent);
        if (active) {
          expect((yield* store.run(run.id))!.run.status).toBe("needs_attention");
          expect((yield* store.run(run.id))!.owner).toBe(true);
          yield* store.sql`UPDATE projection_turns SET state='interrupted' WHERE thread_id=${current.run.threadId}`;
          yield* projectScheduledRunEvent({
            sequence: 100,
            eventId: EventId.makeUnsafe("archive-settlement"),
            aggregateKind: "thread",
            aggregateId: current.run.threadId!,
            occurredAt: new Date(0).toISOString(),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.session-set",
            payload: {
              threadId: current.run.threadId!,
              settledTurnId: "active",
              session: { status: "stopped", activeTurnId: null },
            },
          } as OrchestrationEvent);
          yield* service.reconcile;
        }
        expect((yield* store.run(run.id))!.run.status).toBe("failed");
        expect((yield* store.run(run.id))!.run.reason).toBe("thread_removed");
        expect((yield* store.run(run.id))!.owner).toBe(false);
        const another = yield* service.runNow(
          {
            taskId: task.id,
            runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
            requestedAt: new Date(0).toISOString(),
          },
          actor,
        );
        expect(another.status).toBe("pending");
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
