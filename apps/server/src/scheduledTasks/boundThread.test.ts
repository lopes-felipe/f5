import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, PubSub } from "effect";
import { TestClock } from "effect/testing";
import {
  EventId,
  ProviderInstanceId,
  SCHEDULED_TASK_TURN_SUBMITTED_ACTIVITY_KIND,
  ScheduledTaskRunId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ScheduledTask,
} from "@t3tools/contracts";
import { emptyQueue, provider } from "../agentBridge/testing/fakeHost.ts";
import { assertScheduledThreadPurgeable } from "../storage/threadPurgePolicy.ts";
import { userScheduleActor as actor } from "./Service.ts";
import { projectScheduledRunEvent } from "./projector.ts";
import { scheduledContinuationFor } from "./continuations.ts";
import { assertScheduledDeliveryAllowed } from "./deliveryGate.ts";
import { scheduledSendGate } from "./sendGate.ts";
import { seedBoundThread, setup, testLayer } from "./testing.ts";

const THREAD = ThreadId.makeUnsafe("conversation");
const bound = Effect.gen(function* () {
  const f = yield* setup;
  f.host.providers = [provider("codex", "codex", ["model-a", "model-b"])];
  yield* seedBoundThread(f.host, f.store, THREAD);
  const createBound = (extra = {}) =>
    f.create({ workspace: { kind: "thread", threadId: THREAD }, ...extra });
  const runNow = (task: ScheduledTask) =>
    f.service.runNow(
      {
        taskId: task.id,
        runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
        requestedAt: new Date(0).toISOString(),
      },
      actor,
    );
  const fire = (task: ScheduledTask) =>
    Effect.gen(function* () {
      const run = yield* runNow(task);
      yield* f.service.dispatch;
      yield* f.service.drainDispatches;
      return (yield* f.store.run(run.id))!;
    });
  const event = (
    sequence: number,
    type: OrchestrationEvent["type"],
    payload: unknown,
  ): OrchestrationEvent =>
    ({
      sequence,
      eventId: EventId.makeUnsafe(`event-${sequence}`),
      aggregateKind: "thread",
      aggregateId: THREAD,
      occurredAt: new Date(sequence * 1000).toISOString(),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    }) as OrchestrationEvent;
  return { ...f, createBound, runNow, fire, event };
});
const associate = (
  sql: import("effect/unstable/sql/SqlClient").SqlClient,
  runId: string,
  turnId: string,
) =>
  Effect.gen(function* () {
    yield* sql`UPDATE scheduled_task_runs SET turn_id=${turnId},submission_started=1 WHERE id=${runId}`;
    yield* sql`UPDATE scheduled_run_submissions SET turn_id=${turnId} WHERE run_id=${runId}`;
  });

it.effect("a busy conversation keeps the run pending without taking capacity", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    yield* seedBoundThread(f.host, f.store, THREAD, {
      session: { activeTurnId: TurnId.makeUnsafe("user-turn"), status: "running" } as never,
    });
    const { task } = yield* f.createBound();
    const run = yield* f.fire(task);
    expect(run.run.status).toBe("pending");
    expect(run.capacity).toBe(false);
    expect(run.retryAt).not.toBeNull();
    expect(f.host.submissions).toHaveLength(0);
    // A queued user message or pending approval also blocks admission.
    yield* seedBoundThread(f.host, f.store, THREAD);
    f.host.queues.set(THREAD, {
      ...emptyQueue(THREAD),
      items: [{ itemId: "user-item", submissionId: "user-item", status: "queued" }] as never,
    });
    yield* TestClock.adjust("31 seconds");
    yield* f.service.dispatch;
    expect(f.host.submissions).toHaveLength(0);
    // Later fires coalesce while the run waits.
    const second = yield* f.runNow(task);
    expect(second.reason).toBe("already_pending");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("an idle claim sends the conversation's live settings to the queue tail", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    expect(task.modelSelection.model).toBe("model-a");
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-b" },
      interactionMode: "plan",
    });
    const run = yield* f.fire(task);
    expect(run.run.threadId).toBe(THREAD);
    expect(run.capacity).toBe(true);
    const submission = f.host.submissions[0]!;
    expect(submission.intent).toBe("queue-tail");
    expect(submission.command.threadId).toBe(THREAD);
    expect(submission.command.bootstrap).toBeUndefined();
    expect(submission.command.modelSelection?.model).toBe("model-b");
    expect(submission.command.interactionMode).toBe("plan");
    expect(f.host.dispatched).toEqual([
      expect.objectContaining({
        type: "thread.activity.append",
        commandId: `scheduled-activity:${run.submissionId}`,
        threadId: THREAD,
        activity: expect.objectContaining({
          kind: SCHEDULED_TASK_TURN_SUBMITTED_ACTIVITY_KIND,
          summary: `Queued by scheduled task "${task.name}"`,
          payload: { taskId: task.id, runId: run.run.id, submissionId: run.submissionId },
        }),
      }),
    ]);
    // Settle the first run; the next one shares the same conversation.
    yield* f.store.transition(run.run.id, "succeeded", null, new Date(0).toISOString());
    const next = yield* f.fire(task);
    expect(next.run.threadId).toBe(THREAD);
    expect(f.host.submissions).toHaveLength(2);
    expect(yield* scheduledContinuationFor(THREAD, null, "restart")).toBeUndefined();
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("rejects legacy, scheduled-origin, archived and foreign conversations at save", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    for (const overrides of [
      { modelSelection: undefined },
      { scheduledOrigin: { taskId: "other", runId: "run" } },
      { archivedAt: new Date(0).toISOString() },
      { projectId: "elsewhere" },
    ] as const) {
      yield* seedBoundThread(f.host, f.store, THREAD, overrides as never);
      const result = yield* Effect.result(f.createBound());
      expect(result._tag).toBe("Failure");
    }
    yield* seedBoundThread(f.host, f.store, THREAD, { modelSelection: undefined });
    const legacy = yield* Effect.result(f.createBound());
    if (legacy._tag === "Failure")
      expect(legacy.failure.message).toBe(
        "Send a message in this conversation before scheduling into it.",
      );
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("an edit after a provider switch validates and stores the conversation's settings", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    });
    const update = (version: number) =>
      f.service.update(
        { id: task.id, expectedVersion: version, configuration: { ...task, prompt: "Changed" } },
        actor,
      );
    expect((yield* Effect.result(update(task.version)))._tag).toBe("Failure");
    f.host.providers = [...f.host.providers, provider("claude", "claudeAgent", ["sonnet"])];
    const saved = (yield* update(task.version)).task;
    expect(saved.modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("archive and delete disable bound tasks at claim and at event time", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    f.host.threads = [];
    const run = yield* f.fire(task);
    expect(run.run.status).toBe("skipped");
    expect(run.run.reason).toBe("thread_removed");
    const disabled = (yield* f.store.task(task.id))!.task;
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledReason).toBe("thread_unavailable");
    // Re-enabling requires an eligible conversation.
    expect(
      (yield* Effect.result(
        f.service.setEnabled(
          { id: task.id, expectedVersion: disabled.version, enabled: true },
          actor,
        ),
      ))._tag,
    ).toBe("Failure");
    const notified = yield* f.store.sql<{
      id: string;
    }>`SELECT id FROM scheduled_notifications WHERE run_id=${run.run.id}`;
    expect(notified).toHaveLength(1);

    yield* seedBoundThread(f.host, f.store, THREAD);
    const live = (yield* f.service.setEnabled(
      { id: task.id, expectedVersion: disabled.version, enabled: true },
      actor,
    )).id;
    yield* f.service.start;
    // Let the forked event subscription attach before publishing.
    yield* TestClock.adjust("10 millis");
    yield* PubSub.publish(
      f.host.domainEvents,
      f.event(1, "thread.archived", { threadId: THREAD, archivedAt: new Date(0).toISOString() }),
    );
    for (let i = 0; i < 50 && (yield* f.store.task(live))!.task.enabled; i++)
      yield* TestClock.adjust("10 millis");
    expect((yield* f.store.task(live))!.task.disabledReason).toBe("thread_unavailable");
    // A task is disabled, never deleted.
    expect((yield* f.service.list({}, actor)).tasks.map((t) => t.task.id)).toContain(task.id);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("the startup sweep disables tasks bound to an archived conversation", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    yield* seedBoundThread(f.host, f.store, THREAD, { archivedAt: new Date(0).toISOString() });
    yield* f.service.start;
    expect((yield* f.store.task(task.id))!.task.disabledReason).toBe("thread_unavailable");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("resolving a bound run is not blocked by the user's own active turn", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    const run = yield* f.fire(task);
    yield* f.store.transition(
      run.run.id,
      "needs_attention",
      "delivery_unknown",
      new Date(0).toISOString(),
    );
    yield* seedBoundThread(f.host, f.store, THREAD, {
      session: { activeTurnId: TurnId.makeUnsafe("user-turn"), status: "running" } as never,
      latestTurn: { turnId: "user-turn", state: "running" } as never,
    });
    const resolved = yield* f.service.resolveRun(
      { runId: run.run.id, acknowledgeUnknownDelivery: true },
      actor,
    );
    expect(resolved.status).toBe("failed");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("reconcile ignores the user's paused or failed items and flags lost submissions", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    const run = yield* f.fire(task);
    const item = (submissionId: string, status = "queued") =>
      ({ itemId: submissionId, submissionId, status, lastErrorDetail: null }) as never;
    f.host.queues.set(THREAD, {
      ...emptyQueue(THREAD),
      paused: true,
      blockedKind: "paused",
      items: [item("user-item", "failed"), item(run.submissionId!)],
    });
    yield* f.service.reconcile;
    expect((yield* f.store.run(run.run.id))!.run.status).toBe("pending");
    f.host.queues.set(THREAD, {
      ...emptyQueue(THREAD),
      paused: true,
      blockedKind: "paused",
      items: [item(run.submissionId!)],
    });
    yield* f.service.reconcile;
    expect((yield* f.store.run(run.run.id))!.run.reason).toBe("manual_pause");

    const { task: other } = yield* f.createBound({ name: "Other" });
    f.host.queues.delete(THREAD);
    const lost = yield* f.fire(other);
    yield* TestClock.adjust("11 minutes");
    yield* f.service.reconcile;
    expect((yield* f.store.run(lost.run.id))!.run.reason).toBe("delivery_unknown");
    // An owning bound run blocks storage purge of the conversation.
    expect((yield* Effect.result(assertScheduledThreadPurgeable(f.store.sql, THREAD)))._tag).toBe(
      "Failure",
    );
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("the delivery gate checks bound runs against the admitted command", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    // A provider change before the claim is picked up by the command and delivers.
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-b" },
    });
    const run = yield* f.fire(task);
    yield* f.store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
    const settings = yield* f.settings.getSettings;
    const admitted = { instanceId: "codex", model: "model-b" };
    expect(yield* scheduledSendGate(f.store.sql, settings, run.submissionId!)).toBe("ready");
    yield* assertScheduledDeliveryAllowed(run.submissionId!, admitted);
    // A change between claim and delivery cancels the item instead of reverting the thread.
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-a" },
    });
    expect(yield* scheduledSendGate(f.store.sql, settings, run.submissionId!)).toBe("cancel");
    expect(
      (yield* Effect.result(
        assertScheduledDeliveryAllowed(run.submissionId!, {
          instanceId: "codex",
          model: "model-a",
        }),
      ))._tag,
    ).toBe("Failure");
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-b" },
      interactionMode: "plan",
    });
    expect(yield* scheduledSendGate(f.store.sql, settings, run.submissionId!)).toBe("cancel");
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-b" },
      runtimeMode: "full-access",
    });
    expect(yield* scheduledSendGate(f.store.sql, settings, run.submissionId!)).toBe("cancel");
    // Disabling the scheduler cancels a bound item instead of holding the user's queue.
    yield* seedBoundThread(f.host, f.store, THREAD, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-b" },
    });
    yield* f.settings.updateSettings({ scheduledTasks: { enabled: false } });
    expect(
      yield* scheduledSendGate(f.store.sql, yield* f.settings.getSettings, run.submissionId!),
    ).toBe("cancel");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("two tasks bound to one conversation settle independently", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const first = (yield* f.createBound({ name: "First" })).task;
    const second = (yield* f.createBound({ name: "Second" })).task;
    const at = new Date(0).toISOString();
    const a = yield* f.fire(first);
    yield* associate(f.store.sql, a.run.id, "turn-a");
    // The second run is admitted only once the first one's turn has started.
    yield* f.store.transition(a.run.id, "running", null, at);
    const b = yield* f.fire(second);
    yield* associate(f.store.sql, b.run.id, "turn-b");
    yield* f.store
      .sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,completed_at,processing_quiesced_at,checkpoint_files_json)
      VALUES(${THREAD},'turn-a','completed',${at},${at},${at},${at},'[]')`;
    yield* projectScheduledRunEvent(
      f.event(1, "thread.turn-processing-quiesced", { threadId: THREAD, turnId: "turn-a" }),
    );
    expect((yield* f.store.run(a.run.id))!.run.status).toBe("succeeded");
    expect((yield* f.store.run(b.run.id))!.run.status).toBe("pending");
    // The user's own request has no turn id in this shared conversation; it is not ours.
    yield* projectScheduledRunEvent(
      f.event(2, "thread.activity-appended", {
        threadId: THREAD,
        activity: {
          id: "user-approval",
          kind: "approval.requested",
          turnId: null,
          createdAt: at,
          payload: {},
        },
      }),
    );
    expect((yield* f.store.run(b.run.id))!.run.status).toBe("pending");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("interrupted and usage-limited bound runs are terminal and release capacity", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const first = (yield* f.createBound({ name: "Interrupted" })).task;
    const second = (yield* f.createBound({ name: "Limited" })).task;
    const a = yield* f.fire(first);
    yield* associate(f.store.sql, a.run.id, "turn-a");
    yield* f.store.transition(a.run.id, "running", null, new Date(0).toISOString());
    const b = yield* f.fire(second);
    yield* associate(f.store.sql, b.run.id, "turn-b");
    const session = (settledTurnId: string, extra = {}) => ({
      threadId: THREAD,
      settledTurnId,
      session: {
        threadId: THREAD,
        status: "stopped",
        activeTurnId: null,
        providerName: "codex",
        lastError: null,
        updatedAt: new Date(0).toISOString(),
        ...extra,
      },
    });
    yield* projectScheduledRunEvent(f.event(1, "thread.session-set", session("turn-a")));
    yield* projectScheduledRunEvent(
      f.event(
        2,
        "thread.session-set",
        session("turn-b", { status: "ready", usageLimit: { resetsAt: null } }),
      ),
    );
    const interrupted = (yield* f.store.run(a.run.id))!;
    const limited = (yield* f.store.run(b.run.id))!;
    expect([interrupted.run.status, interrupted.run.reason]).toEqual(["failed", "interrupted"]);
    expect([limited.run.status, limited.run.reason]).toEqual(["failed", "usage_limit"]);
    for (const run of [interrupted, limited]) {
      expect(run.owner).toBe(false);
      expect(run.capacity).toBe(false);
    }
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("only one bound run is admitted per conversation in a dispatch pass", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const first = (yield* f.createBound({ name: "First" })).task;
    const second = (yield* f.createBound({ name: "Second" })).task;
    const a = yield* f.runNow(first);
    const b = yield* f.runNow(second);
    yield* f.service.dispatch;
    yield* f.service.drainDispatches;
    expect(f.host.submissions).toHaveLength(1);
    const runs = [(yield* f.store.run(a.id))!, (yield* f.store.run(b.id))!];
    const admitted = runs.find((run) => run.capacity)!;
    const waiting = runs.find((run) => run !== admitted)!;
    expect(admitted.submissionId).toBe(f.host.submissions[0]!.submissionId);
    expect([waiting.run.status, waiting.run.reason, waiting.capacity]).toEqual([
      "pending",
      "conversation_busy",
      false,
    ]);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("a usage-limit rejection before any turn settles the bound run", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    const run = yield* f.fire(task);
    const at = new Date(0).toISOString();
    yield* f.store
      .sql`INSERT INTO provider_turn_deliveries(delivery_id,thread_id,command_id,message_id,state,certainty,event_json,error_detail,usage_limit_json,created_at,updated_at) VALUES(${run.submissionId},${THREAD},${run.submissionId},${run.command!.message.messageId},'rejected','not_sent','{}','Usage limit reached','{}',${at},${at})`;
    // The queue keeps the rejected item; only the run's own outcome matters.
    f.host.queues.set(THREAD, {
      ...emptyQueue(THREAD),
      paused: true,
      blockedKind: "paused",
      items: [
        {
          itemId: run.submissionId,
          submissionId: run.submissionId,
          status: "failed",
          lastErrorDetail: null,
        },
      ] as never,
    });
    yield* f.service.reconcile;
    const settled = (yield* f.store.run(run.run.id))!;
    expect([settled.run.status, settled.run.reason]).toEqual(["failed", "usage_limit"]);
    expect(settled.capacity).toBe(false);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("a stale run for a removed conversation does not disable a retargeted task", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    const pending = yield* f.runNow(task);
    const retargeted = (yield* f.service.update(
      {
        id: task.id,
        expectedVersion: task.version,
        configuration: { ...task, workspace: { kind: "projectRoot" } },
      },
      actor,
    )).task;
    f.host.threads = [];
    yield* f.service.dispatch;
    yield* f.service.drainDispatches;
    expect((yield* f.store.run(pending.id))!.run.reason).toBe("thread_removed");
    const live = (yield* f.store.task(task.id))!.task;
    expect(live.enabled).toBe(true);
    expect(live.workspace).toEqual({ kind: "projectRoot" });
    expect(live.version).toBe(retargeted.version);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("findRunForTurn maps a bound turn to its run for the user only", () =>
  Effect.gen(function* () {
    const f = yield* bound;
    const { task } = yield* f.createBound();
    const run = yield* f.fire(task);
    yield* associate(f.store.sql, run.run.id, "turn-a");
    expect(
      yield* f.service.findRunForTurn(
        { threadId: THREAD, turnId: TurnId.makeUnsafe("turn-a") },
        actor,
      ),
    ).toEqual({ runId: run.run.id });
    expect(
      yield* f.service.findRunForTurn(
        { threadId: THREAD, turnId: TurnId.makeUnsafe("user-turn") },
        actor,
      ),
    ).toEqual({ runId: null });
    expect(
      (yield* Effect.result(
        f.service.findRunForTurn(
          { threadId: THREAD, turnId: TurnId.makeUnsafe("turn-a") },
          { kind: "agent", clientId: "local", grantGeneration: 0 },
        ),
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
