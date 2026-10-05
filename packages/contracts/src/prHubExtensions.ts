import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ForgeAction, SourceControlProviderKind } from "./sourceControl";
import { PullRequestKey } from "./prHub";
import { ThreadPullRequestLink } from "./orchestration";

export const ForgeAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  login: TrimmedNonEmptyString,
  viewerId: Schema.String,
  generation: Schema.String,
});
export type ForgeAccount = typeof ForgeAccount.Type;
export const ForgeAccountInput = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(16384)),
  organization: Schema.optional(TrimmedNonEmptyString),
});
export type ForgeAccountInput = typeof ForgeAccountInput.Type;
export const ForgeAccountRouting = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
});
export type ForgeAccountRouting = typeof ForgeAccountRouting.Type;
export const PrHubAccountInput = Schema.Struct({ accountId: Schema.optional(Schema.String) });
export const PrHubPeekInput = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(4096)),
  accountId: Schema.optional(Schema.String),
});
export type PrHubPeekInput = typeof PrHubPeekInput.Type;
export const PrHubPeek = Schema.Struct({
  provider: SourceControlProviderKind,
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  author: Schema.NullOr(Schema.String),
});
export type PrHubPeek = typeof PrHubPeek.Type;
export const PrHubStackInput = Schema.Struct({
  key: PullRequestKey,
  accountGeneration: Schema.optional(Schema.String),
});
export type PrHubStackInput = typeof PrHubStackInput.Type;
export const PrHubStackLayer = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  headOid: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  baseRef: Schema.String,
  headRef: Schema.String,
});
export const PrHubStack = Schema.Struct({
  number: Schema.Int,
  fingerprint: Schema.String,
  layers: Schema.Array(PrHubStackLayer),
});
export type PrHubStack = typeof PrHubStack.Type;
export const PrHubStackActionInput = Schema.Struct({
  ...PrHubStackInput.fields,
  fingerprint: Schema.String,
  action: Schema.Literals(["merge", "rebase"]),
  method: Schema.Literals(["merge", "squash", "rebase"]),
  operationId: Schema.String,
});
export type PrHubStackActionInput = typeof PrHubStackActionInput.Type;
export const PrHubViewedFilesInput = Schema.Struct({
  key: PullRequestKey,
  accountGeneration: Schema.optional(Schema.String),
  headOid: Schema.String,
  baseOid: Schema.String,
});
export type PrHubViewedFilesInput = typeof PrHubViewedFilesInput.Type;
export const PrHubSetViewedFileInput = Schema.Struct({
  ...PrHubViewedFilesInput.fields,
  path: Schema.String.check(Schema.isMaxLength(4096)),
  viewed: Schema.Boolean,
});
export type PrHubSetViewedFileInput = typeof PrHubSetViewedFileInput.Type;
export const PrHubThreadLinksInput = Schema.Struct({ threadId: ThreadId });
export const PrHubThreadLinks = Schema.Array(ThreadPullRequestLink);
export const PrHubThreadsForPrInput = Schema.Struct({ key: PullRequestKey });
export const PrHubThreadsForPr = Schema.Array(
  Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
  }),
);

export const ForgeMutationPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stack"),
    action: Schema.Literals(["merge", "rebase"]),
    method: Schema.Literals(["merge", "squash", "rebase"]),
    fingerprint: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("action"),
    action: ForgeAction,
    method: Schema.optional(Schema.Literals(["merge", "squash", "rebase"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("comment"),
    body: Schema.String.check(Schema.isMaxLength(64000)),
    path: Schema.optional(Schema.String),
    line: Schema.optional(Schema.Int),
    side: Schema.optional(Schema.Literals(["old", "new"])),
    baseOid: Schema.optional(Schema.String),
    replyTo: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    body: Schema.String.check(Schema.isMaxLength(64000)),
    verdict: Schema.Literals(["comment", "approve", "request-changes"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    title: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String.check(Schema.isMaxLength(64000))),
  }),
  Schema.Struct({
    kind: Schema.Literal("reviewers"),
    reviewers: Schema.Array(Schema.String).check(Schema.isMaxLength(50)),
  }),
  Schema.Struct({
    kind: Schema.Literal("labels"),
    labels: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    kind: Schema.Literal("reaction"),
    commentId: Schema.optional(Schema.String),
    content: Schema.String,
    remove: Schema.optional(Schema.Boolean),
    reactionId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-state"),
    threadId: Schema.String,
    resolved: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("edit-comment"),
    commentId: Schema.String,
    body: Schema.String.check(Schema.isMaxLength(64000)),
  }),
]);
export type ForgeMutationPayload = typeof ForgeMutationPayload.Type;
export const ForgePrepareOperationInput = Schema.Struct({
  key: PullRequestKey,
  accountGeneration: Schema.String,
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  expectedHeadOid: Schema.String,
  payload: ForgeMutationPayload,
});
export type ForgePrepareOperationInput = typeof ForgePrepareOperationInput.Type;
export const ForgeOperationInput = Schema.Struct({
  key: PullRequestKey,
  accountGeneration: Schema.String,
  operationId: Schema.String,
});
export type ForgeOperationInput = typeof ForgeOperationInput.Type;
export const ForgeOperation = Schema.Struct({
  ...ForgePrepareOperationInput.fields,
  status: Schema.Literals([
    "prepared",
    "running",
    "succeeded",
    "failed",
    "outcome_unknown",
    "canceled",
  ]),
  error: Schema.optional(Schema.String),
});
export type ForgeOperation = typeof ForgeOperation.Type;
