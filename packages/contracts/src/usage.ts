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
  consumeResetCredit: "usage.consumeResetCredit",
  getQuotaHistory: "usage.getQuotaHistory",
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

const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

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

/**
 * Exact model ID to the model its usage counts as, such as a preview slug to
 * its released name. A mapped model is reported and priced as its target.
 */
export const UsageModelAliases = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
);
export type UsageModelAliases = typeof UsageModelAliases.Type;

export const UsageGetSummaryInput = Schema.Struct({
  range: UsageRange,
  provider: Schema.optional(ProviderKind),
  /** Providers left out of every total; the Usage page's provider filter. */
  hiddenProviders: Schema.optional(Schema.Array(ProviderKind).check(Schema.isMaxLength(32))),
  projectId: Schema.optional(ProjectId),
  timeZone: TrimmedNonEmptyString,
});
export type UsageGetSummaryInput = typeof UsageGetSummaryInput.Type;

/**
 * Per-field reporting coverage. Counts come from the persisted nullable
 * columns, so a reported zero counts as present.
 */
export const UsageFieldReporting = Schema.Struct({
  recordedTurnCount: NonNegativeInt,
  legacyCostEventCount: NonNegativeInt,
  inputTokenTurnCount: NonNegativeInt,
  outputTokenTurnCount: NonNegativeInt,
  cacheReadTokenTurnCount: NonNegativeInt,
  cacheWriteTokenTurnCount: NonNegativeInt,
  totalTokenTurnCount: NonNegativeInt,
});
export type UsageFieldReporting = typeof UsageFieldReporting.Type;

export const UsageMetrics = Schema.Struct({
  turnCount: NonNegativeInt,
  reportedTokenTurnCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  providerReportedCostUsd: Schema.NullOr(NonNegativeNumber),
  estimatedCostUsd: Schema.optional(Schema.NullOr(NonNegativeNumber)),
  pricedTurnCount: NonNegativeInt,
  unpricedTurnCount: NonNegativeInt,
  reporting: Schema.optional(Schema.NullOr(UsageFieldReporting)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  endAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(Schema.withDecodingDefault(() => null)),
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

export const UsageProjectBreakdown = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  title: Schema.NullOr(TrimmedNonEmptyString),
  deleted: Schema.Boolean,
  metrics: UsageMetrics,
});
export type UsageProjectBreakdown = typeof UsageProjectBreakdown.Type;

export const UsageThreadBreakdown = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.NullOr(TrimmedNonEmptyString),
  deleted: Schema.Boolean,
  metrics: UsageMetrics,
});
export type UsageThreadBreakdown = typeof UsageThreadBreakdown.Type;

export const UsageProjectScope = Schema.Struct({
  selectedProjectId: Schema.NullOr(ProjectId),
  /** Every project with data in the range and provider; ignores the project filter. */
  byProject: Schema.Array(UsageProjectBreakdown),
  /** Top threads, filtered to the selected project. */
  topThreads: Schema.Array(UsageThreadBreakdown),
  threadCount: NonNegativeInt,
});
export type UsageProjectScope = typeof UsageProjectScope.Type;

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
  nextBucketAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  projectScope: Schema.optional(Schema.NullOr(UsageProjectScope)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  previousMetrics: Schema.optional(Schema.NullOr(UsageMetrics)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
export const ProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: NonNegativeNumber,
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type;
export const UsageResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.NullOr(IsoDateTime),
});
export const UsageConsumeResetCreditInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type UsageConsumeResetCreditInput = typeof UsageConsumeResetCreditInput.Type;
export const UsageConsumeResetCreditResult = Schema.Struct({
  outcome: Schema.Literals(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]),
});
export type UsageConsumeResetCreditResult = typeof UsageConsumeResetCreditResult.Type;
export const UsagePriceOverride = Schema.Struct({
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  inputUsdPerMillion: NonNegativeNumber,
  outputUsdPerMillion: NonNegativeNumber,
  cacheReadUsdPerMillion: Schema.NullOr(NonNegativeNumber),
  cacheWriteUsdPerMillion: Schema.NullOr(NonNegativeNumber),
});
export type UsagePriceOverride = typeof UsagePriceOverride.Type;

export const AccountUsageSection = Schema.Union([
  Schema.Struct({
    ...sectionState,
    kind: Schema.Literal("provider-limits"),
    snapshot: Schema.NullOr(
      Schema.Struct({
        fetchedAt: IsoDateTime,
        data: Schema.Struct({ windows: Schema.Array(ProviderUsageWindow) }),
      }),
    ),
  }),
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
        data: Schema.Struct({
          rateLimits: Schema.Array(CodexAccountRateLimit),
          resetCredits: Schema.optional(Schema.NullOr(UsageResetCredits)),
        }),
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

export const UsageQuotaSample = Schema.Struct({
  at: IsoDateTime,
  usedPercent: NonNegativeNumber,
});
export type UsageQuotaSample = typeof UsageQuotaSample.Type;
export const UsageQuotaSeries = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  windowKey: TrimmedNonEmptyString,
  resetsAt: IsoDateTime,
  samples: Schema.Array(UsageQuotaSample),
});
export type UsageQuotaSeries = typeof UsageQuotaSeries.Type;
export const UsageQuotaHistory = Schema.Struct({
  generatedAt: IsoDateTime,
  series: Schema.Array(UsageQuotaSeries),
});
export type UsageQuotaHistory = typeof UsageQuotaHistory.Type;
export const UsageGetQuotaHistoryInput = Schema.Struct({});
export type UsageGetQuotaHistoryInput = typeof UsageGetQuotaHistoryInput.Type;
