import type { IsoDateTime, ProjectId, ProviderKind, UsageTurnFact } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface UsageSummaryRangeInput {
  readonly provider?: ProviderKind;
  /** Providers left out of every total. */
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly startedAt: IsoDateTime;
  readonly endedAt: IsoDateTime;
}

export interface UsageBucketRange {
  readonly key: string;
  /** Inclusive. */
  readonly startAt: IsoDateTime;
  /** Exclusive. */
  readonly endAt: IsoDateTime;
}

export interface UsageBucketSummaryInput {
  readonly buckets: ReadonlyArray<UsageBucketRange>;
  readonly provider?: ProviderKind;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly projectId?: ProjectId;
}

/**
 * One aggregated partition of facts or legacy cost events. Rows are grouped by
 * provider, model, and the pricing and known-total partitions, so a row with
 * `totalTokenTurnCount > 0` has a known total for every turn it covers.
 */
export interface UsageAggregateRow {
  readonly provider: string;
  readonly model: string | null;
  readonly estimationEligibleTurnCount?: number;
  readonly estimatedCostUsd?: number;
  readonly turnCount: number;
  readonly reportedTokenTurnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly providerReportedCostUsd: number | null;
  readonly pricedTurnCount: number;
  readonly unpricedTurnCount: number;
  /** Modern usage facts. */
  readonly recordedTurnCount: number;
  /** Pre-cutover cost-bearing session events; these are not turns. */
  readonly legacyCostEventCount: number;
  readonly inputTokenTurnCount: number;
  readonly outputTokenTurnCount: number;
  readonly cacheReadTokenTurnCount: number;
  readonly cacheWriteTokenTurnCount: number;
  readonly totalTokenTurnCount: number;
}

export interface BucketUsageSummaryRow extends UsageAggregateRow {
  readonly bucketKey: string;
}

export interface ScopeUsageSummaryRow extends UsageAggregateRow {
  readonly threadId: string | null;
  readonly projectId: string | null;
}

export interface UsageMetadata {
  readonly coverageStartedAt: IsoDateTime;
  readonly factCutoverAt: IsoDateTime;
}

export interface UsageScopeTitle {
  readonly id: string;
  readonly title: string | null;
  readonly deleted: boolean;
  readonly projectId?: string | null;
}

export interface UsageScopeTitles {
  readonly threads: ReadonlyArray<UsageScopeTitle>;
  readonly projects: ReadonlyArray<UsageScopeTitle>;
}

export interface UsageFactRepositoryShape {
  readonly record: (fact: UsageTurnFact) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly readCoverageStartedAt: Effect.Effect<IsoDateTime, ProjectionRepositoryError>;
  readonly readUsageMetadata: Effect.Effect<UsageMetadata, ProjectionRepositoryError>;
  readonly summarizeBuckets: (
    input: UsageBucketSummaryInput,
  ) => Effect.Effect<ReadonlyArray<BucketUsageSummaryRow>, ProjectionRepositoryError>;
  /** Per-thread rows for the window; deliberately ignores any project filter. */
  readonly summarizeByScope: (
    input: UsageSummaryRangeInput,
  ) => Effect.Effect<ReadonlyArray<ScopeUsageSummaryRow>, ProjectionRepositoryError>;
  /** Missing rows are reported as deleted with a null title. */
  readonly readScopeTitles: (input: {
    readonly threadIds: ReadonlyArray<string>;
    readonly projectIds: ReadonlyArray<string>;
  }) => Effect.Effect<UsageScopeTitles, ProjectionRepositoryError>;
}

export class UsageFactRepository extends ServiceMap.Service<
  UsageFactRepository,
  UsageFactRepositoryShape
>()("t3/persistence/Services/UsageFacts/UsageFactRepository") {}
