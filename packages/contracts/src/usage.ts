import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderKind } from "./providerKind";
import { ProviderInstanceId } from "./providerInstance";

export const USAGE_WS_METHODS = {
  getSummary: "usage.getSummary",
  getAccounts: "usage.getAccounts",
} as const;

export const UsageRange = Schema.Literals(["24h", "7d", "30d", "90d"]);
export type UsageRange = typeof UsageRange.Type;

export const UsageTokenProvenance = Schema.Literals([
  "provider-reported",
  "derived-from-provider-fields",
  "unreported",
]);
export type UsageTokenProvenance = typeof UsageTokenProvenance.Type;

export const UsageCostProvenance = Schema.Literals(["provider-reported", "unreported"]);
export type UsageCostProvenance = typeof UsageCostProvenance.Type;

const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const UsageTurnFact = Schema.Struct({
  turnId: TurnId,
  threadId: ThreadId,
  projectId: ProjectId,
  provider: ProviderKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(TrimmedNonEmptyString),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteTokens: Schema.NullOr(NonNegativeInt),
  totalTokens: Schema.NullOr(NonNegativeInt),
  providerReportedCostUsd: Schema.NullOr(NonNegativeNumber),
  tokenProvenance: UsageTokenProvenance,
  costProvenance: UsageCostProvenance,
  completedAt: IsoDateTime,
  sourceEventId: TrimmedNonEmptyString,
});
export type UsageTurnFact = typeof UsageTurnFact.Type;

export const UsageGetSummaryInput = Schema.Struct({
  range: UsageRange,
  provider: Schema.optional(ProviderKind),
  timeZone: TrimmedNonEmptyString,
});
export type UsageGetSummaryInput = typeof UsageGetSummaryInput.Type;

export const UsageMetrics = Schema.Struct({
  turnCount: NonNegativeInt,
  reportedTokenTurnCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  providerReportedCostUsd: Schema.NullOr(NonNegativeNumber),
  pricedTurnCount: NonNegativeInt,
  unpricedTurnCount: NonNegativeInt,
});
export type UsageMetrics = typeof UsageMetrics.Type;

export const UsageTokenComposition = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  unattributedTokens: NonNegativeInt,
});
export type UsageTokenComposition = typeof UsageTokenComposition.Type;

export const UsageBucket = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  startAt: IsoDateTime,
  metrics: UsageMetrics,
  composition: Schema.optional(Schema.NullOr(UsageTokenComposition)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type UsageBucket = typeof UsageBucket.Type;

export const UsageProviderBreakdown = Schema.Struct({
  provider: ProviderKind,
  model: Schema.NullOr(TrimmedNonEmptyString),
  metrics: UsageMetrics,
});
export type UsageProviderBreakdown = typeof UsageProviderBreakdown.Type;

export const UsageCoverage = Schema.Struct({
  coverageStartedAt: IsoDateTime,
  rangeStartedAt: IsoDateTime,
  partialHistory: Schema.Boolean,
  historicalCostTurnCount: NonNegativeInt,
  tokenUnreportedTurnCount: NonNegativeInt,
  costUnreportedTurnCount: NonNegativeInt,
  providersMissingTokens: Schema.Array(ProviderKind),
  providersMissingCost: Schema.Array(ProviderKind),
});
export type UsageCoverage = typeof UsageCoverage.Type;

const CodexDecimalCount = TrimmedNonEmptyString.check(Schema.isPattern(/^\d+$/));

export const CodexAccountTokenSummary = Schema.Struct({
  lifetimeTokens: Schema.NullOr(CodexDecimalCount),
  peakDailyTokens: Schema.NullOr(CodexDecimalCount),
  longestRunningTurnSec: Schema.NullOr(CodexDecimalCount),
  currentStreakDays: Schema.NullOr(CodexDecimalCount),
  longestStreakDays: Schema.NullOr(CodexDecimalCount),
});
export type CodexAccountTokenSummary = typeof CodexAccountTokenSummary.Type;

export const CodexAccountDailyUsageBucket = Schema.Struct({
  startDate: TrimmedNonEmptyString,
  tokens: CodexDecimalCount,
});
export type CodexAccountDailyUsageBucket = typeof CodexAccountDailyUsageBucket.Type;

export const CodexAccountRateLimitWindow = Schema.Struct({
  usedPercent: NonNegativeNumber,
  windowDurationMins: Schema.NullOr(NonNegativeInt),
  resetsAt: Schema.NullOr(NonNegativeInt),
});
export type CodexAccountRateLimitWindow = typeof CodexAccountRateLimitWindow.Type;

export const CodexAccountCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(Schema.String),
});
export type CodexAccountCredits = typeof CodexAccountCredits.Type;

export const CodexAccountRateLimit = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
  planType: Schema.NullOr(TrimmedNonEmptyString),
  primary: Schema.NullOr(CodexAccountRateLimitWindow),
  secondary: Schema.NullOr(CodexAccountRateLimitWindow),
  credits: Schema.NullOr(CodexAccountCredits),
});
export type CodexAccountRateLimit = typeof CodexAccountRateLimit.Type;

export const CodexAccountUsageStatus = Schema.Literals(["available", "unsupported", "unavailable"]);
export type CodexAccountUsageStatus = typeof CodexAccountUsageStatus.Type;

export const CodexAccountUsage = Schema.Struct({
  status: CodexAccountUsageStatus,
  fetchedAt: IsoDateTime,
  tokenSummary: Schema.NullOr(CodexAccountTokenSummary),
  dailyUsageBuckets: Schema.Array(CodexAccountDailyUsageBucket),
  rateLimits: Schema.Array(CodexAccountRateLimit),
  message: Schema.NullOr(Schema.String),
});
export type CodexAccountUsage = typeof CodexAccountUsage.Type;

export const UsageSummary = Schema.Struct({
  range: UsageRange,
  timeZone: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  metrics: UsageMetrics,
  buckets: Schema.Array(UsageBucket),
  byProvider: Schema.Array(UsageProviderBreakdown),
  coverage: UsageCoverage,
});
export type UsageSummary = typeof UsageSummary.Type;

export const UsageGetAccountsInput = Schema.Struct({
  refresh: Schema.optional(Schema.Literals(["if-stale", "force", "none"])),
});
export type UsageGetAccountsInput = typeof UsageGetAccountsInput.Type;
export const AccountUsageErrorCode = Schema.Literals([
  "unsupported",
  "authentication-required",
  "timeout",
  "process-unavailable",
  "invalid-response",
  "temporary-failure",
]);
export type AccountUsageErrorCode = typeof AccountUsageErrorCode.Type;
export const ClaudeAccountUsageWindow = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  utilization: Schema.NullOr(NonNegativeNumber),
  resetsAt: Schema.NullOr(IsoDateTime),
});
export const ClaudeAccountUsage = Schema.Struct({
  subscriptionLabel: Schema.NullOr(TrimmedNonEmptyString),
  limitsAvailable: Schema.Boolean,
  windows: Schema.Array(ClaudeAccountUsageWindow),
  extraUsage: Schema.NullOr(
    Schema.Struct({ enabled: Schema.Boolean, utilization: Schema.NullOr(NonNegativeNumber) }),
  ),
});
export type ClaudeAccountUsage = typeof ClaudeAccountUsage.Type;
const sectionState = {
  outcome: CodexAccountUsageStatus,
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  errorCode: Schema.NullOr(AccountUsageErrorCode),
};
export const AccountUsageSection = Schema.Union([
  Schema.Struct({
    ...sectionState,
    kind: Schema.Literal("claude-usage"),
    snapshot: Schema.NullOr(Schema.Struct({ fetchedAt: IsoDateTime, data: ClaudeAccountUsage })),
  }),
  Schema.Struct({
    ...sectionState,
    kind: Schema.Literal("codex-tokens"),
    snapshot: Schema.NullOr(
      Schema.Struct({
        fetchedAt: IsoDateTime,
        data: Schema.Struct({
          tokenSummary: Schema.NullOr(CodexAccountTokenSummary),
          dailyUsageBuckets: Schema.Array(CodexAccountDailyUsageBucket),
        }),
      }),
    ),
  }),
  Schema.Struct({
    ...sectionState,
    kind: Schema.Literal("codex-limits"),
    snapshot: Schema.NullOr(
      Schema.Struct({
        fetchedAt: IsoDateTime,
        data: Schema.Struct({ rateLimits: Schema.Array(CodexAccountRateLimit) }),
      }),
    ),
  }),
]);
export type AccountUsageSection = typeof AccountUsageSection.Type;
export const UsageAccount = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: ProviderKind,
  displayName: TrimmedNonEmptyString,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  enabled: Schema.Boolean,
  refreshState: Schema.Literals(["idle", "queued", "refreshing"]),
  sections: Schema.Array(AccountUsageSection),
});
export type UsageAccount = typeof UsageAccount.Type;
export const UsageAccounts = Schema.Array(UsageAccount);
export type UsageAccounts = typeof UsageAccounts.Type;
