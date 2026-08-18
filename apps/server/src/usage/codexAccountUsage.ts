import type {
  CodexAccountCredits,
  CodexAccountDailyUsageBucket,
  CodexAccountRateLimit,
  CodexAccountRateLimitWindow,
  CodexAccountTokenSummary,
  CodexAccountUsage,
  IsoDateTime,
} from "@t3tools/contracts";

import { type CodexControlClient, isMethodNotFoundError } from "../codex/CodexControlClient.ts";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asDecimalCount(value: unknown): string | null {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

function normalizeTokenSummary(value: unknown): CodexAccountTokenSummary | null {
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

function normalizeDailyUsageBuckets(value: unknown): ReadonlyArray<CodexAccountDailyUsageBucket> {
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

function normalizeRateLimits(value: unknown): ReadonlyArray<CodexAccountRateLimit> {
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
  const messages = errors.flatMap((error) =>
    error instanceof Error && error.message.trim().length > 0 ? [error.message.trim()] : [],
  );
  return messages.length > 0 ? [...new Set(messages)].join(" ") : null;
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
    message: input.error instanceof Error ? input.error.message : String(input.error),
  };
}
