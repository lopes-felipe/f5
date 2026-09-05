import { it, expect } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { Effect, Deferred, Ref, Scope, Exit, Fiber } from "effect";
import * as Semaphore from "effect/Semaphore";
import type { UsageAccount, AccountUsageSection } from "@t3tools/contracts";
import { makeAccountUsageCapability, emptyAccountSection } from "./AccountUsageService.ts";

const initial = (key = "claude:test", enabled = true): UsageAccount => ({
  key,
  provider: "claudeAgent",
  providerInstanceId: null,
  displayName: "Claude",
  enabled,
  refreshState: "idle",
  sections: [emptyAccountSection("claude-usage")],
});
const sections: ReadonlyArray<AccountUsageSection> = [
  {
    kind: "claude-usage",
    outcome: "available",
    lastAttemptAt: "2026-09-05T00:00:00Z",
    errorCode: null,
    snapshot: {
      fetchedAt: "2026-09-05T00:00:00Z",
      data: { subscriptionLabel: "Max", limitsAvailable: true, windows: [], extraUsage: null },
    },
  },
];
const settle = Effect.gen(function* () {
  for (let i = 0; i < 40; i++) yield* Effect.yieldNow;
});

it.effect("coalesces concurrent requests, respects TTL/cooldown, and never reads on none", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const permits = yield* Semaphore.make(2);
    const capability = yield* makeAccountUsageCapability(
      initial(),
      Ref.update(calls, (n) => n + 1).pipe(Effect.as(sections)),
    );
    yield* Effect.all(
      [capability.refresh("force", permits), capability.refresh("force", permits)],
      { concurrency: "unbounded" },
    );
    yield* settle;
    expect(yield* Ref.get(calls)).toBe(1);
    yield* capability.refresh("force", permits);
    yield* settle;
    expect(yield* Ref.get(calls)).toBe(1);
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh("force", permits);
    yield* settle;
    expect(yield* Ref.get(calls)).toBe(2);
    yield* TestClock.adjust("5 minutes");
    yield* capability.refresh("none", permits);
    expect(yield* Ref.get(calls)).toBe(2);
    yield* capability.refresh("if-stale", permits);
    yield* settle;
    expect(yield* Ref.get(calls)).toBe(3);
  }).pipe(Effect.scoped),
);

it.effect("returns sixteen queued snapshots immediately and bounds work to two probes", () =>
  Effect.gen(function* () {
    const active = yield* Ref.make(0);
    const peak = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    const permits = yield* Semaphore.make(2);
    const read = Effect.gen(function* () {
      const count = yield* Ref.updateAndGet(active, (n) => n + 1);
      yield* Ref.update(peak, (n) => Math.max(n, count));
      yield* Deferred.await(gate);
      return sections;
    }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1)));
    const capabilities = yield* Effect.forEach(
      Array.from({ length: 16 }, (_, i) => i),
      (i) => makeAccountUsageCapability(initial(`claude:${i}`), read),
    );
    yield* Effect.forEach(capabilities, (c) => c.refresh("if-stale", permits));
    yield* settle;
    expect(yield* Ref.get(active)).toBe(2);
    const snapshots = yield* Effect.forEach(capabilities, (c) => c.getSnapshot);
    expect(snapshots.filter((s) => s.refreshState === "queued")).toHaveLength(14);
    yield* Deferred.succeed(gate, undefined);
    yield* settle;
    expect(yield* Ref.get(peak)).toBe(2);
    expect(
      (yield* Effect.forEach(capabilities, (c) => c.getSnapshot)).every(
        (s) => s.refreshState === "idle" && s.sections[0]?.snapshot,
      ),
    ).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect(
  "retains success on failure, replaces success with empty data, and skips disabled accounts",
  () =>
    Effect.gen(function* () {
      let fail = false;
      const read = Effect.suspend(() =>
        fail ? Effect.fail(new Error("secret-provider-message")) : Effect.succeed(sections),
      );
      const permits = yield* Semaphore.make(2);
      const capability = yield* makeAccountUsageCapability(initial(), read);
      yield* capability.refresh("force", permits);
      yield* settle;
      fail = true;
      yield* TestClock.adjust("30 seconds");
      yield* capability.refresh("force", permits);
      yield* settle;
      const result = yield* capability.getSnapshot;
      expect(result.sections[0]?.snapshot).toEqual(sections[0]?.snapshot);
      expect(result.sections[0]?.errorCode).toBe("temporary-failure");
      expect(result.refreshState).toBe("idle");
      const disabled = yield* makeAccountUsageCapability(
        initial("disabled", false),
        Effect.die("must not run"),
      );
      yield* disabled.refresh("force", permits);
      expect((yield* disabled.getSnapshot).refreshState).toBe("idle");
    }).pipe(Effect.scoped),
);

it.effect("scope retirement interrupts running and queued probes and releases permits", () =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(1);
    const scope = yield* Scope.make();
    const interrupted = yield* Ref.make(0);
    const read = Effect.never.pipe(Effect.ensuring(Ref.update(interrupted, (n) => n + 1)));
    const running = yield* makeAccountUsageCapability(initial("running"), read).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const queued = yield* makeAccountUsageCapability(initial("queued"), read).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    yield* running.refresh("force", permits);
    yield* queued.refresh("force", permits);
    yield* settle;
    yield* Scope.close(scope, Exit.void);
    expect(yield* Ref.get(interrupted)).toBe(1);
    expect((yield* running.getSnapshot).refreshState).toBe("idle");
    expect((yield* queued.getSnapshot).refreshState).toBe("idle");
    yield* permits.withPermits(1)(Effect.void);
  }),
);

it.effect(
  "starts each timeout after a permit and survives cancellation of the requesting fiber",
  () =>
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(1);
      const first = yield* makeAccountUsageCapability(initial("first"), Effect.never);
      const second = yield* makeAccountUsageCapability(initial("second"), Effect.never);
      const request = yield* first
        .refresh("force", permits)
        .pipe(Effect.andThen(Effect.never), Effect.forkChild);
      yield* settle;
      yield* Fiber.interrupt(request);
      expect((yield* first.getSnapshot).refreshState).toBe("refreshing");
      yield* second.refresh("force", permits);
      yield* TestClock.adjust("7 seconds");
      expect((yield* second.getSnapshot).refreshState).toBe("queued");
      yield* TestClock.adjust("1 second");
      yield* settle;
      expect((yield* first.getSnapshot).sections[0]?.errorCode).toBe("timeout");
      expect((yield* second.getSnapshot).refreshState).toBe("refreshing");
      yield* TestClock.adjust("8 seconds");
      yield* settle;
      expect((yield* second.getSnapshot).refreshState).toBe("idle");
      expect((yield* second.getSnapshot).sections[0]?.errorCode).toBe("timeout");
    }).pipe(Effect.scoped),
);

it.effect(
  "retains failed Codex sections independently and replaces successful old data with empty data",
  () =>
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(2);
      const at = "2026-09-05T00:00:00Z";
      let response: ReadonlyArray<AccountUsageSection> = [
        {
          kind: "codex-tokens",
          outcome: "available",
          lastAttemptAt: at,
          errorCode: null,
          snapshot: {
            fetchedAt: at,
            data: {
              tokenSummary: null,
              dailyUsageBuckets: [{ startDate: "2026-09-05", tokens: "123" }],
            },
          },
        },
        {
          kind: "codex-limits",
          outcome: "available",
          lastAttemptAt: at,
          errorCode: null,
          snapshot: { fetchedAt: at, data: { rateLimits: [] } },
        },
      ];
      const capability = yield* makeAccountUsageCapability(
        {
          ...initial("codex"),
          provider: "codex",
          sections: [emptyAccountSection("codex-tokens"), emptyAccountSection("codex-limits")],
        },
        Effect.sync(() => response),
      );
      yield* capability.refresh("force", permits);
      yield* settle;
      const successful = (yield* capability.getSnapshot).sections;
      response = [
        {
          kind: "codex-tokens",
          outcome: "unavailable",
          errorCode: "timeout",
          lastAttemptAt: at,
          snapshot: null,
        },
        response[1]!,
      ];
      yield* TestClock.adjust("30 seconds");
      yield* capability.refresh("force", permits);
      yield* settle;
      expect((yield* capability.getSnapshot).sections[0]?.snapshot).toEqual(
        successful[0]?.snapshot,
      );
      response = [
        {
          kind: "codex-tokens",
          outcome: "available",
          errorCode: null,
          lastAttemptAt: at,
          snapshot: { fetchedAt: at, data: { tokenSummary: null, dailyUsageBuckets: [] } },
        },
        response[1]!,
      ];
      yield* TestClock.adjust("30 seconds");
      yield* capability.refresh("force", permits);
      yield* settle;
      expect((yield* capability.getSnapshot).sections[0]?.snapshot).toEqual(response[0]?.snapshot);
    }).pipe(Effect.scoped),
);
