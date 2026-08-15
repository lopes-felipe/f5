import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlPullRequestRef = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type SourceControlPullRequestRef = typeof SourceControlPullRequestRef.Type;

export const SOURCE_CONTROL_PULL_REQUEST_ACTIONS = [
  "approve",
  "request-changes",
  "comment",
  "merge",
  "mark-ready",
  "request-reviewers",
  "update-branch",
  "edit-comment",
  "react",
  "change-reviewers",
] as const;
export const SourceControlPullRequestAction = Schema.Literals(SOURCE_CONTROL_PULL_REQUEST_ACTIONS);
export type SourceControlPullRequestAction = typeof SourceControlPullRequestAction.Type;

export const SourceControlCapability = Schema.Union([
  Schema.Struct({
    action: SourceControlPullRequestAction,
    supported: Schema.Literal(true),
  }),
  Schema.Struct({
    action: SourceControlPullRequestAction,
    supported: Schema.Literal(false),
    reason: TrimmedNonEmptyString,
  }),
]);
export type SourceControlCapability = typeof SourceControlCapability.Type;

export const SourceControlAuthStatus = Schema.Literals([
  "ok",
  "auth-required",
  "provider-missing",
  "rate-limited",
  "degraded",
  "error",
]);
export type SourceControlAuthStatus = typeof SourceControlAuthStatus.Type;

export const SourceControlRateLimit = Schema.Struct({
  remaining: Schema.optional(Schema.NullOr(NonNegativeInt)),
  limit: Schema.optional(Schema.NullOr(NonNegativeInt)),
  resetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  retryAfterSeconds: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type SourceControlRateLimit = typeof SourceControlRateLimit.Type;

export const SourceControlHostAuthState = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  status: SourceControlAuthStatus,
  viewerLogin: Schema.NullOr(TrimmedNonEmptyString),
  errorKind: Schema.optional(TrimmedNonEmptyString),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
  rateLimit: Schema.optional(SourceControlRateLimit),
});
export type SourceControlHostAuthState = typeof SourceControlHostAuthState.Type;

export const SourceControlPageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  rateLimit: Schema.optional(SourceControlRateLimit),
});
export type SourceControlPageInfo = typeof SourceControlPageInfo.Type;

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
