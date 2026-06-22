import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged", "draft", "unknown"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const SourceControlProviderIdentity = Schema.Struct({
  kind: SourceControlProviderKind,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  webUrl: Schema.optional(Schema.String),
  host: Schema.optional(TrimmedNonEmptyString),
  owner: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlProviderIdentity = typeof SourceControlProviderIdentity.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderIdentity,
  id: TrimmedNonEmptyString,
  displayNumber: TrimmedNonEmptyString,
  title: Schema.String,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.NullOr(Schema.String),
  isCrossRepository: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  headRepository: Schema.optional(Schema.String),
  baseRepository: Schema.optional(Schema.String),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const GitHubPullRequestNumber = PositiveInt;
export type GitHubPullRequestNumber = typeof GitHubPullRequestNumber.Type;
