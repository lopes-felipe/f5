import { ServerShutdown, ShutdownRegistry } from "../../shutdown.ts";
import { ProviderAdapterRequestError, ProviderTurnDeliveryError } from "../../provider/Errors.ts";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  ScheduledTaskRunId,
  type RuntimeUsageLimit,
  type OrchestrationUsageLimit,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Metric, Option, Stream } from "effect";

import {
  deliveryAmbiguousTotal,
  deliveryAttemptsActive,
  deliveryOutboxRowsDecoded,
} from "../../observability/Metrics.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";

import { DeliveryAttemptContext } from "../../provider/deliveryAttemptContext";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  type ProviderTurnDelivery,
  ProviderTurnDeliveryRepository,
} from "../Services/ProviderTurnDeliveryRepository.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import { ProviderTurnDeliveryWorkerLive } from "./ProviderTurnDeliveryWorker.ts";
import {
  setup as scheduledSetup,
  testLayer as scheduledTestLayer,
} from "../../scheduledTasks/testing.ts";
import { userScheduleActor } from "../../scheduledTasks/Service.ts";

const deliveryId = CommandId.makeUnsafe("delivery-unknown-outcome");
const commandId = CommandId.makeUnsafe("command-unknown-outcome");
const threadId = ThreadId.makeUnsafe("thread-unknown-outcome");
const messageId = MessageId.makeUnsafe("message-unknown-outcome");
const createdAt = "2026-01-01T00:00:00.000Z";

let state: ProviderTurnDelivery;
let usageRejection: RuntimeUsageLimit | null = null;
let usageRequestMethod: string | null = null;
let failureProjectionFails = false;
let failureProjectionCount = 0;
let requeueCount = 0;
let outcomeProjected = false;
let providerReadFails = false;
let pendingBarrier = true;
let reconciliationCount = 0;
let acceptSend = false;
let unavailableDispatchSnapshot = false;
let supersededByStop = false;
let pendingControl: Effect.Effect<void> | undefined;
let beforePrepared: Effect.Effect<void> | undefined;
let methodNotFound = false;
let reconciliationFails = false;
let extraReplayDelivery: ProviderTurnDelivery | null = null;
let providerTurns: Array<{ id: TurnId; items: unknown[] }> = [];
let acceptedTurnIds: Array<TurnId> = [];
let supersedingPreSendTurnIds: Array<TurnId> | null = null;
let abandonApplies = true;
let pendingTurnStartMessageId: MessageId | null = null;
let pendingTurnStartDeletes = 0;

function resetDelivery() {
  state = {
    deliveryId,
    threadId,
    commandId,
    messageId,
    state: "pending",
    providerTurnId: null,
    attempt: 0,
    preSendTurnIds: [],
    event: {
      type: "thread.turn-start-requested",
      commandId,
    } as never,
    errorCode: null,
    errorDetail: null,
    certainty: null,
    notBefore: null,
    createdAt,
    updatedAt: createdAt,
    outcomeProjectedAt: null,
  };
  usageRejection = null;
  usageRequestMethod = null;
  failureProjectionFails = false;
  failureProjectionCount = 0;
  requeueCount = 0;
  outcomeProjected = false;
  providerReadFails = false;
  pendingBarrier = true;
  reconciliationCount = 0;
  acceptSend = false;
  unavailableDispatchSnapshot = false;
  supersededByStop = false;
  pendingControl = undefined;
  beforePrepared = undefined;
  methodNotFound = false;
  reconciliationFails = false;
  extraReplayDelivery = null;
  providerTurns = [];
  acceptedTurnIds = [];
  supersedingPreSendTurnIds = null;
  abandonApplies = true;
  pendingTurnStartMessageId = null;
  pendingTurnStartDeletes = 0;
  activeAttemptsDuringDelivery = null;
}

let activeAttemptsDuringDelivery: number | null = null;

const deliverTurnStartOutcome = (): Effect.Effect<
  { readonly turnId: TurnId },
  | ProviderAdapterRequestError
  | ProviderTurnDeliveryError
  | Error
  | { readonly cause: { readonly cause: { readonly code: number; readonly message: string } } }
> =>
  usageRejection && usageRequestMethod
    ? Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: usageRequestMethod,
          detail: "Usage limit reached",
          usageLimit: usageRejection,
        }),
      )
    : usageRejection
      ? Effect.fail(
          new ProviderTurnDeliveryError({
            certainty: "not_sent",
            retryable: true,
            detail: "Usage limit reached",
            usageLimit: usageRejection,
          }),
        )
      : methodNotFound
        ? Effect.fail({ cause: { cause: { code: -32601, message: "Method not found" } } })
        : acceptSend
          ? Effect.succeed({ turnId: TurnId.makeUnsafe("existing-turn") })
          : Effect.fail(new Error("session not found after request write"));

const reconcile = (target: ThreadId) =>
  Effect.gen(function* () {
    reconciliationCount += 1;
    if (reconciliationFails && target === threadId) {
      return yield* new PersistenceSqlError({ operation: "reconcile", detail: "database is busy" });
    }
    if (state.state === "accepted") pendingBarrier = false;
  });

const repositoryLayer = Layer.succeed(ProviderTurnDeliveryRepository, {
  recordDispatchIntent: (input: {
    preSendTurnIds: TurnId[];
    historyEvidence: ProviderTurnDelivery["historyEvidence"];
  }) =>
    Effect.sync(() => {
      state = {
        ...state,
        preSendTurnIds: input.preSendTurnIds,
        historyEvidence: input.historyEvidence,
      };
      return true;
    }),
  listCandidateIds: () =>
    Effect.sync(() => (state.state === "pending" ? [{ deliveryId, threadId }] : [])),
  listActionable: Effect.sync(() => (state.state === "pending" ? [state] : [])),
  listSending: Effect.sync(() => (state.state === "sending" ? [state] : [])),
  listUnprojectedTerminal: Effect.sync(() =>
    (state.state === "accepted" || state.state === "rejected" || state.state === "ambiguous") &&
    !outcomeProjected
      ? [state, ...(extraReplayDelivery ? [extraReplayDelivery] : [])]
      : [],
  ),
  getByCommandId: () => Effect.succeed(state),
  getLatestByThread: () => Effect.succeed(state),
  getUnresolvedByThread: () => Effect.succeed(state),
  listAcceptedTurnIdsByThread: () => Effect.sync(() => acceptedTurnIds),
  getSupersedingPreSendTurnIds: () => Effect.sync(() => supersedingPreSendTurnIds),
  claim: (_deliveryId: CommandId, preSendTurnIds: ReadonlyArray<never>) =>
    Effect.sync(() => {
      if (state.state !== "pending") return null;
      state = {
        ...state,
        state: "sending",
        attempt: state.attempt + 1,
        attemptId: "test-attempt",
        preSendTurnIds,
      };
      return state;
    }),
  markAccepted: (input: { readonly providerTurnId: TurnId }) =>
    Effect.sync(() => {
      state = { ...state, state: "accepted", providerTurnId: input.providerTurnId };
      return true;
    }),
  markRejected: (input: {
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
    readonly usageLimit?: OrchestrationUsageLimit;
  }) =>
    Effect.sync(() => {
      state = {
        ...state,
        state: input.ambiguous ? "ambiguous" : "rejected",
        errorCode: input.errorCode,
        errorDetail: input.errorDetail,
        certainty: input.certainty,
        ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}),
      };
      return true;
    }),
  requeue: () =>
    Effect.sync(() => {
      requeueCount += 1;
      state = { ...state, state: "pending" };
    }),
  retryTerminal: () => Effect.succeed(null),
  markAbandoned: () =>
    Effect.sync(() => {
      if (!abandonApplies) return false;
      state = { ...state, state: "abandoned" };
      return true;
    }),
  markOutcomeProjected: () =>
    Effect.sync(() => {
      outcomeProjected = true;
      state = { ...state, outcomeProjectedAt: new Date().toISOString() };
    }),
} as never);

const testLayer = ProviderTurnDeliveryWorkerLive.pipe(
  Layer.provideMerge(repositoryLayer),
  Layer.provideMerge(
    Layer.succeed(ProviderService, {
      readThread: () =>
        providerReadFails
          ? Effect.fail(new Error("provider unavailable"))
          : Effect.succeed({ threadId, turns: providerTurns }),
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(ProviderCommandReactor, {
      deliverTurnStart: () =>
        Metric.value(deliveryAttemptsActive).pipe(
          Effect.tap((gauge) =>
            Effect.sync(() => {
              activeAttemptsDuringDelivery = gauge.value;
            }),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const context = yield* DeliveryAttemptContext;
              if (beforePrepared) yield* beforePrepared;
              if (unavailableDispatchSnapshot && context) yield* context.prepared(null);
              return yield* Effect.suspend(deliverTurnStartOutcome);
            }),
          ),
        ),
      recordTurnStartFailure: () =>
        Effect.sync(() => {
          failureProjectionCount += 1;
        }).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              failureProjectionFails
                ? Effect.fail(new Error("projection unavailable"))
                : Effect.void,
            ),
          ),
        ),
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(ProjectionTurnRepository, {
      reconcileAcceptedPendingTurnStarts: ({ threadId: target }: { threadId: ThreadId }) =>
        reconcile(target),
      reconcileAllAcceptedPendingTurnStarts: Effect.suspend(() => reconcile(threadId)),
      getPendingTurnStartByThreadId: () =>
        Effect.sync(() =>
          pendingTurnStartMessageId === null
            ? Option.none()
            : Option.some({ threadId, messageId: pendingTurnStartMessageId }),
        ),
      deletePendingTurnStartByThreadId: () =>
        Effect.sync(() => {
          pendingTurnStartDeletes += 1;
        }),
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(OrchestrationEngineService, {
      streamDomainEvents: Stream.empty,
      isTurnStartSuperseded: () => supersededByStop,
      waitForControlProgress: () => pendingControl ?? Effect.void,
      getReadModel: () =>
        Effect.succeed({
          threads: [
            {
              id: threadId,
              session: { providerInstanceId: ProviderInstanceId.makeUnsafe("claude-instance") },
            },
          ],
        }),
    } as never),
  ),
);

const setupScheduledDelivery = Effect.gen(function* () {
  resetDelivery();
  const { create, service, store } = yield* scheduledSetup;
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
  state = {
    ...state,
    commandId: current.command!.commandId,
    threadId: current.command!.threadId,
    messageId: current.command!.message.messageId,
    event: { ...state.event, commandId: current.command!.commandId },
  };
  const { sql } = store;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${task.projectId},'Project','/repo','[]',${createdAt},${createdAt})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES(${state.threadId},${task.projectId},'Scheduled','model-a',${createdAt},${createdAt},${createdAt})`;
  yield* sql`INSERT INTO provider_turn_deliveries(delivery_id,thread_id,command_id,message_id,state,event_json,created_at,updated_at) VALUES(${state.deliveryId},${state.threadId},${state.commandId},${state.messageId},'pending','{}',${createdAt},${createdAt})`;
  return { service, store, run };
});

it.effect(
  "fences canceled scheduled deliveries before claiming, even with a distinct delivery ID",
  () =>
    Effect.gen(function* () {
      const { store, service, run } = yield* setupScheduledDelivery;
      yield* store.sql`UPDATE scheduled_task_runs SET canceled=1 WHERE id=${run.id}`;
      const worker = yield* ProviderTurnDeliveryWorker;
      yield* worker.start;
      yield* worker.drain;
      const rows = yield* store.sql<{
        state: string;
        certainty: string;
      }>`SELECT state,certainty FROM provider_turn_deliveries WHERE command_id=${state.commandId}`;
      assert.equal(rows[0]!.state, "abandoned");
      assert.equal(rows[0]!.certainty, "not_sent");
      assert.equal(state.attempt, 0);
      yield* service.reconcile;
      assert.equal((yield* store.run(run.id))!.capacity, false);
      assert.equal((yield* store.run(run.id))!.owner, false);
    }).pipe(Effect.provide(testLayer.pipe(Layer.provideMerge(scheduledTestLayer)))),
);

it.effect("wakes a scheduled delivery after its capacity gate opens", () =>
  Effect.gen(function* () {
    const { store } = yield* setupScheduledDelivery;
    acceptSend = true;
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.start;
    yield* worker.drain;
    assert.equal(state.attempt, 0);
    yield* store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
    yield* worker.wakeScheduled!(state.threadId);
    yield* worker.drain;
    assert.equal(state.state, "accepted");
    assert.equal(state.attempt, 1);
  }).pipe(Effect.provide(testLayer.pipe(Layer.provideMerge(scheduledTestLayer)))),
);

it.effect(
  "rechecks scheduled cancellation after asynchronous preparation before provider handoff",
  () =>
    Effect.gen(function* () {
      const { store, run } = yield* setupScheduledDelivery;
      yield* store.sql`UPDATE scheduled_control SET ready=1 WHERE id=1`;
      acceptSend = true;
      unavailableDispatchSnapshot = true;
      beforePrepared = store.sql`UPDATE scheduled_task_runs SET canceled=1 WHERE id=${run.id}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const worker = yield* ProviderTurnDeliveryWorker;
      yield* worker.start;
      yield* worker.drain;
      assert.equal(state.attempt, 1);
      assert.equal(state.state, "rejected");
      assert.equal(state.certainty, "not_sent");
      assert.equal(state.providerTurnId, null);
      assert.deepStrictEqual(acceptedTurnIds, []);
    }).pipe(Effect.provide(testLayer.pipe(Layer.provideMerge(scheduledTestLayer)))),
);

it.effect(
  "ProviderTurnDeliveryWorker keeps uncorrelated history ambiguous beyond the first page",
  () =>
    Effect.gen(function* () {
      resetDelivery();
      providerTurns = Array.from({ length: 51 }, (_, index) => ({
        id: TurnId.makeUnsafe(`turn-${index}`),
        items: [],
      }));
      state = {
        ...state,
        state: "sending",
        preSendTurnIds: providerTurns.slice(0, 50).map((turn) => turn.id),
      };
      const worker = yield* ProviderTurnDeliveryWorker;
      yield* worker.start;
      yield* worker.drain;
      assert.equal(state.state, "ambiguous");
      assert.equal(state.providerTurnId, null);
      assert.equal(requeueCount, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "ProviderTurnDeliveryWorker treats untyped transport failures as ambiguous and replays the durable outcome",
  () =>
    Effect.gen(function* () {
      resetDelivery();
      const worker = yield* ProviderTurnDeliveryWorker;

      const ambiguousBefore = (yield* Metric.value(deliveryAmbiguousTotal)).count;
      const claimScans = Metric.withAttributes(deliveryOutboxRowsDecoded, { source: "claim" });
      const sweepScans = Metric.withAttributes(deliveryOutboxRowsDecoded, { source: "sweep" });
      const claimBefore = yield* Metric.value(claimScans);
      const sweepBefore = yield* Metric.value(sweepScans);

      // First run has no outcome subscriber, modeling a crash after the
      // terminal SQLite update but before the queue observes the PubSub frame.
      yield* worker.start;
      yield* worker.drain;
      assert.equal(state.state, "ambiguous");
      assert.equal(state.certainty, "unknown");
      assert.equal(requeueCount, 0);
      assert.equal(outcomeProjected, false);
      assert.equal((yield* Metric.value(deliveryAmbiguousTotal)).count - ambiguousBefore, 1);
      // The attempt is counted while the provider send is in flight, then released.
      assert.equal(activeAttemptsDuringDelivery, 1);
      assert.equal((yield* Metric.value(deliveryAttemptsActive)).value, 0);
      // The startup sweep and the claim each decode the one pending delivery. The
      // forked safety sweep may also run, but finds nothing pending by then.
      const claimAfter = yield* Metric.value(claimScans);
      const sweepAfter = yield* Metric.value(sweepScans);
      assert.equal(claimAfter.count - claimBefore.count, 1);
      assert.equal(claimAfter.sum - claimBefore.sum, 1);
      assert.isAtLeast(sweepAfter.count - sweepBefore.count, 1);
      assert.equal(sweepAfter.sum - sweepBefore.sum, 1);

      const replayFiber = yield* Effect.forkScoped(Stream.runHead(worker.outcomes));
      yield* Effect.yieldNow;
      yield* worker.start;
      const replay = yield* Fiber.join(replayFiber);
      assert.equal(Option.isSome(replay), true);
      if (Option.isSome(replay)) {
        assert.equal(replay.value.deliveryId, deliveryId);
        assert.equal(replay.value.state, "ambiguous");
      }
      yield* worker.acknowledgeOutcome(deliveryId);
      assert.equal(outcomeProjected, true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "ProviderTurnDeliveryWorker preserves durable evidence when provider history is unavailable",
  () =>
    Effect.gen(function* () {
      resetDelivery();
      state = {
        ...state,
        state: "ambiguous",
        certainty: "unknown",
        errorDetail: "Could not prove whether the provider accepted this turn.",
      };
      providerReadFails = true;
      const worker = yield* ProviderTurnDeliveryWorker;

      const delivery = yield* worker.recheck(threadId);

      assert.equal(delivery?.state, "ambiguous");
      assert.equal(delivery?.certainty, "unknown");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("reconciles acceptance before publishing an outcome that can be acknowledged", () =>
  Effect.gen(function* () {
    resetDelivery();
    acceptSend = true;
    const worker = yield* ProviderTurnDeliveryWorker;
    const outcomeFiber = yield* Effect.forkScoped(
      Stream.runHead(worker.outcomes).pipe(
        Effect.tap(() => Effect.sync(() => assert.equal(pendingBarrier, false))),
      ),
    );
    yield* Effect.yieldNow;
    yield* worker.start;
    yield* worker.drain;
    const outcome = Option.getOrThrow(yield* Fiber.join(outcomeFiber));
    assert.equal(outcome.state, "accepted");
    yield* worker.acknowledgeOutcome(outcome.deliveryId);
    assert.equal(outcomeProjected, true);

    // A restart must repair old accepted outcomes even after acknowledgement.
    pendingBarrier = true;
    reconciliationCount = 0;
    yield* worker.start;
    assert.equal(pendingBarrier, false);
    assert.isAtLeast(reconciliationCount, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("publishes and acknowledges acceptance even when cleanup fails", () =>
  Effect.gen(function* () {
    resetDelivery();
    acceptSend = true;
    reconciliationFails = true;
    const worker = yield* ProviderTurnDeliveryWorker;
    const outcomeFiber = yield* Effect.forkScoped(Stream.runHead(worker.outcomes));
    yield* Effect.yieldNow;
    yield* worker.start;
    yield* worker.drain;
    const outcome = Option.getOrThrow(yield* Fiber.join(outcomeFiber));
    assert.equal(outcome.state, "accepted");
    assert.equal(state.state, "accepted");
    assert.equal(pendingBarrier, true);
    yield* worker.acknowledgeOutcome(outcome.deliveryId);
    assert.equal(outcomeProjected, true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replays later threads even when the first thread cleanup fails", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = { ...state, state: "accepted", providerTurnId: TurnId.makeUnsafe("accepted-turn") };
    reconciliationFails = true;
    extraReplayDelivery = {
      ...state,
      deliveryId: CommandId.makeUnsafe("second-delivery"),
      commandId: CommandId.makeUnsafe("second-command"),
      threadId: ThreadId.makeUnsafe("second-thread"),
    };
    const worker = yield* ProviderTurnDeliveryWorker;
    const outcomesFiber = yield* Effect.forkScoped(
      Stream.runCollect(Stream.take(worker.outcomes, 2)),
    );
    yield* Effect.yieldNow;
    yield* worker.start;
    const outcomes = yield* Fiber.join(outcomesFiber);
    assert.deepEqual(
      Array.from(outcomes, (outcome) => outcome.deliveryId),
      [deliveryId, extraReplayDelivery.deliveryId],
    );
    assert.isAtLeast(reconciliationCount, 3);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not infer acceptance from an unrelated new turn during Recheck", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    reconciliationFails = true;
    providerTurns = [{ id: TurnId.makeUnsafe("rechecked-turn"), items: [] }];
    const worker = yield* ProviderTurnDeliveryWorker;
    const delivery = yield* worker.recheck(threadId);
    assert.equal(delivery?.state, "ambiguous");
    assert.equal(state.state, "ambiguous");
    assert.equal(pendingBarrier, true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a steer disconnected after acceptance is ambiguous and never retried on restart", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = {
      ...state,
      state: "sending",
      event: {
        ...state.event,
        type: "thread.turn-steer-requested",
        payload: { expectedTurnId: TurnId.makeUnsafe("busy-turn") },
      } as never,
    };
    providerTurns = [
      { id: TurnId.makeUnsafe("busy-turn"), items: [] },
      { id: TurnId.makeUnsafe("later-turn"), items: [] },
    ];
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.start;
    yield* worker.drain;
    assert.equal(state.state, "ambiguous");
    assert.equal(requeueCount, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("Codex method-not-found wrapped by provider delivery is a definite steer rejection", () =>
  Effect.gen(function* () {
    resetDelivery();
    methodNotFound = true;
    state = {
      ...state,
      event: {
        ...state.event,
        type: "thread.turn-steer-requested",
        payload: { expectedTurnId: TurnId.makeUnsafe("busy-turn") },
      } as never,
    };
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.start;
    yield* worker.drain;
    assert.equal(state.state, "rejected");
    assert.equal(state.certainty, "not_sent");
    assert.equal(requeueCount, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "persists a definitely-unsent usage rejection before publication and replays it after projection failure",
  () =>
    Effect.gen(function* () {
      resetDelivery();
      usageRejection = {
        windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-01T03:00:00.000Z" }],
        resetsAt: "2026-10-01T03:00:00.000Z",
        resetSource: "provider",
        evidence: "typed",
      };
      failureProjectionFails = true;
      const worker = yield* ProviderTurnDeliveryWorker;
      const publication = yield* worker.outcomes.pipe(
        Stream.take(1),
        Stream.runForEach((outcome) =>
          Effect.sync(() => {
            assert.equal(state.state, "rejected");
            assert.deepEqual(state.usageLimit, outcome.usageLimit);
            assert.equal(outcome.usageLimit?.deliveryId, deliveryId);
            assert.equal(outcome.usageLimit?.turnId, null);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* worker.start;
      yield* worker.drain;
      yield* Fiber.join(publication);
      assert.equal(requeueCount, 0);
      assert.equal(failureProjectionCount, 1);
      assert.equal(state.certainty, "not_sent");
      assert.equal(outcomeProjected, false);
      const replay = yield* Stream.runHead(worker.outcomes).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* worker.start;
      const result = yield* Fiber.join(replay);
      assert.equal(Option.isSome(result), true);
      if (Option.isSome(result)) assert.deepEqual(result.value.usageLimit, state.usageLimit);
      assert.equal(requeueCount, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["turn/start", "account/read"])(
  "only a turn-start request proves a usage rejection is unsent (%s)",
  (method) =>
    Effect.gen(function* () {
      resetDelivery();
      usageRejection = { windows: [], resetsAt: null, resetSource: null, evidence: "typed" };
      usageRequestMethod = method;
      const worker = yield* ProviderTurnDeliveryWorker;
      yield* worker.start;
      yield* worker.drain;
      assert.equal(state.certainty, method === "turn/start" ? "not_sent" : "unknown");
      assert.equal(Boolean(state.usageLimit), method === "turn/start");
      assert.equal(requeueCount, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("Recheck does not claim a turn already attributed to a newer accepted delivery", () =>
  Effect.gen(function* () {
    resetDelivery();
    // The ambiguous send never produced a turn; a later "continue" did.
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    providerTurns = [{ id: TurnId.makeUnsafe("continue-turn"), items: [] }];
    acceptedTurnIds = [TurnId.makeUnsafe("continue-turn")];
    const worker = yield* ProviderTurnDeliveryWorker;
    const delivery = yield* worker.recheck(threadId, deliveryId);
    assert.equal(delivery?.state, "ambiguous");
    assert.equal(state.state, "ambiguous");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("Recheck ignores a target delivery from another thread", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    const worker = yield* ProviderTurnDeliveryWorker;
    const delivery = yield* worker.recheck(ThreadId.makeUnsafe("other-thread"), deliveryId);
    assert.equal(delivery, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a turn start that reports a pre-existing provider turn is not accepted", () =>
  Effect.gen(function* () {
    resetDelivery();
    acceptSend = true;
    providerTurns = [{ id: TurnId.makeUnsafe("existing-turn"), items: [] }];
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.start;
    yield* worker.drain;
    assert.equal(state.state, "ambiguous");
    assert.equal(state.errorCode, "provider_turn_not_new");
    assert.equal(state.providerTurnId, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("Recheck never credits an older delivery with a newer in-flight send's turn", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    // A newer send was claimed before any turn existed; its turn is not yet accepted.
    supersedingPreSendTurnIds = [];
    providerTurns = [{ id: TurnId.makeUnsafe("newer-in-flight-turn"), items: [] }];
    const worker = yield* ProviderTurnDeliveryWorker;
    const delivery = yield* worker.recheck(threadId, deliveryId);
    assert.equal(delivery?.state, "ambiguous");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("Recheck keeps a superseded delivery ambiguous without a correlated receipt", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    supersedingPreSendTurnIds = [TurnId.makeUnsafe("older-turn")];
    providerTurns = [
      { id: TurnId.makeUnsafe("older-turn"), items: [] },
      { id: TurnId.makeUnsafe("newer-turn"), items: [] },
    ];
    const worker = yield* ProviderTurnDeliveryWorker;
    const delivery = yield* worker.recheck(threadId, deliveryId);
    assert.equal(delivery?.state, "ambiguous");
    assert.equal(state.providerTurnId, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("Discard keeps a newer send's pending turn start and fails if abandon lost a race", () =>
  Effect.gen(function* () {
    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    pendingTurnStartMessageId = MessageId.makeUnsafe("newer-message");
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.discard(threadId, deliveryId);
    assert.equal(state.state, "abandoned");
    assert.equal(pendingTurnStartDeletes, 0);

    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    pendingTurnStartMessageId = messageId;
    yield* worker.discard(threadId, deliveryId);
    assert.equal(pendingTurnStartDeletes, 1);

    resetDelivery();
    state = { ...state, state: "ambiguous", certainty: "unknown" };
    pendingTurnStartMessageId = messageId;
    abandonApplies = false;
    const error = yield* worker.discard(threadId, deliveryId).pipe(Effect.flip);
    assert.match(error.message, /can no longer be discarded/u);
    assert.equal(pendingTurnStartDeletes, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("retains the claimed baseline if the final dispatch read is unavailable", () =>
  Effect.gen(function* () {
    resetDelivery();
    providerTurns = [{ id: TurnId.makeUnsafe("existing-turn"), items: [] }];
    acceptSend = true;
    unavailableDispatchSnapshot = true;
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.start;
    yield* worker.drain;
    assert.equal(state.state, "ambiguous");
    assert.deepEqual(state.preSendTurnIds, [TurnId.makeUnsafe("existing-turn")]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a stop fences a claimed start before dispatch intent and never retries it", () =>
  Effect.gen(function* () {
    resetDelivery();
    acceptSend = true;
    unavailableDispatchSnapshot = true;
    supersededByStop = true;
    const worker = yield* ProviderTurnDeliveryWorker;
    yield* worker.start;
    yield* worker.drain;
    assert.equal(state.state, "rejected");
    assert.equal(state.certainty, "not_sent");
    assert.equal(requeueCount, 0);
    assert.include(state.errorDetail!, "stopped before");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["finish", "stop"] as const)(
  "waits for admitted controls before claiming a new turn (%s)",
  (outcome) =>
    Effect.gen(function* () {
      resetDelivery();
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      pendingControl = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      acceptSend = true;
      const worker = yield* ProviderTurnDeliveryWorker;
      yield* worker.start;
      yield* Deferred.await(entered);
      assert.equal(state.state, "pending");
      assert.equal(state.attempt, 0);
      assert.equal(activeAttemptsDuringDelivery, null);
      if (outcome === "stop") state = { ...state, state: "rejected", certainty: "not_sent" };
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain;
      assert.equal(state.state, outcome === "stop" ? "rejected" : "accepted");
      assert.equal(state.attempt, outcome === "stop" ? 0 : 1);
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "shutdown preserves unsent deliveries and fences an admitted preparation before native dispatch",
  () =>
    Effect.gen(function* () {
      resetDelivery();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const admissionStopped = yield* Deferred.make<void>();
      beforePrepared = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      unavailableDispatchSnapshot = true;
      acceptSend = true;
      const shutdown = new ShutdownRegistry();
      shutdown.register({
        name: "test-admission-barrier",
        phase: "flush",
        run: () => Effect.runPromise(Deferred.succeed(admissionStopped, undefined)),
      });
      yield* Effect.gen(function* () {
        const worker = yield* ProviderTurnDeliveryWorker;
        yield* worker.start;
        yield* Deferred.await(entered);
        const closing = shutdown.run();
        yield* Deferred.await(admissionStopped);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.promise(() => closing);
        assert.equal(
          results.every((result) => result.outcome === "complete"),
          true,
        );
        assert.equal(state.state, "pending");
        assert.equal(state.providerTurnId, null);
        assert.equal(requeueCount, 1);
        yield* worker.start;
        yield* worker.drain;
        assert.equal(state.attempt, 1);
      }).pipe(
        Effect.provide(testLayer.pipe(Layer.provide(Layer.succeed(ServerShutdown, shutdown)))),
      );
    }).pipe(Effect.scoped),
);
