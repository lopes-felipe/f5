import { Schema } from "effect";
import { NonNegativeInt, ThreadId } from "./baseSchemas";
import { OrchestrationProposedPlan } from "./proposedPlan";

export const ThreadSearchInput = Schema.Struct({
  threadId: ThreadId,
  query: Schema.String.check(Schema.isMaxLength(512)),
  index: Schema.optional(NonNegativeInt),
});
export type ThreadSearchInput = typeof ThreadSearchInput.Type;
export const ThreadSearchResult = Schema.Struct({
  totalMatches: NonNegativeInt,
  activeIndex: NonNegativeInt,
  match: Schema.NullOr(
    Schema.Struct({
      entryId: Schema.String,
      kind: Schema.Literals(["message", "plan"]),
      occurrence: NonNegativeInt,
      snippet: Schema.String,
      plan: Schema.optional(OrchestrationProposedPlan),
    }),
  ),
});
export type ThreadSearchResult = typeof ThreadSearchResult.Type;
