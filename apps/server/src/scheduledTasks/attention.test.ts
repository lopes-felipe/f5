import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { EventId, ScheduledTaskRunId, type OrchestrationEvent } from "@t3tools/contracts";
import { setup, seedScheduledThread, testLayer } from "./testing.ts";
import { userScheduleActor } from "./Service.ts";
import { projectScheduledRunEvent } from "./projector.ts";
import { scheduledContinuationFor } from "./continuations.ts";
import { makeNextTurnQueueStore } from "../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { ServerConfig } from "../config.ts";
import { canonicalRequestHash } from "../nextTurnQueue/canonicalRequestHash.ts";
import { assertScheduledDeliveryAllowed } from "./deliveryGate.ts";
import { scheduledSendGate } from "./sendGate.ts";
const reserve = Effect.gen(function* () {
  const f = yield* setup;
  const { task } = yield* f.create();
  const run = yield* f.service.runNow(
    {
      taskId: task.id,
      runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
      requestedAt: new Date(0).toISOString(),
    },
    userScheduleActor,
  );
  yield* f.service.reserve((yield* f.store.run(run.id))!);
  const current = (yield* f.store.run(run.id))!;
  yield* seedScheduledThread(f.store, task, current.run.threadId!);
  yield* f.store
    .sql`UPDATE scheduled_task_runs SET submission_started=1,turn_id='source' WHERE id=${run.id}`;
  yield* f.store.sql`UPDATE scheduled_run_submissions SET turn_id='source' WHERE run_id=${run.id}`;
  yield* f.store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
  return { ...f, task, current, run };
});
it.effect(
  "a completed turn cannot settle an unanswered input; native resolution resumes settlement",
  () =>
    Effect.gen(function* () {
      const { task, store, run, current } = yield* reserve;
      const at = new Date(0).toISOString();
      yield* store.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,processing_quiesced_at,checkpoint_files_json) VALUES(${current.run.threadId},'source','completed',${at},${at},'[]')`;
      yield* store.sql`INSERT INTO projection_pending_user_inputs(thread_id,request_id,payload_json) VALUES(${current.run.threadId},'question','{"turnId":"source","questions":[]}')`;
      yield* store.transition(run.id, "needs_attention", "user_input", at);
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        ({
          sequence,
          eventId: EventId.makeUnsafe(`input-${sequence}`),
          aggregateKind: "thread",
          aggregateId: current.run.threadId,
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload,
        }) as OrchestrationEvent;
      yield* projectScheduledRunEvent(
        event(1, "thread.turn-processing-quiesced", {
          threadId: current.run.threadId,
          turnId: "source",
        }),
      );
      expect((yield* store.run(run.id))!.run.status).toBe("needs_attention");
      expect((yield* store.run(run.id))!.owner).toBe(true);
      yield* store.sql`UPDATE projection_pending_user_inputs SET resolution='answered' WHERE thread_id=${current.run.threadId}`;
      yield* projectScheduledRunEvent(
        event(2, "thread.user-input-resolved", {
          threadId: current.run.threadId,
          requestId: "question",
          resolution: "answered",
          createdAt: at,
        }),
      );
      expect((yield* store.run(run.id))!.run.status).toBe("succeeded");
      expect((yield* store.task(task.id))!.task.runsConsumed).toBe(1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect(
  "queues human input continuation atomically with frozen execution settings and retained capacity",
  () =>
    Effect.gen(function* () {
      const { store, settings, current, run, task } = yield* reserve;
      const queue = yield* makeNextTurnQueueStore.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-scheduled-answer-" })),
      );
      const context = (yield* scheduledContinuationFor(
        current.run.threadId!,
        "source",
        "user_input",
      ))!;
      const { bootstrap: _bootstrap, ...initial } = current.command!;
      const command = {
        ...initial,
        commandId: "answer-command" as typeof initial.commandId,
        message: {
          ...initial.message,
          messageId: "answer-message" as typeof initial.message.messageId,
          text: "Answer",
          attachments: [],
        },
        model: "changed",
        modelSelection: { ...initial.modelSelection!, model: "changed" },
        runtimeMode: "full-access" as const,
      };
      yield* queue.insertSubmission({
        scheduledRun: context,
        submissionId: command.commandId,
        itemId: command.commandId,
        requestHash: canonicalRequestHash(command),
        command,
        atHead: false,
      });
      const queued = yield* queue.getByCommandId(command.commandId);
      expect(queued!.command.runtimeMode).toBe("approval-required");
      expect(queued!.command.modelSelection).toEqual(task.modelSelection);
      expect((yield* store.run(run.id))!.capacity).toBe(true);
      expect((yield* store.task(task.id))!.task.runsConsumed).toBe(1);
      yield* settings.updateSettings({ scheduledTasks: { enabled: false } });
      expect(
        yield* scheduledSendGate(store.sql, yield* settings.getSettings, command.commandId),
      ).toBe("ready");
      expect(
        yield* scheduledSendGate(store.sql, yield* settings.getSettings, initial.commandId),
      ).toBe("wait");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
it.effect("the final send gate rejects provider, model, options and approval-mode drift", () =>
  Effect.gen(function* () {
    const { store, task, current } = yield* reserve;
    const actual = {
      instanceId: task.modelSelection.instanceId,
      model: task.modelSelection.model,
      modelSelection: task.modelSelection,
    };
    yield* assertScheduledDeliveryAllowed(current.submissionId!, actual);
    for (const changed of [
      { ...actual, instanceId: "other" },
      { ...actual, model: "other" },
      {
        ...actual,
        modelSelection: { ...actual.modelSelection, options: [{ id: "effort", value: "high" }] },
      },
    ])
      expect(
        (yield* Effect.result(assertScheduledDeliveryAllowed(current.submissionId!, changed)))._tag,
      ).toBe("Failure");
    yield* store.sql`UPDATE projection_threads SET runtime_mode='full-access' WHERE thread_id=${current.run.threadId}`;
    expect(
      (yield* Effect.result(assertScheduledDeliveryAllowed(current.submissionId!, actual)))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "definitive not-sent delivery failure settles and releases capacity during reconciliation",
  () =>
    Effect.gen(function* () {
      const { store, service, current, run } = yield* reserve;
      const at = new Date(0).toISOString();
      yield* store.sql`INSERT INTO provider_turn_deliveries(delivery_id,thread_id,command_id,message_id,state,certainty,event_json,error_detail,created_at,updated_at) VALUES(${current.submissionId},${current.run.threadId},${current.submissionId},${current.command!.message.messageId},'rejected','not_sent','{}','Rejected',${at},${at})`;
      yield* service.reconcile;
      const settled = (yield* store.run(run.id))!;
      expect(settled.run.status).toBe("failed");
      expect(settled.run.reason).toBe("delivery_failed");
      expect(settled.owner).toBe(false);
      expect(settled.capacity).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
