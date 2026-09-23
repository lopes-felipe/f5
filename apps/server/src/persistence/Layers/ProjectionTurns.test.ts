import { MessageId, OrchestrationProposedPlanId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const at = "2026-01-01T00:00:00.000Z";

layer("accepted pending turn reconciliation", (it) => {
  for (const terminal of [false, true]) {
    it.effect(
      `clears accepted feedback without changing its ${terminal ? "completed" : "running"} turn`,
      () =>
        Effect.gen(function* () {
          const turns = yield* ProjectionTurnRepository;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.makeUnsafe(`feedback-${terminal}`);
          const turnId = TurnId.makeUnsafe(`turn-${terminal}`);
          const messageId = MessageId.makeUnsafe(`feedback-message-${terminal}`);
          const original = {
            threadId,
            turnId,
            pendingMessageId: MessageId.makeUnsafe("original-message"),
            assistantMessageId: MessageId.makeUnsafe("assistant-message"),
            state: terminal ? ("completed" as const) : ("running" as const),
            requestedAt: at,
            startedAt: at,
            completedAt: terminal ? at : null,
            processingQuiescedAt: terminal ? at : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          };
          yield* turns.upsertByTurnId(original);
          yield* turns.replacePendingTurnStart({
            threadId,
            messageId,
            requestedAt: at,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
          });
          yield* sql`INSERT INTO provider_turn_deliveries
          (delivery_id, thread_id, command_id, message_id, state, provider_turn_id,
           event_json, created_at, updated_at, outcome_projected_at)
          VALUES (${threadId}, ${threadId}, ${threadId}, ${messageId}, 'accepted', ${turnId}, '{}', ${at}, ${at}, ${at})`;

          // Already acknowledged outcomes must still be repaired at startup.
          yield* turns.reconcileAllAcceptedPendingTurnStarts;
          yield* turns.reconcileAcceptedPendingTurnStarts({ threadId });
          assert.equal(
            Option.isNone(yield* turns.getPendingTurnStartByThreadId({ threadId })),
            true,
          );
          assert.deepEqual(
            Option.getOrThrow(yield* turns.getByTurnId({ threadId, turnId })),
            original,
          );

          // A later pending request must survive a replay of the earlier acceptance.
          const newerMessageId = MessageId.makeUnsafe(`newer-${terminal}`);
          yield* turns.replacePendingTurnStart({
            threadId,
            messageId: newerMessageId,
            requestedAt: at,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
          });
          yield* turns.reconcileAcceptedPendingTurnStarts({ threadId });
          assert.equal(
            Option.getOrThrow(yield* turns.getPendingTurnStartByThreadId({ threadId })).messageId,
            newerMessageId,
          );
        }),
    );
  }

  it.effect("waits for the accepted turn to exist in the same thread", () =>
    Effect.gen(function* () {
      const turns = yield* ProjectionTurnRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("acceptance-before-projection");
      const otherThreadId = ThreadId.makeUnsafe("other-thread");
      const turnId = TurnId.makeUnsafe("delayed-turn");
      const messageId = MessageId.makeUnsafe("delayed-message");
      yield* turns.replacePendingTurnStart({
        threadId,
        messageId,
        requestedAt: at,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
      });
      yield* sql`INSERT INTO provider_turn_deliveries
        (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
        VALUES (${threadId}, ${threadId}, ${threadId}, ${messageId}, 'accepted', ${turnId}, '{}', ${at}, ${at})`;
      const turn = {
        threadId: otherThreadId,
        turnId,
        pendingMessageId: messageId,
        assistantMessageId: null,
        state: "running" as const,
        requestedAt: at,
        startedAt: at,
        completedAt: null,
        processingQuiescedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      };
      yield* turns.upsertByTurnId(turn);
      yield* turns.reconcileAcceptedPendingTurnStarts({ threadId });
      assert.equal(Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId })), true);
      yield* turns.upsertByTurnId({ ...turn, threadId });
      yield* turns.reconcileAcceptedPendingTurnStarts({ threadId: otherThreadId });
      assert.equal(Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId })), true);
      yield* turns.reconcileAcceptedPendingTurnStarts({ threadId });
      assert.equal(Option.isNone(yield* turns.getPendingTurnStartByThreadId({ threadId })), true);
    }),
  );

  for (const state of ["interrupted", "completed"] as const) {
    it.effect(
      `retains pending metadata until the early ${state} turn has a message association`,
      () =>
        Effect.gen(function* () {
          const turns = yield* ProjectionTurnRepository;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.makeUnsafe(`early-${state}`);
          const turnId = TurnId.makeUnsafe(`early-turn-${state}`);
          const messageId = MessageId.makeUnsafe(`early-message-${state}`);
          const pending = {
            threadId,
            messageId,
            requestedAt: at,
            sourceProposedPlanThreadId: ThreadId.makeUnsafe("source-thread"),
            sourceProposedPlanId: OrchestrationProposedPlanId.makeUnsafe("source-plan"),
          };
          yield* turns.replacePendingTurnStart(pending);
          const turn = {
            threadId,
            turnId,
            pendingMessageId: null,
            assistantMessageId: null,
            state,
            requestedAt: at,
            startedAt: at,
            completedAt: at,
            processingQuiescedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          };
          yield* turns.upsertByTurnId(turn);
          yield* sql`INSERT INTO provider_turn_deliveries
          (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
          VALUES (${threadId}, ${threadId}, ${threadId}, ${messageId}, 'accepted', ${turnId}, '{}', ${at}, ${at})`;
          yield* turns.reconcileAllAcceptedPendingTurnStarts;
          yield* turns.reconcileAcceptedPendingTurnStarts({ threadId });
          assert.deepEqual(
            Option.getOrThrow(yield* turns.getPendingTurnStartByThreadId({ threadId })),
            pending,
          );
          yield* turns.upsertByTurnId({ ...turn, pendingMessageId: messageId });
          yield* turns.reconcileAcceptedPendingTurnStarts({ threadId });
          assert.equal(
            Option.isNone(yield* turns.getPendingTurnStartByThreadId({ threadId })),
            true,
          );
        }),
    );
  }

  for (const state of ["pending", "sending", "rejected", "ambiguous", "abandoned"]) {
    it.effect(`preserves a pending message with ${state} delivery`, () =>
      Effect.gen(function* () {
        const turns = yield* ProjectionTurnRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe(`unresolved-${state}`);
        const turnId = TurnId.makeUnsafe(`unresolved-turn-${state}`);
        const messageId = MessageId.makeUnsafe(`unresolved-message-${state}`);
        yield* turns.upsertByTurnId({
          threadId,
          turnId,
          pendingMessageId: messageId,
          assistantMessageId: null,
          state: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          processingQuiescedAt: at,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        yield* turns.replacePendingTurnStart({
          threadId,
          messageId,
          requestedAt: at,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
        });
        yield* sql`INSERT INTO provider_turn_deliveries
          (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
          VALUES (${threadId}, ${threadId}, ${threadId}, ${messageId}, ${state}, ${turnId}, '{}', ${at}, ${at})`;
        yield* turns.reconcileAllAcceptedPendingTurnStarts;
        assert.equal(Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId })), true);
      }),
    );
  }
});
