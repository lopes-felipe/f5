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
  analyzeClaudeUsage: "usage.analyzeClaudeUsage",
  getThreadTurns: "usage.getThreadTurns",
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
  /** Immutable native identity captured at completion, independent of runtime projections. */
  nativeSessionId: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(IsoDateTime),
});
export type UsageTurnFact = typeof UsageTurnFact.Type;

/**
 * Usage of a Codex aside is recorded on its parent thread under a turn id with
 * this prefix. An aside is not a conversation turn.
 */
export const USAGE_ASIDE_TURN_ID_PREFIX = "aside:";

export function isAsideUsageTurnId(turnId: string): boolean {
  return turnId.startsWith(USAGE_ASIDE_TURN_ID_PREFIX);
}

/**
 * Whether a provider reports cache reads and writes outside its input token
 * count, Anthropic style. The others report cached input as part of input,
 * OpenAI style. Pi normalizes every model to the Anthropic split.
 */
export function providerReportsCacheOutsideInput(provider: string): boolean {
  return provider === "claudeAgent" || provider === "pi";
}

/** At most this many turns come back from `usage.getThreadTurns`, newest kept. */
export const USAGE_THREAD_TURNS_LIMIT = 500;

export const UsageGetThreadTurnsInput = Schema.Struct({
  threadId: ThreadId,
});
export type UsageGetThreadTurnsInput = typeof UsageGetThreadTurnsInput.Type;

/** One turn's recorded token counts; the per-turn prompt cache indicator reads these. */
export const UsageThreadTurn = Schema.Struct({
  turnId: TurnId,
  provider: ProviderKind,
  model: Schema.NullOr(TrimmedNonEmptyString),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteTokens: Schema.NullOr(NonNegativeInt),
  totalTokens: Schema.optional(Schema.NullOr(NonNegativeInt)),
  tokenProvenance: Schema.optional(UsageTokenProvenance),
  completedAt: IsoDateTime,
});
export type UsageThreadTurn = typeof UsageThreadTurn.Type;

/** A thread's newest conversation turns. Asides are left out. */
export const UsageThreadTurns = Schema.Struct({
  /** Oldest first. */
  turns: Schema.Array(UsageThreadTurn),
  /** The thread's first recorded turn, which may be older than `turns`. Null when none. */
  firstTurnId: Schema.NullOr(TurnId),
  /** Recorded turns older than the oldest one in `turns`. */
  earlierTurnCount: NonNegativeInt,
});
export type UsageThreadTurns = typeof UsageThreadTurns.Type;

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
  /** Also return the previous period's buckets, aligned by index, for comparison. */
  includePreviousBuckets: Schema.optional(Schema.Boolean),
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
  nativeInferenceCount: Schema.optional(NonNegativeInt),
  unpricedNativeInferenceCount: Schema.optional(NonNegativeInt),
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

export const UsagePreviousBucket = Schema.Struct({
  key: TrimmedNonEmptyString,
  startAt: IsoDateTime,
  metrics: UsageMetrics,
});
export type UsagePreviousBucket = typeof UsagePreviousBucket.Type;

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
  /** Enterprise monthly credit allowance; absent in snapshots stored before it was read. */
  individual: Schema.optional(Schema.NullOr(CodexAccountRateLimitWindow)),
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
  nativeHistoryError: Schema.optional(Schema.String),
  nativeHistoryStatus: Schema.optional(Schema.Literals(["idle", "refreshing", "ready", "error"])),
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
  /** The previous period's buckets, index-aligned with `buckets`; only when requested. */
  previousBuckets: Schema.optional(Schema.NullOr(Schema.Array(UsagePreviousBucket))).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type UsageSummary = typeof UsageSummary.Type;

export const UsageGetAccountsInput = Schema.Struct({
  refresh: Schema.optional(Schema.Literals(["if-stale", "force", "none"])),
  /** Restricts refreshing to this instance; the response still includes every account snapshot. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
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
/** Claude limit-reset grant ids, as the claim endpoint accepts them. */
export const ClaudeLimitResetGrantId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9_-]{1,40}$/),
);
/** One limit-reset grant on a Claude plan ("Full reset", "Fable reset", ...). */
export const ClaudeLimitResetGrant = Schema.Struct({
  id: ClaudeLimitResetGrantId,
  label: TrimmedNonEmptyString,
  kind: Schema.NullOr(Schema.Literals(["session", "weekly", "full"])),
  resetsLeft: NonNegativeInt,
  resetsTotal: NonNegativeInt,
  endsAt: Schema.NullOr(IsoDateTime),
  usableNow: Schema.Boolean,
  useRequiresLimit: Schema.Boolean,
  givesBackWeekly: Schema.Boolean,
  paused: Schema.Boolean,
  /** Claude limit keys this grant clears (`five_hour`, `seven_day`, ...). */
  clears: Schema.Array(TrimmedNonEmptyString),
  /** Limit keys that currently keep this grant from being used. */
  blocking: Schema.Array(TrimmedNonEmptyString),
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ClaudeLimitResetGrant = typeof ClaudeLimitResetGrant.Type;
export const ClaudeLimitResets = Schema.Struct({
  grants: Schema.Array(ClaudeLimitResetGrant),
  nextGrantId: Schema.NullOr(ClaudeLimitResetGrantId),
  cooldownUntil: Schema.NullOr(IsoDateTime),
});
export type ClaudeLimitResets = typeof ClaudeLimitResets.Type;
export const ClaudeAccountUsage = Schema.Struct({
  subscriptionLabel: Schema.NullOr(TrimmedNonEmptyString),
  limitsAvailable: Schema.Boolean,
  windows: Schema.Array(ClaudeAccountUsageWindow),
  extraUsage: Schema.NullOr(
    Schema.Struct({ enabled: Schema.Boolean, utilization: Schema.NullOr(NonNegativeNumber) }),
  ),
  /** Absent in snapshots stored before limit resets were read. */
  limitResets: Schema.optional(Schema.NullOr(ClaudeLimitResets)),
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
  /** Claude only: the limit-reset grant to claim. Defaults to the server's next grant. */
  grantId: Schema.optional(ClaudeLimitResetGrantId),
});
export type UsageConsumeResetCreditInput = typeof UsageConsumeResetCreditInput.Type;
export const UsageConsumeResetCreditResult = Schema.Struct({
  outcome: Schema.Literals([
    "reset",
    "nothingToReset",
    "noCredit",
    "alreadyRedeemed",
    "unavailable",
  ]),
  /** Why the reset could not be used, for the `unavailable` outcome. */
  message: Schema.optional(TrimmedNonEmptyString),
  /** When the reset can be tried again, formatted by the client. */
  retryAt: Schema.optional(IsoDateTime),
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

/** Monthly budget shown on the Usage page; it covers all providers and projects. */
export const UsageMonthlyBudget = Schema.Struct({
  costUsd: Schema.NullOr(NonNegativeNumber),
  tokens: Schema.NullOr(NonNegativeInt),
});
export type UsageMonthlyBudget = typeof UsageMonthlyBudget.Type;

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
/** One recommended change from Claude's local usage scan, largest share first. */
export const ClaudeUsageRecommendation = Schema.Struct({
  /** A behavior key, or `agent`/`skill`/`plugin`/`mcp_server` for a named source. */
  key: TrimmedNonEmptyString,
  /** Share of the weighted local usage this touches, 0-100. */
  pct: NonNegativeNumber,
  title: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ClaudeUsageRecommendation = typeof ClaudeUsageRecommendation.Type;
export const ClaudeUsageBehavior = Schema.Struct({
  /** Open set (`cache_miss`, `max_effort`, `workflow`, `large_tool_results`, ...). */
  key: TrimmedNonEmptyString,
  pct: NonNegativeNumber,
  count: NonNegativeInt,
});
export type ClaudeUsageBehavior = typeof ClaudeUsageBehavior.Type;
export const ClaudeUsageAnalysisWindow = Schema.Struct({
  requestCount: NonNegativeInt,
  sessionCount: NonNegativeInt,
  behaviors: Schema.Array(ClaudeUsageBehavior),
  recommendations: Schema.Array(ClaudeUsageRecommendation),
});
export type ClaudeUsageAnalysisWindow = typeof ClaudeUsageAnalysisWindow.Type;
/**
 * On-demand scan of this machine's Claude transcripts (approximate; other devices and
 * claude.ai are not included). Held in server memory only.
 */
export const ClaudeUsageAnalysis = Schema.Struct({
  analyzedAt: IsoDateTime,
  day: Schema.NullOr(ClaudeUsageAnalysisWindow),
  week: Schema.NullOr(ClaudeUsageAnalysisWindow),
});
export type ClaudeUsageAnalysis = typeof ClaudeUsageAnalysis.Type;
export const UsageAnalyzeClaudeUsageInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type UsageAnalyzeClaudeUsageInput = typeof UsageAnalyzeClaudeUsageInput.Type;

export const UsageAccount = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: ProviderKind,
  displayName: TrimmedNonEmptyString,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  enabled: Schema.Boolean,
  refreshState: Schema.Literals(["idle", "queued", "refreshing"]),
  sections: Schema.Array(AccountUsageSection),
  /** The latest Analyze usage result for a Claude account, when one ran this server run. */
  usageAnalysis: Schema.optional(ClaudeUsageAnalysis),
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
