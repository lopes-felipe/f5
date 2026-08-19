import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

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

const deliveryId = CommandId.makeUnsafe("delivery-unknown-outcome");
const commandId = CommandId.makeUnsafe("command-unknown-outcome");
const threadId = ThreadId.makeUnsafe("thread-unknown-outcome");
const messageId = MessageId.makeUnsafe("message-unknown-outcome");
const createdAt = "2026-01-01T00:00:00.000Z";

let state: ProviderTurnDelivery;
let requeueCount = 0;
let outcomeProjected = false;
let providerReadFails = false;

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
  requeueCount = 0;
  outcomeProjected = false;
  providerReadFails = false;
}

const repositoryLayer = Layer.succeed(ProviderTurnDeliveryRepository, {
  listActionable: Effect.sync(() => (state.state === "pending" ? [state] : [])),
  listSending: Effect.sync(() => (state.state === "sending" ? [state] : [])),
  listUnprojectedTerminal: Effect.sync(() =>
    (state.state === "accepted" || state.state === "rejected" || state.state === "ambiguous") &&
    !outcomeProjected
      ? [state]
      : [],
  ),
  getByCommandId: () => Effect.succeed(state),
  getLatestByThread: () => Effect.succeed(state),
  getUnresolvedByThread: () => Effect.succeed(state),
  claim: (_deliveryId: CommandId, preSendTurnIds: ReadonlyArray<never>) =>
    Effect.sync(() => {
      if (state.state !== "pending") return null;
      state = {
        ...state,
        state: "sending",
        attempt: state.attempt + 1,
        preSendTurnIds,
      };
      return state;
    }),
  markAccepted: () => Effect.void,
  markRejected: (input: {
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
  }) =>
    Effect.sync(() => {
      state = {
        ...state,
        state: input.ambiguous ? "ambiguous" : "rejected",
        errorCode: input.errorCode,
        errorDetail: input.errorDetail,
        certainty: input.certainty,
      };
    }),
  requeue: () =>
    Effect.sync(() => {
      requeueCount += 1;
      state = { ...state, state: "pending" };
    }),
  retryTerminal: () => Effect.succeed(null),
  markAbandoned: () => Effect.void,
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
          : Effect.succeed({ threadId, turns: [] }),
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(ProviderCommandReactor, {
      deliverTurnStart: () => Effect.fail(new Error("session not found after request write")),
      recordTurnStartFailure: () => Effect.void,
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(ProjectionTurnRepository, {
      deletePendingTurnStartByThreadId: () => Effect.void,
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(OrchestrationEngineService, {
      streamDomainEvents: Stream.empty,
    } as never),
  ),
);

it.effect(
  "ProviderTurnDeliveryWorker treats untyped transport failures as ambiguous and replays the durable outcome",
  () =>
    Effect.gen(function* () {
      resetDelivery();
      const worker = yield* ProviderTurnDeliveryWorker;

      // First run has no outcome subscriber, modeling a crash after the
      // terminal SQLite update but before the queue observes the PubSub frame.
      yield* worker.start;
      yield* worker.drain;
      assert.equal(state.state, "ambiguous");
      assert.equal(state.certainty, "unknown");
      assert.equal(requeueCount, 0);
      assert.equal(outcomeProjected, false);

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
