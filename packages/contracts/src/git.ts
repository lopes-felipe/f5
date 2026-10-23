import { FilesystemPath } from "./baseSchemas";
import { Option, Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model";
export * from "./gitInspectionResults";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

// Domain Types

export const GitStackedAction = Schema.Literals(["commit", "commit_push", "commit_push_pr"]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = /* @__PURE__ */ Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals(["created", "skipped_no_changes", "context_changed"]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);

// RPC Inputs

export const GitStatusInput = Schema.Struct({
  cwd: FilesystemPath,
  /** false skips the stale-upstream fetch; passive callers such as sidebar rows read local state. */
  includeRemote: Schema.optionalKey(Schema.Boolean),
});
export type GitStatusInput = typeof GitStatusInput.Type;

export const GitPullInput = Schema.Struct({
  cwd: FilesystemPath,
});
export type GitPullInput = typeof GitPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  actionId: Schema.optional(TrimmedNonEmptyStringSchema),
  cwd: FilesystemPath,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(Schema.Array(FilesystemPath).check(Schema.isMinLength(1))),
  textGenerationModel: Schema.optional(TrimmedNonEmptyStringSchema).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_GIT_TEXT_GENERATION_MODEL)),
  ),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitListBranchesInput = Schema.Struct({
  cwd: FilesystemPath,
});
export type GitListBranchesInput = typeof GitListBranchesInput.Type;

export const GitCreateWorktreeInput = Schema.Struct({
  cwd: FilesystemPath,
  branch: TrimmedNonEmptyStringSchema,
  baseRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  newBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(FilesystemPath),
});
export type GitCreateWorktreeInput = typeof GitCreateWorktreeInput.Type;

export const GitPrepareWorktreeInput = Schema.Struct({
  runSetupScript: Schema.optional(Schema.Boolean),
  setupIdentity: Schema.optional(Schema.NullOr(Schema.String)),
  retryAcknowledged: Schema.optional(Schema.Boolean),
  cwd: FilesystemPath,
  branch: TrimmedNonEmptyStringSchema,
  newBranch: TrimmedNonEmptyStringSchema,
  threadId: ThreadId,
  projectCwd: FilesystemPath,
});
export type GitPrepareWorktreeInput = typeof GitPrepareWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: FilesystemPath,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  cwd: FilesystemPath,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  expectedHeadOid: Schema.optional(TrimmedNonEmptyStringSchema),
  /** `false` skips the project's setup script in a new worktree. Defaults to running it. */
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const GitRemoveWorktreeInput = Schema.Struct({
  cwd: FilesystemPath,
  path: FilesystemPath,
});
export type GitRemoveWorktreeInput = typeof GitRemoveWorktreeInput.Type;

export const GitCreateBranchInput = Schema.Struct({
  cwd: FilesystemPath,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCreateBranchInput = typeof GitCreateBranchInput.Type;

export const GitCheckoutInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  operationId: Schema.optional(Schema.String),
  cwd: FilesystemPath,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCheckoutInput = typeof GitCheckoutInput.Type;

export const GitCheckoutConflict = Schema.Struct({
  cwd: FilesystemPath,
  branch: TrimmedNonEmptyStringSchema,
  files: Schema.Array(Schema.String),
});
export type GitCheckoutConflict = typeof GitCheckoutConflict.Type;

export const GitInitInput = Schema.Struct({
  cwd: FilesystemPath,
});
export type GitInitInput = typeof GitInitInput.Type;

// RPC Results

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
    suggestedMessage: Schema.optional(Schema.String),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitStatusInvalidatedPayload = Schema.Struct({
  cwd: Schema.NullOr(FilesystemPath),
});
export type GitStatusInvalidatedPayload = typeof GitStatusInvalidatedPayload.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: FilesystemPath,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
