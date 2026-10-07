import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationEvent,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationUsageLimit,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";
import { ProviderTurnDeliveryRepositoryLive } from "./ProviderTurnDeliveryRepository.ts";

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
