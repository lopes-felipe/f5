import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { OrchestrationEvent, ScheduledTaskRunId, TurnId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { makeNextTurnQueueStore } from "../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import { makeCommitSideEffects } from "../orchestration/commitSideEffects.ts";
import { projectScheduledRunEvent } from "./projector.ts";
import { scheduledSendGate } from "./sendGate.ts";
import { fenceScheduledRun } from "./cancellation.ts";
import { userScheduleActor } from "./Service.ts";
import { setup, seedScheduledThread, testLayer } from "./testing.ts";

const layer = testLayer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-answer-" })),
  Layer.provideMerge(NodeServices.layer),
);

for (const rollback of [false, true])
  it.effect(
    `links a human answer after projection ${rollback ? "atomically with queue rollback" : "without releasing scheduling ownership"}`,
    () =>
      Effect.gen(function* () {
        const { create, store, service, settings } = yield* setup;
        const { task } = yield* create();
        const run = yield* service.runNow(
          {
            taskId: task.id,
            runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
            requestedAt: new Date(0).toISOString(),
          },
          userScheduleActor,
        );
        yield* service.reserve((yield* store.run(run.id))!);
        const current = (yield* store.run(run.id))!;
        const command = current.command!;
        const threadId = command.threadId;
        const turnId = TurnId.makeUnsafe("input-turn");
        const at = new Date(0).toISOString();
        yield* seedScheduledThread(store, task, threadId);
        yield* store.sql`UPDATE scheduled_task_runs SET turn_id=${turnId},submission_started=1 WHERE id=${run.id}`;
        yield* store.sql`UPDATE scheduled_run_submissions SET turn_id=${turnId} WHERE run_id=${run.id}`;
        yield* store.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,processing_quiesced_at,checkpoint_files_json) VALUES(${threadId},${turnId},'completed',${at},${at},'[]')`;
        yield* store.sql`INSERT INTO projection_pending_user_inputs(thread_id,request_id,payload_json,resolution) VALUES(${threadId},'request',${JSON.stringify({ turnId })},NULL)`;
        yield* store.transition(run.id, "needs_attention", "user_input", at);
        const queue = yield* makeNextTurnQueueStore;
        const commit = makeCommitSideEffects({
          sql: store.sql,
          transitions: Option.none(),
          queueStore: Option.some(queue),
        });
        const event = Schema.decodeUnknownSync(OrchestrationEvent)({
          type: "thread.user-input-resolved",
          sequence: 10,
          eventId: "answer-event",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          commandId: "answer",
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            requestId: "request",
            resolution: "answered",
            createdAt: at,
            command: {
              type: "thread.turn.start",
              threadId,
              commandId: "answer",
              message: { messageId: "answer-message", role: "user", text: "yes", attachments: [] },
              // The queue must keep the run's configured execution settings.
              runtimeMode: "full-access",
              interactionMode: "default",
              model: "different-model",
              createdAt: at,
            },
          },
        });
        const result = yield* store.sql
          .withTransaction(
            Effect.gen(function* () {
              // Same order as OrchestrationEngine: projections before commit side effects.
              yield* store.sql`UPDATE projection_pending_user_inputs SET resolution='answered' WHERE thread_id=${threadId}`;
              yield* projectScheduledRunEvent(event);
              expect((yield* store.run(run.id))!.owner).toBe(true);
              yield* commit(event, {
                commandType: "thread.user-input.respond",
                steerFallback: false,
                readModel: createEmptyReadModel(at),
              });
              if (rollback) return yield* Effect.fail("rollback command");
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe(rollback ? "Failure" : "Success");
        const after = (yield* store.run(run.id))!;
        expect(after.owner).toBe(true);
        expect(after.capacity).toBe(true);
        const links =
          yield* store.sql`SELECT parent_submission_id,kind FROM scheduled_run_submissions WHERE submission_id='answer'`;
        expect(links).toEqual(
          rollback ? [] : [{ parent_submission_id: current.submissionId, kind: "user_input" }],
        );
        const { items } = yield* queue.listByThread(threadId);
        expect(items).toHaveLength(rollback ? 0 : 1);
        if (!rollback) {
          expect(items[0]!.command.runtimeMode).toBe("approval-required");
          expect(items[0]!.command.modelSelection).toEqual(task.modelSelection);
          expect(after.run.reason).toBe("recovery_pending");
          yield* store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
          expect(yield* scheduledSendGate(store.sql, yield* settings.getSettings, "answer")).toBe(
            "ready",
          );
          yield* service.setEnabled(
            {
              id: task.id,
              expectedVersion: (yield* store.task(task.id))!.task.version,
              enabled: false,
            },
            userScheduleActor,
          );
          // Disabling future fires allows an already-started human response to
          // finish; an explicit run cancellation must fence its durable queue.
          expect(yield* scheduledSendGate(store.sql, yield* settings.getSettings, "answer")).toBe(
            "ready",
          );
          yield* store.transaction(fenceScheduledRun(run.id, at));
          expect(yield* scheduledSendGate(store.sql, yield* settings.getSettings, "answer")).toBe(
            "cancel",
          );
          expect((yield* queue.listByThread(threadId)).items).toHaveLength(0);
        } else {
          expect(after.run.reason).toBe("user_input");
          expect(
            yield* store.sql`SELECT resolution FROM projection_pending_user_inputs WHERE thread_id=${threadId}`,
          ).toEqual([{ resolution: null }]);
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
