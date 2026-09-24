import { CommandId, EventId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("replays 20,000 events across pages and keeps ordinary reads bounded", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const baseline = yield* sql<{
        sequence: number;
      }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`;
      const cursor = baseline[0]!.sequence;
      const timestamp = "2026-09-24T00:00:00.000Z";
      yield* sql`
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 20000)
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        SELECT 'paging-' || n, 'project', 'paging-project', n, 'project.created', ${timestamp},
          NULL, NULL, NULL, 'server', ${JSON.stringify({
            projectId: "paging-project",
            title: "Paging",
            workspaceRoot: "/tmp/paging",
            defaultModel: null,
            scripts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          })}, '{}'
        FROM numbers
      `;
      const bounded = yield* Stream.runCollect(eventStore.readFromSequence(cursor));
      assert.equal(bounded.length, 1000);
      let count = 0;
      yield* Stream.runForEach(
        eventStore.readFromSequence(cursor, Number.MAX_SAFE_INTEGER),
        (event) =>
          Effect.sync(() => {
            count++;
            assert.equal(event.sequence, cursor + count);
            assert.equal(event.eventId, `paging-${count}`);
          }),
      );
      assert.equal(count, 20000);
      const partial = yield* Stream.runCollect(eventStore.readFromSequence(cursor, 1501));
      assert.equal(partial.length, 1501);
      const empty = yield* Stream.runCollect(eventStore.readFromSequence(cursor, 0));
      assert.equal(empty.length, 0);
      yield* sql`DELETE FROM orchestration_events WHERE event_id LIKE 'paging-%'`;
    }),
  );

  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("round-trips every field of a usage-recorded event", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const completedAt = "2026-08-18T08:00:00.000Z";
      const eventId = EventId.makeUnsafe("evt-store-usage-recorded");
      const threadId = ThreadId.makeUnsafe("thread-store-usage-recorded");
      const turnId = TurnId.makeUnsafe("turn-store-usage-recorded");
      const appended = yield* eventStore.append({
        type: "thread.usage-recorded",
        eventId,
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: completedAt,
        commandId: CommandId.makeUnsafe("cmd-store-usage-recorded"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-usage-recorded"),
        metadata: {},
        payload: {
          threadId,
          usageFact: {
            turnId,
            threadId,
            projectId: ProjectId.makeUnsafe("project-store-usage-recorded"),
            provider: "codex",
            providerInstanceId: null,
            model: "gpt-5.6-sol",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            totalTokens: 18,
            providerReportedCostUsd: 0.1,
            tokenProvenance: "provider-reported",
            costProvenance: "provider-reported",
            completedAt,
            sourceEventId: "provider-event-usage-recorded",
          },
        },
      });

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(appended.sequence - 1, 1),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.deepStrictEqual(replayed, [appended]);
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("replays legacy project-created events without default model fields", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const baselineRows = yield* sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence
        FROM orchestration_events
      `;
      const baselineSequence = baselineRows[0]?.sequence ?? 0;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-project-created")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-legacy-project-created")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-project-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            projectId: "project-legacy-project-created",
            title: "Legacy Project",
            workspaceRoot: "/tmp/legacy-project",
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(baselineSequence, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));

      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      if (replayed[0]?.type === "project.created") {
        assert.equal(replayed[0].payload.defaultModel, null);
        assert.equal(replayed[0].payload.defaultModelSelection, null);
      }
    }),
  );

  it.effect("collects command ids and deletes a purged thread stream", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-storage-purge");
      const commandId = CommandId.makeUnsafe("cmd-storage-purge");
      const now = new Date().toISOString();
      const baselineRows = yield* sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence
        FROM orchestration_events
      `;
      const baselineSequence = baselineRows[0]?.sequence ?? 0;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-storage-purge")},
          ${"thread"},
          ${threadId},
          ${0},
          ${"thread.created"},
          ${now},
          ${commandId},
          ${null},
          ${commandId},
          ${"user"},
          ${"{}"},
          ${"{}"}
        )
      `;

      assert.ok(eventStore.collectCommandIdsForThread);
      assert.ok(eventStore.deleteForThreadStream);
      const commandIds = yield* eventStore.collectCommandIdsForThread(threadId);
      assert.deepEqual(commandIds, [commandId]);

      yield* eventStore.deleteForThreadStream(threadId);
      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(baselineSequence, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(replayed.length, 0);
    }),
  );
});
