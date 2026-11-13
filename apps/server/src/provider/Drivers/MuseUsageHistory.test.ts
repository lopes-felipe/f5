import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { UsageTurnFact, MuseSettings } from "@t3tools/contracts";
import { vi } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import * as MspTransport from "../msp/MspTransport.ts";
import * as MspRuntime from "../msp/MspSessionRuntime.ts";
import { realpath } from "node:fs/promises";
import { makeMuseUsageHistory } from "./MuseUsageHistory.ts";
import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration0001 from "../../persistence/Migrations/001_OrchestrationEvents.ts";
import Migration0004 from "../../persistence/Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "../../persistence/Migrations/005_Projections.ts";
import Migration0068 from "../../persistence/Migrations/068_UsageFacts.ts";
import Migration0073 from "../../persistence/Migrations/073_UsageFactRecordedAt.ts";
import Migration0074 from "../../persistence/Migrations/074_ProviderTerminalEvents.ts";
import Migration0159 from "../../persistence/Migrations/159_UsageNativeIdentity.ts";
import { UsageFactRepositoryLive } from "../../persistence/Layers/UsageFacts.ts";
import { UsageFactRepository } from "../../persistence/Services/UsageFacts.ts";
import { museRecordedIntervals } from "./MuseUsageHistory.ts";

const fact = Schema.decodeUnknownSync(UsageTurnFact)({
  turnId: "native-turn",
  threadId: "thread",
  projectId: "project",
  provider: "muse",
  providerInstanceId: null,
  model: "muse",
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 120,
  providerReportedCostUsd: null,
  tokenProvenance: "provider-reported",
  costProvenance: "unreported",
  completedAt: "2026-08-01T12:01:00.000Z",
  sourceEventId: "receipt",
});
const migrate = Effect.gen(function* () {
  yield* Migration0001;
  yield* Migration0004;
  yield* Migration0005;
  yield* Migration0068;
  yield* Migration0073;
  yield* Migration0074;
  yield* Migration0159;
});

it.effect("discovers the configured native home and closes without opening a session", () =>
  Effect.gen(function* () {
    const close = vi.fn(async () => {});
    using transport = vi
      .spyOn(MspTransport, "makeMspTransport")
      .mockReturnValue(
        Effect.succeed({ transport: {} } as Effect.Success<
          ReturnType<typeof MspTransport.makeMspTransport>
        >),
      );
    using open = vi.spyOn(MspRuntime, "openMspHost").mockResolvedValue({
      initializeResult: { museHome: process.cwd() },
      close,
    } as unknown as MspRuntime.MspHost);
    const capability = yield* makeMuseUsageHistory(
      Schema.decodeUnknownSync(MuseSettings)({ binaryPath: "~/bin/custom-muse" }),
      { XDG_DATA_HOME: "/configured/data", MUSE_NO_AUTO_UPDATE: "0" },
      true,
    );
    yield* capability.refresh;
    while ((yield* capability.getSnapshot).status === "refreshing") yield* Effect.yieldNow;
    const snapshot = yield* capability.getSnapshot;
    assert.equal(snapshot.source, yield* Effect.promise(() => realpath(process.cwd())));
    assert.equal(snapshot.status, "ready");
    assert.equal(close.mock.calls.length, 1);
    assert.equal(open.mock.calls.length, 1);
    assert.deepEqual(transport.mock.calls[0]?.[0].environment, {
      XDG_DATA_HOME: "/configured/data",
      MUSE_NO_AUTO_UPDATE: "1",
    });
    assert.include(transport.mock.calls[0]?.[0].binaryPath, "/bin/custom-muse");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("closes discovery transport when the Muse handshake never resolves", () =>
  Effect.gen(function* () {
    let closed = false;
    using _transport = vi.spyOn(MspTransport, "makeMspTransport").mockReturnValue(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ).pipe(
        Effect.as({ transport: {} } as Effect.Success<
          ReturnType<typeof MspTransport.makeMspTransport>
        >),
      ),
    );
    using _open = vi
      .spyOn(MspRuntime, "openMspHost")
      .mockImplementation(() => new Promise(() => {}));
    const capability = yield* makeMuseUsageHistory(
      Schema.decodeUnknownSync(MuseSettings)({}),
      {},
      true,
    );
    yield* capability.refresh;
    yield* TestClock.adjust("5 seconds");
    while ((yield* capability.getSnapshot).status === "refreshing") yield* Effect.yieldNow;
    assert.equal((yield* capability.getSnapshot).status, "error");
    assert.isTrue(closed);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(SqliteClient.layerMemory())("Muse durable history identity", (it) => {
  it.effect(
    "retains identity after session replacement, runtime deletion, turn rollback and fact replay",
    () =>
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* UsageFactRepository;
        yield* repository.record({
          ...fact,
          nativeSessionId: "original-session",
          startedAt: "2026-08-01T12:00:00.000Z",
        });
        yield* sql`INSERT INTO provider_session_runtime
        (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
        VALUES ('thread', 'muse', 'muse', 'ready', '2026-08-01', '{"mspSessionId":"replacement"}')`;
        const before = yield* museRecordedIntervals(sql);
        assert.equal(before[0]?.sessionId, "original-session");
        yield* sql`DELETE FROM provider_session_runtime`;
        yield* sql`DELETE FROM projection_turns`;
        yield* repository.record(fact);
        assert.deepEqual(yield* museRecordedIntervals(sql), before);
      }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});

it.layer(SqliteClient.layerMemory())("Muse receipt migration", (it) => {
  it.effect(
    "backfills original identity from terminal receipts instead of current runtime state",
    () =>
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* UsageFactRepository;
        yield* repository.record(fact);
        yield* sql`INSERT INTO provider_terminal_events
        (event_id, thread_id, turn_id, event_type, event_json, received_at)
        VALUES ('receipt', 'thread', 'native-turn', 'turn.completed',
          '{"resumeCursor":{"mspSessionId":"old-session"}}', '2026-08-01')`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json)
        VALUES ('thread', 'native-turn', 'completed', '2026-08-01T11:59:00.000Z', '2026-08-01T12:00:00.000Z', '[]')`;
        yield* Migration0159;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM provider_terminal_events`;
        assert.deepEqual(yield* museRecordedIntervals(sql), [
          {
            sessionId: "old-session",
            startedAt: "2026-08-01T12:00:00.000Z",
            endedAt: fact.completedAt,
          },
        ]);
      }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});
