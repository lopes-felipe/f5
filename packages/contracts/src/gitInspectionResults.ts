import { Schema } from "effect";
import { FilesystemPath, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ChangeRequest, SourceControlProviderIdentity } from "./sourceControl";

// Local Git inspection replies are not needed to encode startup RPC requests.
const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

const GitStatusPrState = Schema.Literals(["open", "closed", "merged"]);

const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);

export const GitBranch = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: FilesystemPath.pipe(Schema.NullOr),
});
export type GitBranch = typeof GitBranch.Type;

const GitWorktree = Schema.Struct({
  path: FilesystemPath,
  branch: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  headOid: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

const GitStatusPr = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  /** The pull request's head commit, when the host read reports it. */
  headOid: Schema.optionalKey(TrimmedNonEmptyStringSchema),
  state: GitStatusPrState,
});

export const GitStatusResult = Schema.Struct({
  sourceControl: Schema.optionalKey(SourceControlProviderIdentity),
  worktreeMissing: Schema.optionalKey(Schema.Boolean),
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: FilesystemPath,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
    countUnavailableReason: Schema.optionalKey(Schema.Literal("unborn_head")),
  }),
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  pr: Schema.NullOr(GitStatusPr),
  changeRequest: Schema.optionalKey(Schema.NullOr(ChangeRequest)),
});
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitListBranchesResult = Schema.Struct({
  worktreeMissing: Schema.optionalKey(Schema.Boolean),
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
  hasOriginRemote: Schema.Boolean,
});
export type GitListBranchesResult = typeof GitListBranchesResult.Type;

export const GitCreateWorktreeResult = Schema.Struct({
  worktree: GitWorktree,
});
export type GitCreateWorktreeResult = typeof GitCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  changeRequest: Schema.optional(ChangeRequest),
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  changeRequest: Schema.optional(ChangeRequest),
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: FilesystemPath.pipe(Schema.NullOr),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const GitPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyStringSchema,
  upstreamBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPullResult = typeof GitPullResult.Type;
