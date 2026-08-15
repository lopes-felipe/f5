import type { UsageGetSummaryInput, UsageSummary } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export class UsageQueryError extends Schema.TaggedErrorClass<UsageQueryError>()("UsageQueryError", {
  message: Schema.String,
}) {}

export interface UsageServiceShape {
  readonly getSummary: (
    input: UsageGetSummaryInput,
  ) => Effect.Effect<UsageSummary, ProjectionRepositoryError | UsageQueryError>;
}

export class UsageService extends ServiceMap.Service<UsageService, UsageServiceShape>()(
  "t3/usage/Services/UsageService",
) {}
