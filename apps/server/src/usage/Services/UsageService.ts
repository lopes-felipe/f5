import type {
  ClaudeUsageAnalysis,
  UsageAnalyzeClaudeUsageInput,
  UsageConsumeResetCreditInput,
  UsageConsumeResetCreditResult,
  UsageGetAccountsInput,
  UsageAccounts,
  UsageGetSummaryInput,
  UsageGetThreadTurnsInput,
  UsageSummary,
  UsageThreadTurns,
  UsageQuotaHistory,
  ProviderInstanceId,
  UsageAccount,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export class UsageQueryError extends Schema.TaggedErrorClass<UsageQueryError>()("UsageQueryError", {
  message: Schema.String,
}) {}

export interface UsageServiceShape {
  readonly refreshAccount: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<
    { snapshot: UsageAccount | null; fresh: boolean; nextAllowedAt?: string },
    UsageQueryError
  >;
  readonly consumeResetCredit: (
    input: UsageConsumeResetCreditInput,
  ) => Effect.Effect<UsageConsumeResetCreditResult, UsageQueryError>;
  readonly getAccounts: (
    input: UsageGetAccountsInput,
  ) => Effect.Effect<UsageAccounts, UsageQueryError>;
  readonly getSummary: (
    input: UsageGetSummaryInput,
  ) => Effect.Effect<UsageSummary, ProjectionRepositoryError | UsageQueryError>;
  readonly getQuotaHistory: Effect.Effect<UsageQuotaHistory, UsageQueryError>;
  /** Claude Analyze usage: single-flight per instance, sharing the account-probe permits. */
  readonly analyzeClaudeUsage: (
    input: UsageAnalyzeClaudeUsageInput,
  ) => Effect.Effect<ClaudeUsageAnalysis, UsageQueryError>;
  readonly getThreadTurns: (
    input: UsageGetThreadTurnsInput,
  ) => Effect.Effect<UsageThreadTurns, UsageQueryError>;
}

export class UsageService extends ServiceMap.Service<UsageService, UsageServiceShape>()(
  "t3/usage/Services/UsageService",
) {}
