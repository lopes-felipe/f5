import { Effect } from "effect";
import type {
  CodexAccountCredits,
  CodexAccountDailyUsageBucket,
  CodexAccountRateLimit,
  CodexAccountRateLimitWindow,
  CodexAccountTokenSummary,
  CodexAccountUsage,
  IsoDateTime,
} from "@t3tools/contracts";

import { AccountUsageReadError, accountUsageErrorCode } from "./accountUsageErrors.ts";
import { type CodexControlClient, isMethodNotFoundError } from "../codex/CodexControlClient.ts";

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

function messageForErrors(errors: ReadonlyArray<unknown>): string | null {
  return errors.length
    ? errors.every(isMethodNotFoundError)
      ? "Method not found."
      : "Account usage is temporarily unavailable."
    : null;
}

export async function readCodexAccountUsage(input: {
  readonly client: CodexControlClient;
  readonly fetchedAt: IsoDateTime;
}): Promise<CodexAccountUsage> {
  const [tokenUsageResult, rateLimitsResult] = await Promise.allSettled([
    input.client.readAccountTokenUsage(),
    input.client.readAccountRateLimits(),
  ]);
  const errors = [tokenUsageResult, rateLimitsResult].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  const hasSuccessfulResponse =
    tokenUsageResult.status === "fulfilled" || rateLimitsResult.status === "fulfilled";
  const status = hasSuccessfulResponse
    ? "available"
    : errors.length > 0 && errors.every(isMethodNotFoundError)
      ? "unsupported"
      : "unavailable";
  const tokenUsage =
    tokenUsageResult.status === "fulfilled" ? asRecord(tokenUsageResult.value) : null;

  return {
    status,
    fetchedAt: input.fetchedAt,
    tokenSummary: normalizeTokenSummary(tokenUsage?.summary),
    dailyUsageBuckets: normalizeDailyUsageBuckets(tokenUsage?.dailyUsageBuckets),
    rateLimits:
      rateLimitsResult.status === "fulfilled" ? normalizeRateLimits(rateLimitsResult.value) : [],
    message: messageForErrors(errors),
  };
}

export function unavailableCodexAccountUsage(input: {
  readonly fetchedAt: IsoDateTime;
  readonly error: unknown;
}): CodexAccountUsage {
  return {
    status: isMethodNotFoundError(input.error) ? "unsupported" : "unavailable",
    fetchedAt: input.fetchedAt,
    tokenSummary: null,
    dailyUsageBuckets: [],
    rateLimits: [],
    message: messageForErrors([input.error]),
  };
}

/** Separate outcomes allow one RPC to fail without discarding the other snapshot. */
export async function readCodexAccountSections(
  client: CodexControlClient,
  timeoutMs = 8_000,
): Promise<ReadonlyArray<import("@t3tools/contracts").AccountUsageSection>> {
  const read = async (
    kind: "codex-tokens" | "codex-limits",
  ): Promise<import("@t3tools/contracts").AccountUsageSection> => {
    try {
      const response = await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            kind === "codex-tokens"
              ? client.readAccountTokenUsage()
              : client.readAccountRateLimits(),
          catch: (error) =>
            new AccountUsageReadError(
              isMethodNotFoundError(error) ? "unsupported" : accountUsageErrorCode(error),
            ),
        }).pipe(Effect.timeout(timeoutMs)),
      );
      const record = asRecord(response);
      if (!record) throw new AccountUsageReadError("invalid-response");
      if (kind === "codex-tokens") {
        const data = {
          tokenSummary: normalizeTokenSummary(record.summary),
          dailyUsageBuckets: normalizeDailyUsageBuckets(record.dailyUsageBuckets),
        };
        const fetchedAt = new Date().toISOString();
        return {
          kind,
          outcome: "available",
          lastAttemptAt: fetchedAt,
          errorCode: null,
          snapshot: { fetchedAt, data },
        };
      }
      const data = { rateLimits: normalizeRateLimits(record) };
      const fetchedAt = new Date().toISOString();
      return {
        kind,
        outcome: "available",
        lastAttemptAt: fetchedAt,
        errorCode: null,
        snapshot: { fetchedAt, data },
      };
    } catch (error) {
      const errorCode = isMethodNotFoundError(error) ? "unsupported" : accountUsageErrorCode(error);
      return {
        kind,
        outcome: errorCode === "unsupported" ? "unsupported" : "unavailable",
        lastAttemptAt: new Date().toISOString(),
        errorCode,
        snapshot: null,
      };
    }
  };
  return Promise.all([read("codex-tokens"), read("codex-limits")]);
}
