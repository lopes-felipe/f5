import { assert, it } from "@effect/vitest";
import type { AccountUsageSection, UsageAccount } from "@t3tools/contracts";
import { Clock, Effect, Exit, Fiber, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { AccountUsageCapability } from "./accountUsage.ts";
import type { AccountHistoryRecorder } from "./accountHistory.ts";
import { emptyAccountSection, makeAccountUsageCapability } from "./Layers/AccountUsageService.ts";
import { makeQuotaSampler, quotaSamplerBackoffMinutes } from "./quotaSampler.ts";

type ProviderLimitsSection = Extract<AccountUsageSection, { kind: "provider-limits" }>;
const available = (fetchedAt = "2026-10-15T10:00:00.000Z"): ProviderLimitsSection => ({
  kind: "provider-limits",
  outcome: "available",
  lastAttemptAt: fetchedAt,
  errorCode: null,
  snapshot: { fetchedAt, data: { windows: [] } },
});
/** An available section whose only window resets `resetsInMs` after the test clock's now. */
const resettingIn = (resetsInMs: number) =>
  Effect.map(
    Clock.currentTimeMillis,
    (now): ReadonlyArray<AccountUsageSection> => [
      {
        ...available(),
        snapshot: {
          fetchedAt: new Date(now).toISOString(),
          data: {
            windows: [
              {
                id: "window",
                label: "Window",
                usedPercent: 10,
                resetsAt: new Date(now + resetsInMs).toISOString(),
              },
            ],
          },
        },
      },
    ],
  );
const HOUR = 3_600_000;
const failed: AccountUsageSection = {
  ...emptyAccountSection("provider-limits"),
  errorCode: "temporary-failure",
  lastAttemptAt: "2026-10-15T10:00:00.000Z",
};

const account = (key: string, sections: ReadonlyArray<AccountUsageSection>): UsageAccount => ({
  key,
  provider: "cursor",
  providerInstanceId: null,
  displayName: key,
  enabled: true,
  refreshState: "idle",
  sections,
});

interface FakeCapability {
  readonly capability: AccountUsageCapability;
  readonly calls: Array<string>;
}

function fakeCapability(
  key: string,
  probe: (call: number) => Effect.Effect<ReadonlyArray<AccountUsageSection>>,
  state: Partial<UsageAccount> = {},
): FakeCapability {
  const calls: Array<string> = [];
  let current = { ...account(key, [emptyAccountSection("provider-limits")]), ...state };
  return {
    calls,
    capability: {
      identity: `id:${key}`,
      getSnapshot: Effect.sync(() => current),
      refresh: () => Effect.void,
      refreshAccount: (_permits, mode) =>
        Effect.gen(function* () {
          calls.push(mode ?? "force");
          const sections = yield* probe(calls.length);
          current = { ...current, sections };
          return { snapshot: current, fresh: true };
        }),
    },
  };
}

const instance = (
  capability: AccountUsageCapability | undefined,
  enabled = true,
): ProviderInstance =>
  ({ instanceId: "test", enabled, accountUsage: capability }) as unknown as ProviderInstance;

function harness(instances: ReadonlyArray<ProviderInstance>, enabled = { current: true }) {
  const observed: Array<string> = [];
  const pruned: Array<ReadonlyArray<string>> = [];
  const recorder: AccountHistoryRecorder = {
    observe: (snapshot) => Effect.sync(() => void observed.push(snapshot.key)),
    hydrate: (snapshot) => snapshot,
  };
  return Effect.gen(function* () {
    const sampler = makeQuotaSampler({
      listInstances: Effect.succeed(instances),
      listAccountKeys: Effect.succeed(["keep"]),
      enabled: Effect.sync(() => enabled.current),
      permits: yield* Semaphore.make(2),
      recorder,
      prune: (input) => Effect.sync(() => void pruned.push(input.keepAccountKeys)),
    });
    return { sampler, observed, pruned };
  });
}

it("spaces backoff at 10, 20, 40 minutes capped at two hours", () => {
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5, 10].map(quotaSamplerBackoffMinutes),
    [0, 10, 20, 40, 80, 120, 120],
  );
});

it.effect("skips disabled, busy, and refresh-less accounts", () =>
  Effect.gen(function* () {
    const disabled = fakeCapability("disabled", () => Effect.succeed([available()]));
    const busy = fakeCapability("busy", () => Effect.succeed([available()]), {
      refreshState: "queued",
    });
    const healthy = fakeCapability("healthy", () => Effect.succeed([available()]));
    const { refreshAccount: _omit, ...withoutRefresh } = healthy.capability;
    const { sampler, observed, pruned } = yield* harness([
      instance(disabled.capability, false),
      instance(busy.capability),
      instance(withoutRefresh as AccountUsageCapability),
      instance(undefined),
      instance(healthy.capability),
    ]);
    yield* sampler.tick;
    assert.deepStrictEqual(
      [disabled, busy].map((entry) => entry.calls.length),
      [0, 0],
    );
    assert.deepStrictEqual(healthy.calls, ["if-stale"]);
    assert.deepStrictEqual(observed, ["healthy"]);
    assert.deepStrictEqual(pruned, [["keep"]]);
  }),
);

it.effect("recovers from authentication-required after an external login, with backoff", () =>
  Effect.gen(function* () {
    const authRequired: AccountUsageSection = {
      ...emptyAccountSection("provider-limits"),
      errorCode: "authentication-required",
      lastAttemptAt: "2026-10-15T10:00:00.000Z",
    };
    let loggedIn = false;
    const fake = fakeCapability(
      "login",
      () => (loggedIn ? resettingIn(3 * HOUR) : Effect.succeed([authRequired])),
      { sections: [authRequired] },
    );
    const { sampler, observed } = yield* harness([instance(fake.capability)]);
    const probesAt: Array<number> = [];
    for (let minute = 0; minute <= 60; minute += 10) {
      // The user logs in through the provider CLI before the 30-minute tick.
      if (minute === 30) loggedIn = true;
      const before = fake.calls.length;
      yield* sampler.tick;
      if (fake.calls.length > before) probesAt.push(minute);
      yield* TestClock.adjust("10 minutes");
    }
    // Failures at 0 and 10 back off; the 30-minute probe sees the login and
    // a short window then keeps the 10-minute cadence.
    assert.deepStrictEqual(probesAt, [0, 10, 30, 40, 50, 60]);
    assert.isAbove(observed.length, 0);
  }),
);

it.effect("samples short windows every 10 minutes and long ones hourly", () =>
  Effect.gen(function* () {
    const short = fakeCapability("short", () => resettingIn(3 * HOUR));
    const weekly = fakeCapability("weekly", () => resettingIn(5 * 24 * HOUR));
    const unknown = fakeCapability("unknown", () => Effect.succeed([available()]));
    const { sampler } = yield* harness([
      instance(short.capability),
      instance(weekly.capability),
      instance(unknown.capability),
    ]);
    for (let minute = 0; minute < 120; minute += 10) {
      yield* sampler.tick;
      yield* TestClock.adjust("10 minutes");
    }
    assert.deepStrictEqual(
      [short, weekly, unknown].map((entry) => entry.calls.length),
      [12, 2, 2],
    );
  }),
);

it.effect("stops probing when background sampling is disabled but keeps pruning", () =>
  Effect.gen(function* () {
    const enabled = { current: false };
    const fake = fakeCapability("gated", () => resettingIn(3 * HOUR));
    const { sampler, pruned } = yield* harness([instance(fake.capability)], enabled);
    yield* sampler.tick;
    yield* TestClock.adjust("10 minutes");
    yield* sampler.tick;
    assert.equal(fake.calls.length, 0);
    assert.equal(pruned.length, 2);
    enabled.current = true;
    yield* sampler.tick;
    assert.equal(fake.calls.length, 1);
  }),
);

it.effect("reuses a recent dashboard read through the capability if-stale TTL", () =>
  Effect.gen(function* () {
    let reads = 0;
    const capability = yield* makeAccountUsageCapability(
      account("ttl", [emptyAccountSection("provider-limits")]),
      Effect.sync(() => {
        reads++;
        return [available()];
      }),
      { identity: "id:ttl" },
    );
    const { sampler } = yield* harness([instance(capability)]);
    // The open Limits tab read the account a minute before the sampler is due.
    yield* capability.refreshAccount!(yield* Semaphore.make(1), "force");
    yield* TestClock.adjust("1 minute");
    yield* sampler.tick;
    assert.equal(reads, 1);
  }),
);

it.effect("backs off failing accounts and resets after partial success", () =>
  Effect.gen(function* () {
    const succeedOn = 4;
    const fake = fakeCapability("flaky", (call) =>
      Effect.succeed(call >= succeedOn ? [failed, available()] : [failed]),
    );
    const { sampler } = yield* harness([instance(fake.capability)]);
    const probesAt: Array<number> = [];
    for (let minute = 0; minute <= 80; minute += 10) {
      const before = fake.calls.length;
      yield* sampler.tick;
      if (fake.calls.length > before) probesAt.push(minute);
      yield* TestClock.adjust("10 minutes");
    }
    // Failures at 0, 10, 30; the 70-minute probe partially succeeds and resets
    // to the success cadence (hourly, since no short window is reported).
    assert.deepStrictEqual(probesAt, [0, 10, 30, 70]);
  }),
);

it.effect("isolates a per-instance defect and releases a hung probe", () =>
  Effect.gen(function* () {
    const broken = fakeCapability("broken", () => Effect.die("boom"));
    const hung = fakeCapability("hung", () => Effect.never);
    const healthy = fakeCapability("healthy", () => Effect.succeed([available()]));
    const { sampler, observed } = yield* harness([
      instance(broken.capability),
      instance(hung.capability),
      instance(healthy.capability),
    ]);
    const fiber = yield* Effect.forkChild(sampler.tick);
    yield* TestClock.adjust("2 minutes");
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(healthy.calls, ["if-stale"]);
    assert.deepStrictEqual(observed, ["healthy"]);
  }),
);

it.effect("starts after one minute, repeats every ten, and stops with its scope", () =>
  Effect.gen(function* () {
    const fake = fakeCapability("loop", () => resettingIn(3 * HOUR));
    const { sampler } = yield* harness([instance(fake.capability)]);
    const scope = yield* Scope.make();
    yield* sampler.run.pipe(Effect.forkIn(scope));
    yield* TestClock.adjust("59 seconds");
    assert.equal(fake.calls.length, 0);
    yield* TestClock.adjust("1 second");
    assert.equal(fake.calls.length, 1);
    yield* TestClock.adjust("10 minutes");
    assert.equal(fake.calls.length, 2);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("1 hour");
    assert.equal(fake.calls.length, 2);
  }),
);
