import { expect, it } from "@effect/vitest";
import type { AccountUsageSection } from "@t3tools/contracts";
import { Effect, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  emptyAccountSection,
  makeAccountUsageCapability,
} from "../../usage/Layers/AccountUsageService.ts";
import { makeClaudeSignOutInvalidation } from "./ClaudeProbeCache.ts";

type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

const usageSections = (limitsAvailable: boolean): ReadonlyArray<AccountUsageSection> => [
  {
    kind: "claude-usage",
    outcome: "available",
    lastAttemptAt: "2026-10-29T00:00:00.000Z",
    errorCode: null,
    snapshot: {
      fetchedAt: "2026-10-29T00:00:00.000Z",
      data: { subscriptionLabel: null, limitsAvailable, windows: [], extraUsage: null },
    },
  },
];

const setup = Effect.gen(function* () {
  const status = yield* Ref.make<AuthStatus>("authenticated");
  const probeInvalidations = yield* Ref.make(0);
  const usageReads = yield* Ref.make(0);
  const accountUsage = yield* makeAccountUsageCapability(
    {
      key: "claude:test",
      provider: "claudeAgent",
      providerInstanceId: null,
      displayName: "Claude",
      enabled: true,
      refreshState: "idle",
      sections: [emptyAccountSection("claude-usage")],
    },
    Ref.update(usageReads, (n) => n + 1).pipe(
      Effect.andThen(Ref.get(status)),
      Effect.map((current) => usageSections(current === "authenticated")),
    ),
    { identity: "test:claude", retryFailedReads: true },
  );
  const withSignOutInvalidation = yield* makeClaudeSignOutInvalidation({
    invalidateProbes: Ref.update(probeInvalidations, (n) => n + 1),
    invalidateUsage: accountUsage.invalidate!,
  });
  const check = withSignOutInvalidation(
    Ref.get(status).pipe(Effect.map((current) => ({ auth: { status: current } }))),
  );
  const permits = yield* Semaphore.make(1);
  const readUsage = accountUsage.refreshAccount(permits, "if-stale");
  return { status, probeInvalidations, usageReads, check, readUsage };
});

it.effect("an authenticated status check keeps cached probes", () =>
  Effect.gen(function* () {
    const { probeInvalidations, usageReads, check, readUsage } = yield* setup;
    yield* readUsage;
    yield* check;
    yield* check;
    yield* readUsage;
    expect(yield* Ref.get(probeInvalidations)).toBe(0);
    expect(yield* Ref.get(usageReads)).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("signing out drops cached probes and signing back in drops signed-out usage", () =>
  Effect.gen(function* () {
    const { status, probeInvalidations, usageReads, check, readUsage } = yield* setup;
    yield* readUsage;
    yield* Ref.set(status, "unauthenticated");
    yield* check;
    expect(yield* Ref.get(probeInvalidations)).toBe(1);
    // A read while signed out returns no limits and would otherwise hold the TTL.
    const signedOut = yield* readUsage;
    expect(yield* Ref.get(usageReads)).toBe(2);
    expect(signedOut.snapshot.sections[0]).toMatchObject({
      snapshot: { data: { limitsAvailable: false } },
    });
    yield* Ref.set(status, "authenticated");
    yield* check;
    // Capabilities probed while signed out are dropped before the check runs.
    expect(yield* Ref.get(probeInvalidations)).toBe(2);
    const signedIn = yield* readUsage;
    expect(yield* Ref.get(usageReads)).toBe(3);
    expect(signedIn.snapshot.sections[0]).toMatchObject({
      snapshot: { data: { limitsAvailable: true } },
    });
    // Once signed in, checks stop invalidating.
    yield* check;
    yield* readUsage;
    expect(yield* Ref.get(probeInvalidations)).toBe(2);
    expect(yield* Ref.get(usageReads)).toBe(3);
  }).pipe(Effect.scoped),
);
