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

export const UsageBucket = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  startAt: IsoDateTime,
  metrics: UsageMetrics,
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
