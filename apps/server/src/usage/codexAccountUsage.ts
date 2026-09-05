import { Clock, Effect } from "effect";
import type {
  CodexAccountCredits,
  CodexAccountDailyUsageBucket,
  CodexAccountRateLimit,
  CodexAccountRateLimitWindow,
  CodexAccountTokenSummary,
  AccountUsageSection,
} from "@t3tools/contracts";

import { AccountUsageReadError, accountUsageErrorCode } from "./accountUsageErrors.ts";
import {
  CodexControlClient,
  type CodexControlEnvironmentConfig,
  isMethodNotFoundError,
} from "../codex/CodexControlClient.ts";

import {
  asRecord,
  asTrimmedString,
  asNonNegativeInteger,
  asNonNegativeNumber,
  asDecimalCount,
} from "./accountUsageJson.ts";

export function normalizeTokenSummary(value: unknown): CodexAccountTokenSummary | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    lifetimeTokens: asDecimalCount(record.lifetimeTokens),
    peakDailyTokens: asDecimalCount(record.peakDailyTokens),
    longestRunningTurnSec: asDecimalCount(record.longestRunningTurnSec),
    currentStreakDays: asDecimalCount(record.currentStreakDays),
    longestStreakDays: asDecimalCount(record.longestStreakDays),
  };
}

export function normalizeDailyUsageBuckets(
  value: unknown,
): ReadonlyArray<CodexAccountDailyUsageBucket> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const startDate = asTrimmedString(record?.startDate);
    const tokens = asDecimalCount(record?.tokens);
    return startDate && tokens ? [{ startDate, tokens }] : [];
  });
}

function normalizeRateLimitWindow(value: unknown): CodexAccountRateLimitWindow | null {
  const record = asRecord(value);
  const usedPercent = asNonNegativeNumber(record?.usedPercent);
  if (!record || usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: asNonNegativeInteger(record.windowDurationMins),
    resetsAt: asNonNegativeInteger(record.resetsAt),
  };
}

function normalizeCredits(value: unknown): CodexAccountCredits | null {
  const record = asRecord(value);
  if (!record || typeof record.hasCredits !== "boolean" || typeof record.unlimited !== "boolean") {
    return null;
  }
  return {
    hasCredits: record.hasCredits,
    unlimited: record.unlimited,
    balance: typeof record.balance === "string" ? record.balance : null,
  };
}

function normalizeRateLimit(value: unknown, fallbackId: string): CodexAccountRateLimit | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asTrimmedString(record.limitId) ?? fallbackId;
  return {
    id,
    name: asTrimmedString(record.limitName),
    planType: asTrimmedString(record.planType),
    primary: normalizeRateLimitWindow(record.primary),
    secondary: normalizeRateLimitWindow(record.secondary),
    credits: normalizeCredits(record.credits),
  };
}

export function normalizeRateLimits(value: unknown): ReadonlyArray<CodexAccountRateLimit> {
  const response = asRecord(value);
  if (!response) return [];
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  if (byLimitId && Object.keys(byLimitId).length > 0) {
    return Object.entries(byLimitId).flatMap(([id, snapshot]) => {
      const normalized = normalizeRateLimit(snapshot, id);
      return normalized ? [normalized] : [];
    });
  }
  const legacy = normalizeRateLimit(response.rateLimits, "codex");
  return legacy ? [legacy] : [];
}

/** Own a dedicated client: cancelling startup or either scoped read retires its process.
 * The shared admin pool cannot provide this guarantee without cancelling unrelated callers.
 */
export const probeCodexAccountSections = (environment: CodexControlEnvironmentConfig) =>
  Effect.suspend(() => {
    let client: CodexControlClient | undefined;
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      client = yield* Effect.tryPromise({
        try: (signal) => CodexControlClient.create(environment, signal),
        catch: (error) => new AccountUsageReadError(accountUsageErrorCode(error)),
      }).pipe(Effect.timeout(8_000));
      const remaining = Math.max(1, 8_000 - ((yield* Clock.currentTimeMillis) - startedAt));
      return yield* readCodexAccountSections(client, remaining);
    }).pipe(Effect.ensuring(Effect.sync(() => client?.close())));
  });

/** RPC failures are values, so one failed section never discards a successful sibling.
 * The caller owns the client and must close it after this effect, including interruption.
 */
export function readCodexAccountSections(client: CodexControlClient, timeoutMs = 8_000) {
  const read = (kind: "codex-tokens" | "codex-limits"): Effect.Effect<AccountUsageSection> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          kind === "codex-tokens" ? client.readAccountTokenUsage() : client.readAccountRateLimits(),
        catch: (error) =>
          new AccountUsageReadError(
            isMethodNotFoundError(error) ? "unsupported" : accountUsageErrorCode(error),
          ),
      }).pipe(Effect.timeout(timeoutMs));
      const record = asRecord(response);
      if (!record) return yield* Effect.fail(new AccountUsageReadError("invalid-response"));
      const data =
        kind === "codex-tokens"
          ? {
              tokenSummary: normalizeTokenSummary(record.summary),
              dailyUsageBuckets: normalizeDailyUsageBuckets(record.dailyUsageBuckets),
            }
          : { rateLimits: normalizeRateLimits(record) };
      const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return {
        kind,
        outcome: "available",
        lastAttemptAt: fetchedAt,
        errorCode: null,
        snapshot: { fetchedAt, data },
      } as AccountUsageSection;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Classify typed Effect failures here, before any Promise/FiberFailure boundary.
          const errorCode = accountUsageErrorCode(error);
          return {
            kind,
            outcome: errorCode === "unsupported" ? "unsupported" : "unavailable",
            lastAttemptAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            errorCode,
            snapshot: null,
          } as AccountUsageSection;
        }),
      ),
    );
  return Effect.all([read("codex-tokens"), read("codex-limits")], { concurrency: 2 });
}
