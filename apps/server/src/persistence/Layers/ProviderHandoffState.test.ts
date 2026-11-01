import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationEvent,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderTurnDeliveryRepositoryLive } from "../../orchestration/Layers/ProviderTurnDeliveryRepository.ts";
import {
  ProviderTurnDeliveryRepository,
  type DeliveryHandoff,
} from "../../orchestration/Services/ProviderTurnDeliveryRepository.ts";
import {
  ProviderHandoffStateRepository,
  type ParkedNativeSession,
  type PendingProviderHandoff,
} from "../Services/ProviderHandoffState.ts";
import { ProviderHandoffStateRepositoryLive } from "./ProviderHandoffState.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(ProviderHandoffStateRepositoryLive, ProviderTurnDeliveryRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const at = "2026-10-01T00:00:00.000Z";

const pending = (id: string): PendingProviderHandoff => ({
  id,
  mode: "full",
  targetInstanceId: ProviderInstanceId.makeUnsafe("codex"),
  fromProvider: "claudeAgent",
  fromInstanceId: ProviderInstanceId.makeUnsafe("claudeAgent"),
  fromModel: "opus",
  sinceMessageId: null,
  expectedNativeIdentity: null,
  createdAt: at,
});

const parked: ParkedNativeSession = {
  provider: "claudeAgent",
  providerInstanceId: ProviderInstanceId.makeUnsafe("claudeAgent"),
  resumeCursor: { resume: "0b6a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d" },
  nativeIdentity: "0b6a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d",
  cwd: "/repo",
  model: "opus",
  lastSeenMessageId: MessageId.makeUnsafe("a1"),
  estimatedContextTokens: 1_000,
  parkedAt: at,
};

const handoff = (id: string, disposition: DeliveryHandoff["disposition"]): DeliveryHandoff => ({
  id,
  rendererVersion: 1,
  disposition,
  fromProvider: "claudeAgent",
  fromInstanceId: "claudeAgent",
  fromModel: "opus",
  toProvider: "codex",
  toInstanceId: "codex",
  toModel: "gpt-5",
  requestedMode: "full",
  effectiveMode: "full",
  messageIds: ["u1"],
  includedCount: 1,
  omittedCount: 0,
  summaryIncluded: false,
  block: "<f5-context-handoff v1>\n…\n</f5-context-handoff>",
});

const insertClaimedDelivery = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProviderTurnDeliveryRepository;
    const deliveryId = CommandId.makeUnsafe(`${name}-delivery`);
    const messageId = MessageId.makeUnsafe(`${name}-message`);
    const event = Schema.decodeUnknownSync(OrchestrationEvent)({
      sequence: 1,
      eventId: EventId.makeUnsafe(`${name}-event`),
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
    assert.isNotNull(claimed);
    return { deliveryId, attemptId: claimed!.attemptId! };
  });

layer("ProviderHandoffStateRepository", (it) => {
  it.effect("inserts, updates with compare-and-set, rejects conflicts and deletes", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderHandoffStateRepository;
      const threadId = ThreadId.makeUnsafe("cas-thread");
      assert.isNull(yield* repository.get(threadId));
      const inserted = yield* repository.compareAndSet({
        threadId,
        expectedRevision: null,
        pending: pending("h1"),
        parked: { claudeAgent: parked },
      });
      assert.equal(inserted?.revision, 1);
      assert.deepEqual(inserted?.parked.claudeAgent, parked);
      assert.isNull(
        yield* repository.compareAndSet({
          threadId,
          expectedRevision: null,
          pending: null,
          parked: {},
        }),
      );
      const updated = yield* repository.compareAndSet({
        threadId,
        expectedRevision: 1,
        pending: null,
        parked: { claudeAgent: parked },
      });
      assert.equal(updated?.revision, 2);
      assert.isNull(updated?.pending);
      assert.isNull(
        yield* repository.compareAndSet({
          threadId,
          expectedRevision: 1,
          pending: null,
          parked: {},
        }),
      );
      assert.equal((yield* repository.listAll).length, 1);
      yield* repository.deleteByThreadId(threadId);
      assert.isNull(yield* repository.get(threadId));
    }),
  );

  it.effect("drops garbage entries instead of failing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProviderHandoffStateRepository;
      const threadId = ThreadId.makeUnsafe("garbage-thread");
      yield* sql`INSERT INTO provider_handoff_state (thread_id, pending_json, parked_json, revision, updated_at)
        VALUES (${threadId}, ${'{"id":1}'}, ${JSON.stringify({
          claudeAgent: parked,
          codex: { provider: "codex" },
          mismatched: parked,
        })}, 3, ${at})`;
      const state = yield* repository.get(threadId);
      assert.isNull(state?.pending);
      assert.deepEqual(Object.keys(state?.parked ?? {}), ["claudeAgent"]);
      yield* sql`UPDATE provider_handoff_state SET parked_json = 'not json' WHERE thread_id = ${threadId}`;
      assert.deepEqual((yield* repository.get(threadId))?.parked, {});
    }),
  );
});

layer("markAccepted handoff consumption", (it) => {
  it.effect("clears the matching pending marker only for a consumed handoff", () =>
    Effect.gen(function* () {
      const handoffs = yield* ProviderHandoffStateRepository;
      const deliveries = yield* ProviderTurnDeliveryRepository;
      const cases = [
        { name: "consumed", stored: handoff("h1", "consumed"), cleared: true },
        { name: "deferred", stored: handoff("h1", "deferred"), cleared: false },
        { name: "mismatched", stored: handoff("other", "consumed"), cleared: false },
        { name: "missing", stored: null, cleared: false },
      ];
      for (const entry of cases) {
        const threadId = ThreadId.makeUnsafe(`accept-${entry.name}`);
        yield* handoffs.compareAndSet({
          threadId,
          expectedRevision: null,
          pending: pending("h1"),
          parked: {},
        });
        const { deliveryId, attemptId } = yield* insertClaimedDelivery(threadId, entry.name);
        if (entry.stored) {
          const stored = yield* deliveries.recordHandoff({
            deliveryId,
            attemptId,
            handoff: entry.stored,
          });
          assert.deepEqual(stored, entry.stored);
        }
        yield* deliveries.markAccepted({
          deliveryId,
          attemptId,
          providerTurnId: TurnId.makeUnsafe(`${entry.name}-turn`),
        });
        const state = yield* handoffs.get(threadId);
        assert.equal(state?.pending === null, entry.cleared, entry.name);
      }
    }),
  );

  it.effect("keeps the first prepared payload of a delivery and fences stale attempts", () =>
    Effect.gen(function* () {
      const deliveries = yield* ProviderTurnDeliveryRepository;
      const threadId = ThreadId.makeUnsafe("reuse-thread");
      const { deliveryId, attemptId } = yield* insertClaimedDelivery(threadId, "reuse");
      const first = handoff("h1", "consumed");
      yield* deliveries.recordHandoff({ deliveryId, attemptId, handoff: first });
      const second = yield* deliveries.recordHandoff({
        deliveryId,
        attemptId,
        handoff: { ...first, block: "different" },
      });
      assert.deepEqual(second, first);
      assert.isNull(
        yield* deliveries.recordHandoff({ deliveryId, attemptId: "stale", handoff: first }),
      );
      assert.deepEqual((yield* deliveries.getByCommandId(deliveryId))?.handoff, first);
    }),
  );

  it.effect("retains only the newest settled handoff bodies per thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const deliveries = yield* ProviderTurnDeliveryRepository;
      const threadId = ThreadId.makeUnsafe("retention-thread");
      const settled = (index: number, state: string) =>
        sql`INSERT INTO provider_turn_deliveries (delivery_id, thread_id, command_id, message_id, state, event_json, handoff_json, reservation_released_at, created_at, updated_at)
          VALUES (${`old-${index}`}, ${threadId}, ${`old-${index}`}, ${`old-message-${index}`}, ${state}, '{}',
            ${JSON.stringify(handoff(`old-${index}`, "consumed"))}, ${at}, ${at},
            ${`2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`})`;
      for (let index = 0; index < 22; index += 1) yield* settled(index, "accepted");
      yield* settled(22, "ambiguous");
      const { deliveryId, attemptId } = yield* insertClaimedDelivery(threadId, "retention");
      yield* deliveries.recordHandoff({ deliveryId, attemptId, handoff: handoff("h", "consumed") });
      yield* deliveries.markAccepted({
        deliveryId,
        attemptId,
        providerTurnId: TurnId.makeUnsafe("retention-turn"),
      });
      const rows = yield* sql<{ id: string; state: string; hasBody: number }>`
        SELECT delivery_id AS "id", state, json_extract(handoff_json, '$.block') IS NOT NULL AS "hasBody"
        FROM provider_turn_deliveries WHERE thread_id = ${threadId}`;
      assert.equal(rows.filter((row) => row.state === "accepted" && row.hasBody).length, 20);
      // The newest delivery keeps its body; an ambiguous one is never cleared.
      assert.isTrue(rows.some((row) => row.id === deliveryId && row.hasBody));
      assert.isTrue(rows.some((row) => row.state === "ambiguous" && row.hasBody));
      assert.equal(rows.filter((row) => row.state === "accepted" && !row.hasBody).length, 3);
    }),
  );
});
