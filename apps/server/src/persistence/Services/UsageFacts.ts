import type { IsoDateTime, UsageTurnFact } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface UsageSummaryRangeInput {
  readonly startedAt: IsoDateTime;
  readonly endedAt: IsoDateTime;
}

export interface HourlyUsageFactSummary {
  readonly hourStartedAt: IsoDateTime;
  readonly provider: string;
  readonly model: string | null;
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
  readonly historicalCostTurnCount: number;
}

export interface UsageFactRepositoryShape {
  readonly record: (fact: UsageTurnFact) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly readCoverageStartedAt: Effect.Effect<IsoDateTime, ProjectionRepositoryError>;
  readonly summarizeHourly: (
    input: UsageSummaryRangeInput,
  ) => Effect.Effect<ReadonlyArray<HourlyUsageFactSummary>, ProjectionRepositoryError>;
}

export class UsageFactRepository extends ServiceMap.Service<
  UsageFactRepository,
  UsageFactRepositoryShape
>()("t3/persistence/Services/UsageFacts/UsageFactRepository") {}
