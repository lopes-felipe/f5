import { Schema } from "effect";
import { IsoDateTime, makeEntityId, NonNegativeInt, ProjectId } from "./baseSchemas";
import {
  SourceControlCapability,
  SourceControlHostAuthState,
  SourceControlProviderKind,
  SourceControlPullRequestRef,
} from "./sourceControl";

export const PullRequestKey = makeEntityId("PullRequestKey");
export type PullRequestKey = typeof PullRequestKey.Type;

export const PrViewerRole = Schema.Literals([
  "author",
  "review_requested",
  "team_review_requested",
  "assignee",
  "mentioned",
  "involved",
]);
export type PrViewerRole = typeof PrViewerRole.Type;

export const PrAttentionBucket = Schema.Literals([
  "needs_you",
  "waiting_on_others",
  "informational",
]);
export type PrAttentionBucket = typeof PrAttentionBucket.Type;

export const PrAttentionState = Schema.Literals([
  "draft",
  "ci_failing",
  "merge_conflict",
  "branch_behind",
  "changes_requested",
  "review_requested",
  "re_review_requested",
  "ready_to_merge",
  "awaiting_review",
  "reviewed_waiting",
  "mentioned",
  "closed",
  "merged",
]);
export type PrAttentionState = typeof PrAttentionState.Type;

export const PrCheckRollup = Schema.Literals(["success", "failure", "pending", "error", "none"]);
export type PrCheckRollup = typeof PrCheckRollup.Type;

export const PrReviewDecision = Schema.Literals([
  "approved",
  "changes_requested",
  "review_required",
  "none",
]);
export type PrReviewDecision = typeof PrReviewDecision.Type;

export const PrMergeable = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PrMergeable = typeof PrMergeable.Type;

export const PrPullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PrPullRequestState = typeof PrPullRequestState.Type;

export const PrRepositoryRef = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  nameWithOwner: Schema.String,
});
export type PrRepositoryRef = typeof PrRepositoryRef.Type;

export const PrProviderDetails = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("github"),
    nodeId: Schema.NullOr(Schema.String),
    reviewDecision: PrReviewDecision,
    mergeStateStatus: Schema.String,
  }),
  Schema.Struct({
    provider: Schema.Literals(["gitlab", "azure-devops", "bitbucket", "unknown"]),
    externalId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);
export type PrProviderDetails = typeof PrProviderDetails.Type;

export const TrackedPullRequest = Schema.Struct({
  key: PullRequestKey,
  provider: SourceControlProviderKind.pipe(Schema.withDecodingDefault(() => "github" as const)),
  ref: Schema.optional(SourceControlPullRequestRef),
  capabilities: Schema.optional(Schema.Array(SourceControlCapability)),
  providerDetails: Schema.optional(PrProviderDetails),
  /** @deprecated Read providerDetails for provider-native identity. */
  nodeId: Schema.NullOr(Schema.String),
  number: NonNegativeInt,
  title: Schema.String,
  url: Schema.String,
  repository: PrRepositoryRef,
  host: Schema.String,
  author: Schema.NullOr(Schema.String),
  isDraft: Schema.Boolean,
  state: PrPullRequestState,
  roles: Schema.Array(PrViewerRole),
  attentionState: PrAttentionState,
  attentionBucket: PrAttentionBucket,
  primaryReason: Schema.String,
  nextAction: Schema.String,
  checkRollup: PrCheckRollup,
  reviewDecision: PrReviewDecision,
  mergeable: PrMergeable,
  mergeStateStatus: Schema.String,
  viewerHasReviewed: Schema.Boolean,
  viewerReviewRequested: Schema.Boolean,
  reviewRequestReviewers: Schema.Array(Schema.String),
  reviewRequestsCount: NonNegativeInt,
  commentsCount: NonNegativeInt,
  unresolvedThreadCount: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headRefOid: Schema.NullOr(Schema.String),
  baseRefName: Schema.NullOr(Schema.String),
  headRefName: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  ignoredAt: Schema.NullOr(IsoDateTime),
  notificationPending: Schema.Boolean,
  attentionFingerprint: Schema.String,
});
export type TrackedPullRequest = typeof TrackedPullRequest.Type;

export const PrHubStatus = Schema.Literals([
  "ok",
  "auth_required",
  "gh_missing",
  "degraded",
  "error",
]);
export type PrHubStatus = typeof PrHubStatus.Type;

export const PrHubSnapshot = Schema.Struct({
  status: PrHubStatus,
  viewerLogin: Schema.NullOr(Schema.String),
  host: Schema.String,
  authStates: Schema.optional(Schema.Array(SourceControlHostAuthState)),
  pullRequests: Schema.Array(TrackedPullRequest),
  recentlyResolved: Schema.Array(TrackedPullRequest),
  lastPolledAt: Schema.NullOr(IsoDateTime),
  errorKind: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  cappedBuckets: Schema.optional(Schema.Array(Schema.String)),
});
export type PrHubSnapshot = typeof PrHubSnapshot.Type;

export const PrHubRefreshInput = Schema.Struct({
  mode: Schema.Literals(["if_stale", "force"]),
});
export type PrHubRefreshInput = typeof PrHubRefreshInput.Type;

export const PrHubReviewInput = Schema.Struct({
  url: Schema.String,
  body: Schema.optional(Schema.String),
});
export type PrHubReviewInput = typeof PrHubReviewInput.Type;

export const PrHubCommentInput = Schema.Struct({
  url: Schema.String,
  body: Schema.String,
});
export type PrHubCommentInput = typeof PrHubCommentInput.Type;

export const PrHubRequestChangesInput = Schema.Struct({
  url: Schema.String,
  body: Schema.String,
});
export type PrHubRequestChangesInput = typeof PrHubRequestChangesInput.Type;

export const PrHubMergeInput = Schema.Struct({
  url: Schema.String,
  method: Schema.Literals(["squash", "merge", "rebase"]),
});
export type PrHubMergeInput = typeof PrHubMergeInput.Type;

export const PrHubReRequestInput = Schema.Struct({
  url: Schema.String,
  reviewers: Schema.optional(Schema.Array(Schema.String)),
});
export type PrHubReRequestInput = typeof PrHubReRequestInput.Type;

export const PrHubMarkReadyInput = Schema.Struct({
  url: Schema.String,
});
export type PrHubMarkReadyInput = typeof PrHubMarkReadyInput.Type;

export const PrHubSnoozeInput = Schema.Struct({
  key: PullRequestKey,
  until: IsoDateTime,
});
export type PrHubSnoozeInput = typeof PrHubSnoozeInput.Type;

export const PrHubUnsnoozeInput = Schema.Struct({
  key: PullRequestKey,
});
export type PrHubUnsnoozeInput = typeof PrHubUnsnoozeInput.Type;

export const PrHubIgnoreInput = Schema.Struct({
  key: PullRequestKey,
});
export type PrHubIgnoreInput = typeof PrHubIgnoreInput.Type;

export const PrHubMarkSeenInput = Schema.Struct({
  key: PullRequestKey,
  attentionFingerprint: Schema.String,
});
export type PrHubMarkSeenInput = typeof PrHubMarkSeenInput.Type;

export const PrHubMarkNotifiedInput = Schema.Struct({
  key: PullRequestKey,
  attentionFingerprint: Schema.String,
});
export type PrHubMarkNotifiedInput = typeof PrHubMarkNotifiedInput.Type;

export const PrHubLocalCandidatesInput = Schema.Struct({
  key: PullRequestKey,
});
export type PrHubLocalCandidatesInput = typeof PrHubLocalCandidatesInput.Type;

export const PrHubClearDataInput = Schema.Struct({});
export type PrHubClearDataInput = typeof PrHubClearDataInput.Type;

export const PrHubAdvisoryStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "stale",
]);
export type PrHubAdvisoryStatus = typeof PrHubAdvisoryStatus.Type;

export const PrHubAdvisoryRecommendation = Schema.Literals([
  "fix_ci",
  "wait_for_ci",
  "resolve_conflicts",
  "address_review_feedback",
  "clarify_feedback",
  "wait_for_reviewers",
  "re_request_review",
  "ready_to_merge",
  "review_requested",
  "no_action",
]);
export type PrHubAdvisoryRecommendation = typeof PrHubAdvisoryRecommendation.Type;

export const PrHubAdvisoryCommentValidity = Schema.Literals([
  "valid",
  "invalid",
  "unclear",
  "already_addressed",
  "needs_human_judgment",
]);
export type PrHubAdvisoryCommentValidity = typeof PrHubAdvisoryCommentValidity.Type;

export const PrHubAdvisoryCommentFinding = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(Schema.String),
  category: Schema.String,
  validity: PrHubAdvisoryCommentValidity,
  summary: Schema.String,
  rationale: Schema.String,
});
export type PrHubAdvisoryCommentFinding = typeof PrHubAdvisoryCommentFinding.Type;

export const PrHubAdvisory = Schema.Struct({
  key: PullRequestKey,
  status: PrHubAdvisoryStatus,
  recommendation: PrHubAdvisoryRecommendation,
  summary: Schema.String,
  confidence: NonNegativeInt,
  blockers: Schema.Array(Schema.String),
  findings: Schema.Array(PrHubAdvisoryCommentFinding),
  fingerprint: Schema.String,
  generatedAt: Schema.NullOr(IsoDateTime),
  stale: Schema.Boolean,
  degraded: Schema.Boolean,
  truncated: Schema.Boolean,
  errorKind: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});
export type PrHubAdvisory = typeof PrHubAdvisory.Type;

export const PrHubAdvisorySnapshot = Schema.Struct({
  viewerLogin: Schema.NullOr(Schema.String),
  host: Schema.String,
  advisories: Schema.Array(PrHubAdvisory),
});
export type PrHubAdvisorySnapshot = typeof PrHubAdvisorySnapshot.Type;

export const PrHubAnalyzeAdvisoriesInput = Schema.Struct({
  keys: Schema.optional(Schema.Array(PullRequestKey)),
  mode: Schema.optional(Schema.Literals(["stale_only", "force"])),
});
export type PrHubAnalyzeAdvisoriesInput = typeof PrHubAnalyzeAdvisoriesInput.Type;

export const PrHubGetAdvisoriesInput = Schema.Struct({
  keys: Schema.optional(Schema.Array(PullRequestKey)),
});
export type PrHubGetAdvisoriesInput = typeof PrHubGetAdvisoriesInput.Type;

export const PrHubLocalCheckoutCandidate = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  cwd: Schema.String,
  repository: PrRepositoryRef,
});
export type PrHubLocalCheckoutCandidate = typeof PrHubLocalCheckoutCandidate.Type;

export const PR_HUB_WS_METHODS = {
  getSnapshot: "prHub.getSnapshot",
  refresh: "prHub.refresh",
  approve: "prHub.approve",
  requestChanges: "prHub.requestChanges",
  comment: "prHub.comment",
  merge: "prHub.merge",
  markReady: "prHub.markReady",
  reRequestReview: "prHub.reRequestReview",
  snooze: "prHub.snooze",
  unsnooze: "prHub.unsnooze",
  ignore: "prHub.ignore",
  markSeen: "prHub.markSeen",
  markNotified: "prHub.markNotified",
  analyzeAdvisories: "prHub.analyzeAdvisories",
  getAdvisories: "prHub.getAdvisories",
  listLocalCheckoutCandidates: "prHub.listLocalCheckoutCandidates",
  clearData: "prHub.clearData",
} as const;

export const PR_HUB_WS_CHANNELS = {
  snapshotUpdated: "prHub.snapshotUpdated",
  advisoriesUpdated: "prHub.advisoriesUpdated",
} as const;
