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
  for (const pendingMessageId of [null, MessageId.makeUnsafe("original-boundary")]) {
    it.effect(
      `lists a retried delivery boundary with ${pendingMessageId ? "existing" : "missing"} pending metadata`,
      () =>
        Effect.gen(function* () {
          const turns = yield* ProjectionTurnRepository;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.makeUnsafe(`retry-boundary-${pendingMessageId}`);
          const turnId = TurnId.makeUnsafe("retried-turn");
          yield* turns.upsertByTurnId({
            threadId,
            turnId,
            pendingMessageId,
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
          // Neither an unresolved delivery, an accepted steer, nor another thread
          // may supply (or multiply) this turn's conversation boundary.
          for (const [id, state, owner, type] of [
            ["unresolved", "ambiguous", threadId, "thread.turn-start-requested"],
            ["other", "accepted", "other-thread", "thread.turn-start-requested"],
            ["steer", "accepted", threadId, "thread.turn-steer-requested"],
            ["retry", "accepted", threadId, "thread.turn-start-requested"],
          ]) {
            yield* sql`INSERT INTO provider_turn_deliveries
            (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
            VALUES (${`${threadId}-${id}`}, ${owner}, ${`${threadId}-${id}`}, ${id}, ${state}, ${turnId}, ${JSON.stringify({ type })}, ${at}, ${at})`;
          }
          const listed = yield* turns.listByThreadId({ threadId });
          assert.equal(listed.length, 1);
          assert.equal(listed[0]!.pendingMessageId, pendingMessageId ?? "retry");
          assert.equal(
            Option.getOrThrow(yield* turns.getByTurnId({ threadId, turnId })).pendingMessageId,
            pendingMessageId ?? "retry",
          );
          assert.equal(
            Option.getOrThrow(yield* turns.getLatestTerminalByThreadId({ threadId }))
              .pendingMessageId,
            pendingMessageId ?? "retry",
          );
          // All read APIs agree without mutating historical records.
          assert.equal(
            (yield* sql<{
              messageId: string | null;
            }>`SELECT pending_message_id AS "messageId" FROM projection_turns WHERE thread_id = ${threadId}`)[0]!
              .messageId,
            pendingMessageId,
          );
        }),
    );
  }

  it.effect("uses the turn boundary index for an accepted-delivery fallback", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT message_id FROM provider_turn_deliveries
      WHERE thread_id = 'thread' AND provider_turn_id = 'turn' AND state = 'accepted'
        AND json_extract(event_json, '$.type') IS NOT 'thread.turn-steer-requested'
      ORDER BY created_at, rowid LIMIT 1`;
      assert.equal(
        plan.some((row) => row.detail.includes("idx_provider_turn_deliveries_boundary")),
        true,
      );
      assert.equal(
        plan.some((row) => row.detail.includes("TEMP B-TREE")),
        false,
      );
    }),
  );

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
