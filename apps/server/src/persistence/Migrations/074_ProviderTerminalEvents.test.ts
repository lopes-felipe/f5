import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import { ProviderTerminalEventRepositoryLive } from "../Layers/ProviderTerminalEvents.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { ProviderTerminalEventRepository } from "../Services/ProviderTerminalEvents.ts";
import Migration0074 from "./074_ProviderTerminalEvents.ts";

it.layer(SqliteClient.layerMemory())("074_ProviderTerminalEvents migration", (it) => {
  it.effect("creates the durable terminal receipt table idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0074;
      yield* Migration0074;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_terminal_events'
      `;
      assert.deepStrictEqual(tables, [{ name: "provider_terminal_events" }]);
    }),
  );
});

const repositoryLayer = ProviderTerminalEventRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.layer(repositoryLayer)("ProviderTerminalEventRepository", (it) => {
  it.effect("records, retries, and applies terminal events idempotently", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderTerminalEventRepository;
      const event = {
        type: "turn.completed",
        eventId: EventId.makeUnsafe("event-terminal-receipt"),
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-terminal-receipt"),
        turnId: TurnId.makeUnsafe("turn-terminal-receipt"),
        createdAt: "2026-08-18T08:00:00.000Z",
        payload: { state: "completed" },
      } as const;

      yield* repository.record(event);
      yield* repository.record(event);
      yield* repository.markFailed({ eventId: event.eventId, error: "projection failed" });
      const pending = yield* repository.listPending;
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.attempt, 1);
      assert.equal(pending[0]?.lastError, "projection failed");
      assert.deepStrictEqual(pending[0]?.event, event);

      yield* repository.markApplied(event.eventId);
      yield* repository.markApplied(event.eventId);
      assert.deepStrictEqual(yield* repository.listPending, []);
    }),
  );
});
