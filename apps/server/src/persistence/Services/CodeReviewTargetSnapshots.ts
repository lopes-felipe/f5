import {
  CodeReviewWorkflowId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const CodeReviewTargetFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  previousPath: Schema.NullOr(TrimmedNonEmptyString),
  status: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Head-side blob for pull requests; null for deleted files and workspace targets. */
  headBlobSha: Schema.NullOr(TrimmedNonEmptyString),
  patchAvailable: Schema.Boolean,
});
export type CodeReviewTargetFile = typeof CodeReviewTargetFile.Type;

export const CodeReviewTargetPullRequest = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: NonNegativeInt,
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  author: Schema.NullOr(Schema.String),
  baseRef: Schema.String,
  headRef: Schema.String,
  headRepository: Schema.NullOr(Schema.String),
});
export type CodeReviewTargetPullRequest = typeof CodeReviewTargetPullRequest.Type;

/**
 * The exact change a code review covers, captured once before reviewers start.
 * Both reviewers and every retry read this snapshot; a new review captures a
 * new one.
 */
export const CodeReviewTargetSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString,
  workflowId: CodeReviewWorkflowId,
  projectId: ProjectId,
  kind: Schema.Literals(["pull-request", "workspace"]),
  capturedAt: IsoDateTime,
  pullRequest: Schema.NullOr(CodeReviewTargetPullRequest),
  /** Workspace root the diff was captured from; null for pull requests. */
  workspaceRoot: Schema.NullOr(Schema.String),
  /** Configured comparison ref for workspace targets. */
  comparisonRef: Schema.NullOr(Schema.String),
  baseSha: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  /** The diff's left side: the merge base (pull requests, comparison refs) or HEAD. */
  mergeBaseSha: TrimmedNonEmptyString,
  files: Schema.Array(CodeReviewTargetFile),
  patch: Schema.String,
  /** How the diff was produced, stated for reviewers verbatim. */
  provenance: TrimmedNonEmptyString,
});
export type CodeReviewTargetSnapshot = typeof CodeReviewTargetSnapshot.Type;

export interface CodeReviewTargetSnapshotRepositoryShape {
  readonly upsert: (
    snapshot: CodeReviewTargetSnapshot,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByWorkflowId: (
    workflowId: CodeReviewWorkflowId,
  ) => Effect.Effect<Option.Option<CodeReviewTargetSnapshot>, ProjectionRepositoryError>;
  readonly getById: (
    snapshotId: string,
  ) => Effect.Effect<Option.Option<CodeReviewTargetSnapshot>, ProjectionRepositoryError>;
}

export class CodeReviewTargetSnapshotRepository extends ServiceMap.Service<
  CodeReviewTargetSnapshotRepository,
  CodeReviewTargetSnapshotRepositoryShape
>()("t3/persistence/Services/CodeReviewTargetSnapshots/CodeReviewTargetSnapshotRepository") {}
