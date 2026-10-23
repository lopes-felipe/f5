import { MAX_TERMINAL_RECEIPT_ATTEMPTS } from "../Services/ProviderTerminalEvents.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";
import { ProviderTerminalEventRepositoryLive } from "../Layers/ProviderTerminalEvents.ts";
import {
  SqlitePersistenceMemory,
  makeRuntimeSqliteLayer,
  makeSqlitePersistenceLive,
} from "../Layers/Sqlite.ts";
import { LATEST_MIGRATION_ID, MIGRATIONS } from "../Migrations.ts";
import { ProviderTerminalEventRepository } from "../Services/ProviderTerminalEvents.ts";
import createLegacyReceipts from "./074_ProviderTerminalEvents.ts";
import addRetry from "./124_ProviderTerminalRetry.ts";
import addIndexes from "./125_ProviderTerminalRetryIndexes.ts";

it("upgrades an existing file database and reopens it with the preceding migration catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "f5-terminal-migration-"));
  const filename = join(directory, "state.sqlite");
  const legacyLoader = Migrator.fromRecord(
    Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([name]) => Number.parseInt(name, 10) <= 123),
    ),
  );
  const runLegacy = Migrator.make({})({ loader: legacyLoader });
  try {
    const legacy = ManagedRuntime.make(makeRuntimeSqliteLayer({ filename }));
    try {
      await legacy.runPromise(
        Effect.gen(function* () {
          yield* runLegacy;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO provider_terminal_events(event_id, thread_id, turn_id, event_type, event_json, received_at, attempt) VALUES ('file-legacy', 'thread', 'turn', 'turn.completed', '{}', '2026-10-01', 2)`;
          const interrupted = yield* sql
            .withTransaction(addRetry.pipe(Effect.andThen(Effect.fail("interrupted"))))
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(interrupted));
        }),
      );
    } finally {
      await legacy.dispose();
    }
    const upgraded = ManagedRuntime.make(
      makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer)),
    );
    try {
      await upgraded.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows =
            yield* sql`SELECT event_id, attempt, origin_session_generation, next_due_at FROM provider_terminal_events`;
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.event_id, "file-legacy");
          assert.equal(rows[0]!.attempt, 2);
          assert.isNull(rows[0]!.origin_session_generation);
          assert.isString(rows[0]!.next_due_at);
          const applied = yield* sql<{
            id: number;
          }>`SELECT migration_id AS id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1`;
          assert.equal(applied[0]?.id, LATEST_MIGRATION_ID);
          const indexes = yield* sql<{
            name: string;
            sql: string;
          }>`SELECT name, sql FROM sqlite_master WHERE name IN ('provider_terminal_events_retry_age', 'provider_terminal_events_exhausted')`;
          assert.equal(indexes.length, 2);
          for (const index of indexes) {
            const expected = index.name.endsWith("exhausted") ? ">=" : "<";
            assert.include(index.sql, `attempt ${expected} ${MAX_TERMINAL_RECEIPT_ATTEMPTS}`);
          }
        }),
      );
    } finally {
      await upgraded.dispose();
    }
    const reopened = ManagedRuntime.make(makeRuntimeSqliteLayer({ filename }));
    try {
      await reopened.runPromise(
        Effect.gen(function* () {
          // The preceding beta's catalog is unaware of 124–126. Its migration
          // runner and its explicit-column receipt reads/writes must still work.
          yield* runLegacy;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE provider_terminal_events SET attempt = attempt + 1, last_error = 'legacy retry' WHERE event_id = 'file-legacy'`;
          assert.deepStrictEqual(
            yield* sql`SELECT event_id, attempt, last_error FROM provider_terminal_events`,
            [{ event_id: "file-legacy", attempt: 3, last_error: "legacy retry" }],
          );
        }),
      );
    } finally {
      await reopened.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.layer(makeRuntimeSqliteLayer({ filename: ":memory:" }))("terminal retry migration", (it) => {
  it.effect("rolls back interrupted upgrades and preserves the legacy read contract", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createLegacyReceipts;
      yield* sql`INSERT INTO provider_terminal_events(event_id, thread_id, turn_id, event_type, event_json, received_at, attempt) VALUES ('legacy', 'thread', 'turn', 'turn.completed', '{}', '2026-10-01', 0)`;
      const interrupted = yield* sql
        .withTransaction(addRetry.pipe(Effect.andThen(Effect.fail("interrupted"))))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(interrupted));
      const before = yield* sql<{ name: string }>`PRAGMA table_info(provider_terminal_events)`;
      assert.isFalse(before.some((column) => column.name === "next_due_at"));
      yield* sql.withTransaction(addRetry.pipe(Effect.andThen(addIndexes)));
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, attempt, last_error FROM provider_terminal_events`,
        [{ event_id: "legacy", attempt: 0, last_error: null }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT origin_session_generation, origin_turn_id FROM provider_terminal_events`,
        [{ origin_session_generation: null, origin_turn_id: null }],
      );
      const indexes = yield* sql<{ name: string }>`PRAGMA index_list(provider_terminal_events)`;
      assert.isTrue(indexes.some((index) => index.name === "provider_terminal_events_due"));
      assert.isTrue(
        indexes.some((index) => index.name === "provider_terminal_events_pending_thread"),
      );
    }),
  );
});

it.layer(ProviderTerminalEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "bounded terminal retries",
  (it) => {
    it.effect("origin fences and retry exhaustion cannot permanently block orphan recovery", () =>
      Effect.gen(function* () {
        const repository = yield* ProviderTerminalEventRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("orphan"),
          turnId = TurnId.makeUnsafe("active");
        const providerInstanceId = ProviderInstanceId.makeUnsafe("codex-test");
        const eventId = EventId.makeUnsafe("old-exit");
        yield* repository.record({
          type: "session.exited",
          eventId,
          provider: "codex",
          threadId,
          providerInstanceId,
          sessionGeneration: 1,
          createdAt: "2026-10-20T00:00:00.000Z",
          payload: { reason: "exit" },
        });
        yield* sql`UPDATE provider_terminal_events SET next_due_at = '9999-01-01' WHERE event_id = ${eventId}`;
        const origin = { providerInstanceId, sessionGeneration: 2 };
        assert.isFalse(yield* repository.hasPending(threadId, turnId, origin));
        assert.isTrue(
          yield* repository.hasPending(threadId, turnId, { ...origin, sessionGeneration: 1 }),
        );
        assert.isFalse(
          yield* repository.hasPending(threadId, turnId, {
            ...origin,
            providerInstanceId: ProviderInstanceId.makeUnsafe("other"),
            sessionGeneration: 1,
          }),
        );
        yield* repository.takeRecoveryThreadIds;
        for (let index = 0; index < 12; index++)
          yield* repository.markFailed({ eventId, error: "permanent" });
        assert.isFalse(
          yield* repository.hasPending(threadId, turnId, { ...origin, sessionGeneration: 1 }),
        );
        assert.isTrue(yield* repository.hasExhausted(threadId));
        assert.deepStrictEqual(yield* repository.takeRecoveryThreadIds, [threadId]);
        const rows = yield* sql<{
          attempt: number;
          applied_at: null;
          event_json: string;
        }>`SELECT attempt, applied_at, event_json FROM provider_terminal_events WHERE event_id = ${eventId}`;
        assert.equal(rows[0]?.attempt, 10);
        assert.isNull(rows[0]?.applied_at);
        assert.isString(rows[0]?.event_json);
        assert.deepStrictEqual(yield* repository.listDue("9999-12-31"), []);
        yield* repository.markApplied(eventId);
        assert.deepStrictEqual(yield* repository.takeRecoveryThreadIds, []);
      }),
    );
    it.effect(
      "pages through pending receipts, isolates malformed rows and retains origin identity",
      () =>
        Effect.gen(function* () {
          const repository = yield* ProviderTerminalEventRepository;
          const sql = yield* SqlClient.SqlClient;
          const event = (index: number) => ({
            type: "turn.completed" as const,
            eventId: EventId.makeUnsafe(`page-${String(index).padStart(3, "0")}`),
            provider: "codex" as const,
            providerInstanceId: ProviderInstanceId.makeUnsafe("codex-test"),
            sessionGeneration: 7,
            threadId: ThreadId.makeUnsafe(`thread-${index}`),
            turnId: TurnId.makeUnsafe(`turn-${index}`),
            createdAt: "2026-10-19T12:00:00.000Z",
            payload: { state: "completed" as const },
          });
          for (let index = 0; index < 130; index++) yield* repository.record(event(index));
          yield* sql`UPDATE provider_terminal_events SET event_json = 'invalid' WHERE event_id = 'page-000'`;
          const first = yield* repository.listDue("9999-12-31T00:00:00.000Z");
          assert.equal(first.length, 63);
          assert.equal(first[0]?.originSessionGeneration, 7);
          assert.equal(first[0]?.originProviderInstanceId, "codex-test");
          assert.equal(first[0]?.originTurnId, "turn-1");
          assert.isTrue(
            yield* repository.hasPending(
              ThreadId.makeUnsafe("thread-129"),
              TurnId.makeUnsafe("turn-129"),
              {
                providerInstanceId: ProviderInstanceId.makeUnsafe("codex-test"),
                sessionGeneration: 7,
              },
            ),
          );
          for (const receipt of first) yield* repository.markApplied(receipt.eventId);
          const second = yield* repository.listDue();
          assert.equal(second.length, 64);
          for (const receipt of second) yield* repository.markApplied(receipt.eventId);
          assert.equal((yield* repository.listDue()).length, 2);
          const malformed = yield* sql<{
            attempt: number;
            nextDue: string;
            appliedAt: string | null;
          }>`SELECT attempt, next_due_at AS nextDue, applied_at AS appliedAt FROM provider_terminal_events WHERE event_id = 'page-000'`;
          assert.equal(malformed[0]?.attempt, 1);
          assert.equal(malformed[0]?.appliedAt, null);
          assert.isTrue(Date.parse(malformed[0]!.nextDue) > Date.now());
        }),
    );
  },
);
