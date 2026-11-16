import { assert, it } from "@effect/vitest";
import type { AccountUsageSection, UsageAccount } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { UsageAccountHistoryRepositoryLive } from "../persistence/Layers/UsageAccountHistory.ts";
import Migration0116 from "../persistence/Migrations/116_UsageAccountHistory.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { UsageAccountHistoryRepository } from "../persistence/Services/UsageAccountHistory.ts";
import { makeAccountHistoryRecorder } from "./accountHistory.ts";
import { emptyAccountSection } from "./Layers/AccountUsageService.ts";

const claudeSection = (fetchedAt: string, utilization: number): AccountUsageSection => ({
  kind: "claude-usage",
  outcome: "available",
  lastAttemptAt: fetchedAt,
  errorCode: null,
  snapshot: {
    fetchedAt,
    data: {
      subscriptionLabel: "Max",
      limitsAvailable: true,
      windows: [
        {
          key: "five_hour",
          label: "5-hour limit",
          utilization,
          resetsAt: "2026-10-15T15:00:00.000Z",
        },
      ],
      extraUsage: null,
      limitResets: {
        grants: [
          {
            id: "full",
            label: "Full reset",
            kind: "full",
            resetsLeft: 1,
            resetsTotal: 1,
            endsAt: null,
            usableNow: true,
            useRequiresLimit: false,
            givesBackWeekly: false,
            paused: false,
            clears: ["five_hour"],
            blocking: [],
            unavailableReason: null,
          },
        ],
        nextGrantId: "full",
        cooldownUntil: null,
      },
    },
  },
});

const codexLimits = (fetchedAt: string): AccountUsageSection => ({
  kind: "codex-limits",
  outcome: "available",
  lastAttemptAt: fetchedAt,
  errorCode: null,
  snapshot: {
    fetchedAt,
    data: {
      rateLimits: [
        {
          id: "codex",
          name: "Codex",
          planType: null,
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_792_000_000 },
          secondary: null,
          credits: null,
        },
      ],
      resetCredits: { availableCount: 2, nextExpiresAt: null },
    },
  },
});

const account = (key: string, sections: ReadonlyArray<AccountUsageSection>): UsageAccount => ({
  key,
  provider: key.startsWith("codex") ? "codex" : "claudeAgent",
  providerInstanceId: null,
  displayName: key,
  enabled: true,
  refreshState: "idle",
  sections,
});

const freshClaude = account("claude:a", [emptyAccountSection("claude-usage")]);

it.layer(SqliteClient.layerMemory())("account history recorder", (it) => {
  it.effect("persists snapshots and samples, reloads after restart, and hydrates safely", () =>
    Effect.gen(function* () {
      yield* Migration0116;
      const repository = yield* UsageAccountHistoryRepository;
      const first = yield* makeAccountHistoryRecorder;
      yield* first.observe(
        account("claude:a", [claudeSection("2026-10-15T10:00:00.000Z", 20)]),
        "id-a",
      );
      yield* first.observe(account("codex:a", [codexLimits("2026-10-15T10:00:00.000Z")]), "id-c");
      // Out-of-order observation is a no-op.
      yield* first.observe(
        account("claude:a", [claudeSection("2026-10-15T09:00:00.000Z", 99)]),
        "id-a",
      );
      const samples = yield* repository.listSamplesSince("2026-01-01T00:00:00.000Z");
      assert.deepStrictEqual(
        samples.map((row) => [row.accountKey, row.windowKey, row.usedPercent]),
        [
          ["claude:a", "five_hour", 20],
          ["codex:a", "codex:primary", 40],
        ],
      );

      // A new recorder (server restart) reloads the persisted watermark.
      const restarted = yield* makeAccountHistoryRecorder;
      const hydrated = restarted.hydrate(freshClaude, "id-a");
      const section = hydrated.sections[0]!;
      assert.equal(section.snapshot?.fetchedAt, "2026-10-15T10:00:00.000Z");
      assert.equal(section.lastAttemptAt, null);
      assert.equal(section.outcome, "unavailable");
      // Stale limit resets must never drive the reset buttons.
      assert.equal(section.kind === "claude-usage" && section.snapshot?.data.limitResets, null);

      // Identity switch does not hydrate; shadows accept any identity.
      assert.equal(restarted.hydrate(freshClaude, "id-other").sections[0]!.snapshot, null);
      assert.isNotNull(restarted.hydrate(freshClaude, null).sections[0]!.snapshot);

      // Codex limits never carry stale reset credits.
      const codex = restarted.hydrate(
        account("codex:a", [emptyAccountSection("codex-limits")]),
        "id-c",
      ).sections[0]!;
      assert.equal(codex.kind === "codex-limits" && codex.snapshot?.data.resetCredits, null);

      // Auth-required sections are neither hydrated nor kept on disk.
      const authRequired = account("claude:a", [
        {
          ...emptyAccountSection("claude-usage"),
          errorCode: "authentication-required",
          lastAttemptAt: "2026-10-15T11:00:00.000Z",
        },
      ]);
      assert.equal(restarted.hydrate(authRequired, "id-a").sections[0]!.snapshot, null);
      yield* restarted.observe(authRequired, "id-a");
      assert.deepStrictEqual(
        (yield* repository.listSnapshots).map((row) => row.accountKey),
        ["codex:a"],
      );
      assert.equal(restarted.hydrate(freshClaude, "id-a").sections[0]!.snapshot, null);
    }).pipe(Effect.provide(UsageAccountHistoryRepositoryLive)),
  );

  it.effect("retries a failed write on the next observation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0116;
      yield* sql`DELETE FROM usage_account_snapshots`;
      yield* sql`DELETE FROM usage_quota_samples`;
      const repository = yield* UsageAccountHistoryRepository;
      const recorder = yield* makeAccountHistoryRecorder;
      const observed = account("claude:b", [claudeSection("2026-10-15T10:00:00.000Z", 5)]);
      yield* sql`
        CREATE TEMP TRIGGER fail_snapshots BEFORE INSERT ON usage_account_snapshots
        BEGIN SELECT RAISE(ABORT, 'write failed'); END
      `;
      // Failures are logged, never propagated.
      yield* recorder.observe(observed, "id-b");
      yield* sql`DROP TRIGGER fail_snapshots`;
      assert.equal((yield* repository.listSnapshots).length, 0);
      yield* recorder.observe(observed, "id-b");
      assert.equal((yield* repository.listSnapshots).length, 1);
    }).pipe(Effect.provide(UsageAccountHistoryRepositoryLive)),
  );
});

const fixedKeyStore = (key: number) =>
  Layer.succeed(ServerSecretStore, {
    get: () => Effect.succeed(null),
    set: () => Effect.void,
    remove: () => Effect.void,
    list: () => Effect.succeed([]),
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(key)),
  });

it.layer(SqliteClient.layerMemory())("account identity protection", (it) => {
  it.effect("stores keyed identities that match only under the same install key", () =>
    Effect.gen(function* () {
      yield* Migration0116;
      const repository = yield* UsageAccountHistoryRepository;
      const recorder = yield* makeAccountHistoryRecorder.pipe(Effect.provide(fixedKeyStore(1)));
      yield* recorder.observe(
        account("claude:a", [claudeSection("2026-10-15T10:00:00.000Z", 20)]),
        "raw-identity",
      );
      const [row] = yield* repository.listSnapshots;
      assert.match(row!.identity, /^hmac:[0-9a-f]{64}$/);
      assert.notInclude(row!.identity, "raw-identity");

      const restarted = yield* makeAccountHistoryRecorder.pipe(Effect.provide(fixedKeyStore(1)));
      assert.isNotNull(restarted.hydrate(freshClaude, "raw-identity").sections[0]!.snapshot);
      // A different install key cannot match the stored identity.
      const otherInstall = yield* makeAccountHistoryRecorder.pipe(Effect.provide(fixedKeyStore(2)));
      assert.isNull(otherInstall.hydrate(freshClaude, "raw-identity").sections[0]!.snapshot);
    }).pipe(Effect.provide(UsageAccountHistoryRepositoryLive)),
  );
});
