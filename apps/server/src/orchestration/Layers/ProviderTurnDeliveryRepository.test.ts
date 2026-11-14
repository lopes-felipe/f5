import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationEvent,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationUsageLimit,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";
import {
  LIST_CANDIDATE_IDS_SQL,
  ProviderTurnDeliveryRepositoryLive,
} from "./ProviderTurnDeliveryRepository.ts";

const layer = it.layer(
  ProviderTurnDeliveryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
layer("durable usage-limit delivery rejection", (it) => {
  it.effect(
    "round-trips reset evidence through rejection and unprojected replay; retry clears it",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProviderTurnDeliveryRepository;
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-10-01T00:00:00.000Z";
        const threadId = ThreadId.makeUnsafe("unsent-limit-thread");
        const deliveryId = CommandId.makeUnsafe("unsent-limit-delivery");
        const messageId = MessageId.makeUnsafe("unsent-limit-message");
        const event = Schema.decodeUnknownSync(OrchestrationEvent)({
          sequence: 1,
          eventId: EventId.makeUnsafe("unsent-limit-event"),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.turn-start-requested",
          occurredAt: at,
          commandId: deliveryId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId, messageId, createdAt: at },
        });
        yield* sql`INSERT INTO provider_turn_deliveries (delivery_id, thread_id, command_id, message_id, state, event_json, created_at, updated_at)
      VALUES (${deliveryId}, ${threadId}, ${deliveryId}, ${messageId}, 'pending', ${JSON.stringify(event)}, ${at}, ${at})`;
        const claimed = yield* repository.claim(deliveryId, []);
        assert.equal(claimed?.state, "sending");
        const usageLimit: OrchestrationUsageLimit = {
          windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-01T03:00:00.000Z" }],
          resetsAt: "2026-10-01T03:00:00.000Z",
          resetSource: "provider",
          evidence: "typed",
          providerInstanceId: ProviderInstanceId.makeUnsafe("claude-instance"),
          turnId: null,
          deliveryId,
        };
        yield* repository.markRejected({
          deliveryId,
          errorCode: "usage_limit",
          errorDetail: "Limit reached",
          certainty: "not_sent",
          ambiguous: false,
          usageLimit,
        });
        const replay = yield* repository.listUnprojectedTerminal;
        assert.equal(replay.length, 1);
        assert.deepEqual(replay[0]?.usageLimit, usageLimit);
        assert.deepEqual((yield* repository.getByCommandId(deliveryId))?.usageLimit, usageLimit);
        assert.deepEqual((yield* repository.getLatestByThread(threadId))?.usageLimit, usageLimit);
        yield* repository.markOutcomeProjected(deliveryId);
        assert.equal((yield* repository.listUnprojectedTerminal).length, 0);
        const retried = yield* repository.retryTerminal({
          deliveryId,
          allowPossibleDuplicate: false,
        });
        assert.equal(retried?.state, "pending");
        assert.equal(retried?.usageLimit, null);
      }),
  );
});

layer("delivery-scoped recovery lookups", (it) => {
  it.effect("bounds a superseded delivery by the newer send and reports abandon races", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderTurnDeliveryRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("superseded-lookup-thread");
      const insert = (input: {
        readonly id: string;
        readonly state: string;
        readonly attempt: number;
        readonly preSend: ReadonlyArray<string>;
        readonly at: string;
      }) =>
        sql`INSERT INTO provider_turn_deliveries (delivery_id, thread_id, command_id, message_id, state, attempt, pre_send_turn_ids_json, event_json, created_at, updated_at)
          VALUES (${input.id}, ${threadId}, ${input.id}, ${`${input.id}-message`}, ${input.state}, ${input.attempt}, ${JSON.stringify(input.preSend)}, '{}', ${input.at}, ${input.at})`;
      yield* insert({
        id: "older-ambiguous",
        state: "ambiguous",
        attempt: 1,
        preSend: ["t1"],
        at: "2026-10-07T09:38:00.000Z",
      });
      const older = CommandId.makeUnsafe("older-ambiguous");
      assert.equal(yield* repository.getSupersedingPreSendTurnIds(older), null);

      // A newer delivery that was never claimed cannot own a turn yet.
      yield* insert({
        id: "newer-unclaimed",
        state: "pending",
        attempt: 0,
        preSend: [],
        at: "2026-10-07T09:50:00.000Z",
      });
      assert.equal(yield* repository.getSupersedingPreSendTurnIds(older), null);

      yield* insert({
        id: "newer-continue",
        state: "accepted",
        attempt: 1,
        preSend: ["t1", "t2"],
        at: "2026-10-07T09:53:00.000Z",
      });
      assert.deepEqual(yield* repository.getSupersedingPreSendTurnIds(older), [
        TurnId.makeUnsafe("t1"),
        TurnId.makeUnsafe("t2"),
      ]);

      assert.equal(yield* repository.markAbandoned(older), true);
      assert.equal(yield* repository.markAbandoned(older), false);
    }),
  );
});

layer("bounded delivery ownership", (it) => {
  const insert = (id: string, thread: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-01-01T00:00:00.000Z";
      const event = {
        sequence: 1,
        eventId: EventId.makeUnsafe(`event:${id}`),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe(thread),
        type: "thread.turn-start-requested",
        occurredAt: at,
        commandId: CommandId.makeUnsafe(id),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe(thread),
          messageId: MessageId.makeUnsafe(`message:${id}`),
          createdAt: at,
        },
      };
      yield* sql`INSERT INTO provider_turn_deliveries (delivery_id, thread_id, command_id, message_id, state, event_json, created_at, updated_at)
      VALUES (${id}, ${thread}, ${id}, ${`message:${id}`}, 'pending', ${JSON.stringify(event)}, ${at}, ${at})`;
      return CommandId.makeUnsafe(id);
    });
  it.effect("bounds id pages, rotates past busy oldest threads and keeps claims exclusive", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderTurnDeliveryRepository;
      for (let i = 0; i < 80; i++) {
        const thread = `bounded-${String(i).padStart(3, "0")}`;
        const id = yield* insert(`${thread}:first`, thread);
        if (i < 10) {
          yield* insert(`${thread}:second`, thread);
          yield* repository.claim(id, []);
        }
      }
      const page = yield* repository.listCandidateIds({ afterThreadId: "bounded-", limit: 1000 });
      assert.equal(page.length, 64);
      assert.equal(new Set(page.map((row) => row.threadId)).size, 64);
      assert.equal(page[0]!.threadId, "bounded-010");
      const tail = yield* repository.listCandidateIds({
        afterThreadId: page.at(-1)!.threadId,
        limit: 64,
      });
      assert.equal(tail.length, 6);
      const claims = yield* Effect.all(
        [repository.claim(page[0]!.deliveryId, []), repository.claim(page[0]!.deliveryId, [])],
        { concurrency: 2 },
      );
      assert.equal(claims.filter(Boolean).length, 1);
    }),
  );
  it.effect(
    "rejects obsolete acceptance receipts and retains accepted ownership until terminal evidence",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProviderTurnDeliveryRepository;
        const sql = yield* SqlClient.SqlClient;
        const id = yield* insert("receipt:first", "receipt-thread");
        const first = yield* repository.claim(id, []);
        yield* repository.markRejected({
          deliveryId: id,
          attemptId: first!.attemptId,
          errorCode: "unknown",
          errorDetail: "unknown",
          certainty: "unknown",
          ambiguous: true,
        });
        yield* repository.retryTerminal({ deliveryId: id, allowPossibleDuplicate: true });
        const next = yield* repository.claim(id, []);
        assert.notEqual(first!.attemptId, next!.attemptId);
        assert.equal(
          yield* repository.markAccepted({
            deliveryId: id,
            attemptId: first!.attemptId,
            providerTurnId: TurnId.makeUnsafe("obsolete"),
          }),
          false,
        );
        const receipt = {
          turnId: TurnId.makeUnsafe("accepted-turn"),
          attemptId: next!.attemptId!,
          runtimeGeneration: 2,
          nativeHistoryIdentity: "native-session",
          acceptedAt: new Date().toISOString(),
        };
        assert.equal(
          yield* repository.markAccepted({
            deliveryId: id,
            attemptId: next!.attemptId,
            providerTurnId: receipt.turnId,
            receipt,
          }),
          true,
        );
        assert.deepEqual((yield* repository.getByCommandId(id))?.acceptanceReceipt, receipt);
        const following = yield* insert("receipt:next", "receipt-thread");
        assert.equal(yield* repository.claim(following, []), null);
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
      VALUES ('receipt-thread', 'accepted-turn', 'completed', '2026-01-01', '2026-01-02', '[]')`;
        assert.equal((yield* repository.claim(following, []))?.state, "sending");
      }),
  );
  it.effect("sweeps candidates from the pending-only index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${LIST_CANDIDATE_IDS_SQL}`,
        ["", 64],
      );
      const candidate = plan.find((row) => / candidate /.test(row.detail));
      assert.include(candidate?.detail, "idx_provider_turn_deliveries_pending_thread");
      // The page is ordered by the index, never sorted afterwards.
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
    }),
  );
});
