import { Schema } from "effect";

import {
  IsoDateTime,
  MessageId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { OrchestrationFileChangeId } from "./orchestration";
import { ProviderInstanceId } from "./providerInstance";

export const GlobalSearchResultKind = Schema.Literals([
  "thread",
  "message",
  "activity",
  "fileChange",
  "workflow.planning",
  "workflow.codeReview",
  "workflow.investigation",
]);
export type GlobalSearchResultKind = typeof GlobalSearchResultKind.Type;

export const GlobalSearchQueryInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(TrimmedNonEmptyString),
  dateFrom: Schema.optional(IsoDateTime),
  dateTo: Schema.optional(IsoDateTime),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type GlobalSearchQueryInput = typeof GlobalSearchQueryInput.Type;

export const GlobalSearchResult = Schema.Struct({
  documentKey: TrimmedNonEmptyString,
  kind: GlobalSearchResultKind,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  workflowId: Schema.NullOr(TrimmedNonEmptyString),
  messageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  fileChangeId: Schema.NullOr(OrchestrationFileChangeId),
  title: TrimmedNonEmptyString,
  snippet: Schema.String,
  path: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  rank: Schema.Number,
});
export type GlobalSearchResult = typeof GlobalSearchResult.Type;

export const GlobalSearchQueryResult = Schema.Struct({
  results: Schema.Array(GlobalSearchResult),
});
export type GlobalSearchQueryResult = typeof GlobalSearchQueryResult.Type;
