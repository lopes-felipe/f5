import { Schema, Struct } from "effect";
import { IsoDateTime, makeEntityId, NonNegativeInt, ProjectId } from "./baseSchemas";
import {
  SourceControlCapability,
  SourceControlHostAuthState,
  SourceControlPageInfo,
  SourceControlProviderKind,
  SourceControlPullRequestRef,
  SourceControlRateLimit,
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
  "unresolved_comments",
  "changes_pushed",
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

export const PrAttentionReason = Schema.Struct({
  code: Schema.Union([
    PrAttentionState,
    Schema.Literals([
      "merge_calculating",
      "merge_blocked",
      "merge_permission",
      "ci_pending",
      "repository_archived",
    ]),
  ]),
  actor: Schema.Literals(["viewer", "author", "reviewer", "ci", "policy", "unknown"]),
  evidence: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
  firstObservedAt: IsoDateTime,
  action: Schema.Literals(["fix", "review", "merge", "wait", "finish", "none"]),
  verification: Schema.Literals(["verified", "unverified"]),
});
export type PrAttentionReason = typeof PrAttentionReason.Type;

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
  repositoryArchived: Schema.optional(Schema.Boolean),
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
  reasons: Schema.optional(Schema.Array(PrAttentionReason)),
  manuallyTracked: Schema.optional(Schema.Boolean),
  attentionBucket: PrAttentionBucket,
  primaryReason: Schema.String,
  nextAction: Schema.String,
  checkRollup: PrCheckRollup,
  reviewDecision: PrReviewDecision,
  mergeable: PrMergeable,
  mergeStateStatus: Schema.String,
  mergePermission: Schema.optional(Schema.Literals(["allowed", "denied", "unknown"])),
  viewerHasReviewed: Schema.Boolean,
  viewerReviewRequested: Schema.Boolean,
  reviewRequestReviewers: Schema.Array(Schema.String),
  reviewRequestsCount: NonNegativeInt,
  commentsCount: NonNegativeInt,
  unresolvedThreadCount: NonNegativeInt,
  actionableUnresolvedThreadCount: NonNegativeInt,
  reviewFactsComplete: Schema.optional(Schema.Boolean),
  waitingSince: Schema.NullOr(IsoDateTime),
  lastVerifiedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
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

export const PrHubAccount = Schema.Struct({
  host: Schema.String,
  viewerId: NonNegativeInt,
  login: Schema.String,
  generation: Schema.String,
});
export type PrHubAccount = typeof PrHubAccount.Type;

export const PrHubCoverage = Schema.Struct({
  generation: Schema.optional(Schema.String),
  scope: Schema.Literals([
    "known_repositories",
    "global_relationship_search",
    "previously_tracked",
    "notification_subjects",
  ]),
  status: Schema.Literals(["not_scanned", "partial", "complete"]),
  description: Schema.String,
  remainingTasks: Schema.optional(NonNegativeInt),
  checkedAt: Schema.optional(IsoDateTime),
  limits: Schema.optional(Schema.Array(Schema.String)),
});
export const PrHubSchedulerState = Schema.Struct({
  retryAt: Schema.NullOr(IsoDateTime),
  activeOrQueuedRequests: NonNegativeInt,
  resources: Schema.Array(
    Schema.Struct({
      resource: Schema.Literals(["rest", "search", "graphql"]),
      used: NonNegativeInt,
      windowLimit: NonNegativeInt,
      remaining: Schema.NullOr(NonNegativeInt),
      resetAt: Schema.NullOr(IsoDateTime),
      resumeAt: Schema.NullOr(IsoDateTime),
    }),
  ),
});
export type PrHubSchedulerState = typeof PrHubSchedulerState.Type;
export const PrHubSnapshot = Schema.Struct({
  scheduler: Schema.optional(PrHubSchedulerState),
  coverage: Schema.optional(Schema.Array(PrHubCoverage)),
  revision: Schema.optional(Schema.String),
  account: Schema.optional(PrHubAccount),
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

export const PrHubListFilter = Schema.Literals([
  "all",
  "needs_you",
  "authored",
  "reviews",
  "unresolved_comments",
  "stalled",
  "needs_my_review",
  "my_prs_need_action",
  "waiting",
  "ready_to_merge",
  "ci_failing",
  "draft",
  "mentioned",
  "snoozed",
  "ignored",
  "recently_resolved",
  "notification_pending",
]);
export type PrHubListFilter = typeof PrHubListFilter.Type;
export const PrHubOverviewInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  stalledBefore: Schema.optional(IsoDateTime),
});
export type PrHubOverviewInput = typeof PrHubOverviewInput.Type;
export const PrHubListInput = Schema.Struct({
  ...PrHubOverviewInput.fields,
  filter: Schema.optional(PrHubListFilter),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  repository: Schema.optional(Schema.String),
  relationship: Schema.optional(PrViewerRole),
  ci: Schema.optional(PrCheckRollup),
  visibility: Schema.optional(Schema.Literals(["active", "snoozed", "ignored", "resolved", "any"])),
  lifecycle: Schema.optional(Schema.Literals(["open", "closed", "merged"])),
  sort: Schema.optional(Schema.Literals(["priority", "updated"])),
  key: Schema.optional(PullRequestKey),
  anchorKey: Schema.optional(PullRequestKey),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type PrHubListInput = typeof PrHubListInput.Type;
export const PrHubOverview = Schema.Struct({
  ...Struct.omit(PrHubSnapshot.fields, ["pullRequests", "recentlyResolved", "cappedBuckets"]),
  revision: Schema.String,
  counts: Schema.Record(PrHubListFilter, NonNegativeInt),
  coverage: Schema.Array(PrHubCoverage),
});
export type PrHubOverview = typeof PrHubOverview.Type;
export const PrHubListPage = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  revision: Schema.String,
  status: Schema.Literals(["ok", "cursor_stale"]),
  pullRequests: Schema.Array(TrackedPullRequest).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(Schema.String),
});
export type PrHubListPage = typeof PrHubListPage.Type;
export const PrHubChanged = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  revision: Schema.String,
  changedKeys: Schema.Array(PullRequestKey).check(Schema.isMaxLength(500)),
  removedKeys: Schema.Array(PullRequestKey).check(Schema.isMaxLength(500)),
  counts: Schema.Record(PrHubListFilter, NonNegativeInt),
  resyncRequired: Schema.Boolean,
});
export type PrHubChanged = typeof PrHubChanged.Type;

export const PrHubClaimNotificationsInput = Schema.Struct({
  accountGeneration: Schema.String,
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  maxItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
});
export type PrHubClaimNotificationsInput = typeof PrHubClaimNotificationsInput.Type;
export const PrHubNotificationBatch = Schema.Struct({
  accountGeneration: Schema.String,
  batchId: Schema.String,
  expiresAt: IsoDateTime,
  pullRequests: Schema.Array(TrackedPullRequest).check(Schema.isMaxLength(20)),
});
export type PrHubNotificationBatch = typeof PrHubNotificationBatch.Type;
export const PrHubAcknowledgeNotificationsInput = Schema.Struct({
  accountGeneration: Schema.String,
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  batchId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type PrHubAcknowledgeNotificationsInput = typeof PrHubAcknowledgeNotificationsInput.Type;

export const PrHubRefreshInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  mode: Schema.Literals(["if_stale", "force"]),
});
export type PrHubRefreshInput = typeof PrHubRefreshInput.Type;

export const PrHubTrackInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String.check(Schema.isMaxLength(4096)),
});
export type PrHubTrackInput = typeof PrHubTrackInput.Type;

export const PrHubReviewInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String,
  body: Schema.optional(Schema.String),
});
export type PrHubReviewInput = typeof PrHubReviewInput.Type;

export const PrHubCommentInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String,
  body: Schema.String,
});
export type PrHubCommentInput = typeof PrHubCommentInput.Type;

export const PrHubRequestChangesInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String,
  body: Schema.String,
});
export type PrHubRequestChangesInput = typeof PrHubRequestChangesInput.Type;

export const PrHubMergeInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String,
  expectedComparison: Schema.optional(Schema.suspend(() => PrHubComparisonIdentity)),
  method: Schema.Literals(["squash", "merge", "rebase"]),
});
export type PrHubMergeInput = typeof PrHubMergeInput.Type;

export const PrHubReRequestInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String,
  reviewers: Schema.optional(Schema.Array(Schema.String)),
});
export type PrHubReRequestInput = typeof PrHubReRequestInput.Type;

export const PrHubMarkReadyInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  url: Schema.String,
});
export type PrHubMarkReadyInput = typeof PrHubMarkReadyInput.Type;

export const PrHubSnoozeInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  until: IsoDateTime,
});
export type PrHubSnoozeInput = typeof PrHubSnoozeInput.Type;

export const PrHubUnsnoozeInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
});
export type PrHubUnsnoozeInput = typeof PrHubUnsnoozeInput.Type;

export const PrHubIgnoreInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
});
export type PrHubIgnoreInput = typeof PrHubIgnoreInput.Type;

export const PrHubMarkSeenInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  attentionFingerprint: Schema.String,
});
export type PrHubMarkSeenInput = typeof PrHubMarkSeenInput.Type;

export const PrHubMarkNotifiedInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  attentionFingerprint: Schema.String,
});
export type PrHubMarkNotifiedInput = typeof PrHubMarkNotifiedInput.Type;

export const PrHubLocalCandidatesInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
});
export type PrHubLocalCandidatesInput = typeof PrHubLocalCandidatesInput.Type;

export const PrHubClearDataInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
});
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
  accountGeneration: Schema.optional(Schema.String),
  viewerLogin: Schema.NullOr(Schema.String),
  host: Schema.String,
  advisories: Schema.Array(PrHubAdvisory),
});
export type PrHubAdvisorySnapshot = typeof PrHubAdvisorySnapshot.Type;

export const PrHubAdvisoriesChanged = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  keys: Schema.Array(PullRequestKey).check(Schema.isMaxLength(500)),
  resyncRequired: Schema.Boolean,
});
export type PrHubAdvisoriesChanged = typeof PrHubAdvisoriesChanged.Type;

export const PrHubAnalyzeAdvisoriesInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  keys: Schema.optional(Schema.Array(PullRequestKey).check(Schema.isMaxLength(100))),
  mode: Schema.optional(Schema.Literals(["stale_only", "force"])),
});
export type PrHubAnalyzeAdvisoriesInput = typeof PrHubAnalyzeAdvisoriesInput.Type;

export const PrHubGetAdvisoriesInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  keys: Schema.optional(Schema.Array(PullRequestKey).check(Schema.isMaxLength(100))),
});
export type PrHubGetAdvisoriesInput = typeof PrHubGetAdvisoriesInput.Type;

export const PrHubLocalCheckoutCandidate = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  cwd: Schema.String,
  repository: PrRepositoryRef,
});
export type PrHubLocalCheckoutCandidate = typeof PrHubLocalCheckoutCandidate.Type;

export const PrHubActor = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PrHubActor = typeof PrHubActor.Type;

export const PrHubLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
});
export type PrHubLabel = typeof PrHubLabel.Type;

export const PrHubReactionContent = Schema.Literals([
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type PrHubReactionContent = typeof PrHubReactionContent.Type;

export const PrHubReaction = Schema.Struct({
  content: PrHubReactionContent,
  count: NonNegativeInt,
  viewerHasReacted: Schema.Boolean,
  actors: Schema.Array(Schema.String),
});
export type PrHubReaction = typeof PrHubReaction.Type;

export const PrHubCheckStatus = Schema.Literals([
  "pending",
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
]);
export type PrHubCheckStatus = typeof PrHubCheckStatus.Type;

export const PrHubCheck = Schema.Struct({
  name: Schema.String,
  status: PrHubCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type PrHubCheck = typeof PrHubCheck.Type;

export const PrHubReviewer = Schema.Struct({
  ...PrHubActor.fields,
  kind: Schema.Literals(["user", "team"]),
  requested: Schema.Boolean,
});
export type PrHubReviewer = typeof PrHubReviewer.Type;

const PrHubReadMode = Schema.Literals(["if_stale", "force"]);

export const PrHubDetailInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  mode: Schema.optional(PrHubReadMode),
});
export type PrHubDetailInput = typeof PrHubDetailInput.Type;

export const PrHubDetailProviderDetails = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("github"),
    nodeId: Schema.NullOr(Schema.String),
    mergeStateStatus: Schema.String,
    headRefOid: Schema.NullOr(Schema.String),
    baseRefOid: Schema.NullOr(Schema.String),
    viewerCanUpdate: Schema.Boolean,
    viewerDidAuthor: Schema.Boolean,
  }),
  Schema.Struct({
    provider: Schema.Literals(["gitlab", "azure-devops", "bitbucket", "unknown"]),
    externalId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);
export type PrHubDetailProviderDetails = typeof PrHubDetailProviderDetails.Type;

export const PrHubDetail = Schema.Struct({
  key: PullRequestKey,
  providerDetails: PrHubDetailProviderDetails,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: PrPullRequestState,
  isDraft: Schema.Boolean,
  mergeable: PrMergeable,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headRefName: Schema.NullOr(Schema.String),
  baseRefName: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  author: Schema.NullOr(PrHubActor),
  labels: Schema.Array(PrHubLabel),
  reviewers: Schema.Array(PrHubReviewer),
  checks: Schema.Array(PrHubCheck),
  reactions: Schema.Array(PrHubReaction),
  truncatedSections: Schema.optional(
    Schema.Array(Schema.Literals(["labels", "reviewers", "checks"])),
  ),
});
export type PrHubDetail = typeof PrHubDetail.Type;

export const PrHubDetailResult = Schema.Struct({
  detail: PrHubDetail,
  stale: Schema.Boolean,
  warning: Schema.optional(Schema.String),
  refreshedAt: IsoDateTime,
  rateLimit: Schema.optional(SourceControlRateLimit),
});
export type PrHubDetailResult = typeof PrHubDetailResult.Type;

export const PrHubTimelineCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PrHubTimelineCommentKind = typeof PrHubTimelineCommentKind.Type;

export const PrHubTimelineComment = Schema.Struct({
  type: Schema.Literal("comment"),
  id: Schema.String,
  databaseId: Schema.NullOr(Schema.String),
  kind: PrHubTimelineCommentKind,
  author: Schema.NullOr(PrHubActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(NonNegativeInt),
  reviewState: Schema.NullOr(Schema.String),
  viewerCanUpdate: Schema.Boolean,
  reactions: Schema.Array(PrHubReaction),
});
export type PrHubTimelineComment = typeof PrHubTimelineComment.Type;

export const PrHubTimelineCommit = Schema.Struct({
  type: Schema.Literal("commit"),
  id: Schema.String,
  oid: Schema.String,
  messageHeadline: Schema.String,
  committedAt: IsoDateTime,
  authors: Schema.Array(PrHubActor),
});
export type PrHubTimelineCommit = typeof PrHubTimelineCommit.Type;

export const PrHubTimelineEntry = Schema.Union([PrHubTimelineComment, PrHubTimelineCommit]);
export type PrHubTimelineEntry = typeof PrHubTimelineEntry.Type;

export const PrHubTimelineInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  mode: Schema.optional(PrHubReadMode),
});
export type PrHubTimelineInput = typeof PrHubTimelineInput.Type;

export const PrHubTimelinePage = Schema.Struct({
  entries: Schema.Array(PrHubTimelineEntry),
  pageInfo: SourceControlPageInfo,
  stale: Schema.Boolean,
  warning: Schema.optional(Schema.String),
  refreshedAt: IsoDateTime,
});
export type PrHubTimelinePage = typeof PrHubTimelinePage.Type;

export const PrHubFileChangeType = Schema.Literals([
  "added",
  "changed",
  "deleted",
  "renamed",
  "copied",
  "unknown",
]);
export type PrHubFileChangeType = typeof PrHubFileChangeType.Type;

export const PrHubChangedFile = Schema.Struct({
  path: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changeType: PrHubFileChangeType,
  previousPath: Schema.optional(Schema.NullOr(Schema.String)),
  blobOid: Schema.optional(Schema.NullOr(Schema.String)),
  patch: Schema.optional(Schema.NullOr(Schema.String)),
  patchStatus: Schema.optional(Schema.Literals(["available", "unavailable", "truncated"])),
});
export type PrHubChangedFile = typeof PrHubChangedFile.Type;

export const PrHubReviewComment = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(Schema.String),
  bodyText: Schema.String,
  body: Schema.optional(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  outdated: Schema.Boolean,
  diffHunk: Schema.NullOr(Schema.String),
  authorId: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export const PrHubReviewThread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(NonNegativeInt),
  originalLine: Schema.NullOr(NonNegativeInt),
  comments: Schema.Array(PrHubReviewComment),
  isOutdated: Schema.optional(Schema.Boolean),
  diffSide: Schema.optional(Schema.NullOr(Schema.Literals(["LEFT", "RIGHT"]))),
  startLine: Schema.optional(Schema.NullOr(NonNegativeInt)),
  originalStartLine: Schema.optional(Schema.NullOr(NonNegativeInt)),
  startDiffSide: Schema.optional(Schema.NullOr(Schema.Literals(["LEFT", "RIGHT"]))),
  viewerCanReply: Schema.optional(Schema.Boolean),
  viewerCanResolve: Schema.optional(Schema.Boolean),
  viewerCanUnresolve: Schema.optional(Schema.Boolean),
  commentsPageInfo: Schema.optional(SourceControlPageInfo),
});
export type PrHubReviewThread = typeof PrHubReviewThread.Type;
export const PrHubThreadsInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  threadId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type PrHubThreadsInput = typeof PrHubThreadsInput.Type;
export const PrHubThreadsPage = Schema.Struct({
  threads: Schema.Array(PrHubReviewThread),
  pageInfo: SourceControlPageInfo,
  comparisonVersion: Schema.String,
  refreshedAt: IsoDateTime,
});
export type PrHubThreadsPage = typeof PrHubThreadsPage.Type;
export const PrHubThreadStateInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  threadId: Schema.String.check(Schema.isMaxLength(256)),
  resolved: Schema.Boolean,
});
export type PrHubThreadStateInput = typeof PrHubThreadStateInput.Type;
export const PrHubReplyInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  threadId: Schema.String.check(Schema.isMaxLength(256)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  comparisonVersion: Schema.String,
});
export type PrHubReplyInput = typeof PrHubReplyInput.Type;
export const PrHubReplyDraft = Schema.Struct({
  version: NonNegativeInt,
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comparisonVersion: Schema.String,
  updatedAt: IsoDateTime,
});
export type PrHubReplyDraft = typeof PrHubReplyDraft.Type;
export const PrHubSaveReplyDraftInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  expectedVersion: NonNegativeInt,
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comparisonVersion: Schema.String.check(Schema.isMaxLength(4096)),
});
export type PrHubSaveReplyDraftInput = typeof PrHubSaveReplyDraftInput.Type;
export const PrHubReplyDraftResult = Schema.Struct({
  status: Schema.Literals(["saved", "version_conflict"]),
  draft: Schema.NullOr(PrHubReplyDraft),
});
export type PrHubReplyDraftResult = typeof PrHubReplyDraftResult.Type;
export const PrHubRecoverReplyInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  action: Schema.Literals(["link", "abandon"]),
  remoteId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
export type PrHubRecoverReplyInput = typeof PrHubRecoverReplyInput.Type;
export const PrHubReplyOperation = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  body: Schema.String,
  status: Schema.Literals([
    "prepared",
    "creating",
    "succeeded",
    "outcome_unknown",
    "rejected",
    "abandoned",
  ]),
  remoteId: Schema.NullOr(Schema.String),
  comparisonVersion: Schema.String,
});
export type PrHubReplyOperation = typeof PrHubReplyOperation.Type;
export const PrHubUnresolvedThreadsResult = Schema.Struct({
  threads: Schema.Array(PrHubReviewThread),
  truncated: Schema.Boolean,
  omittedCount: NonNegativeInt,
  stale: Schema.Boolean,
  refreshedAt: IsoDateTime,
  warning: Schema.optional(Schema.String),
});
export type PrHubUnresolvedThreadsResult = typeof PrHubUnresolvedThreadsResult.Type;

export const PrHubFilesInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  comparisonMode: Schema.optional(Schema.Literals(["current_pr", "changes_since_review"])),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  mode: Schema.optional(PrHubReadMode),
});
export type PrHubFilesInput = typeof PrHubFilesInput.Type;

export const PrHubComparisonIdentity = Schema.Struct({
  baseRepository: Schema.String,
  baseRef: Schema.String,
  baseOid: Schema.String,
  headRepository: Schema.String,
  headRef: Schema.String,
  headOid: Schema.String,
  mergeBaseOid: Schema.String,
  reviewedHeadOid: Schema.optional(Schema.String),
  mode: Schema.Literals(["current_pr", "changes_since_review"]),
});
export type PrHubComparisonIdentity = typeof PrHubComparisonIdentity.Type;

export const PrHubDraftComment = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  path: Schema.String.check(Schema.isMaxLength(4096)),
  side: Schema.Literals(["LEFT", "RIGHT"]),
  line: NonNegativeInt,
  startSide: Schema.optional(Schema.Literals(["LEFT", "RIGHT"])),
  startLine: Schema.optional(NonNegativeInt),
  commitOid: Schema.String,
  body: Schema.String.check(Schema.isMaxLength(65_536)),
});
export const PrHubReviewDraftContent = Schema.Struct({
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comments: Schema.Array(PrHubDraftComment).check(Schema.isMaxLength(100)),
  viewedFiles: Schema.Array(Schema.Struct({ path: Schema.String, blobOid: Schema.String })).check(
    Schema.isMaxLength(3000),
  ),
});
export const PrHubReviewDraft = Schema.Struct({
  version: NonNegativeInt,
  comparison: PrHubComparisonIdentity,
  content: PrHubReviewDraftContent,
  updatedAt: IsoDateTime,
  frozen: Schema.Boolean,
});
export type PrHubReviewDraft = typeof PrHubReviewDraft.Type;
export const PrHubSaveReviewDraftInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  expectedVersion: NonNegativeInt,
  revalidate: Schema.optional(Schema.Boolean),
  comparison: PrHubComparisonIdentity,
  content: PrHubReviewDraftContent,
});
export type PrHubSaveReviewDraftInput = typeof PrHubSaveReviewDraftInput.Type;
export const PrHubReviewDraftResult = Schema.Struct({
  status: Schema.Literals(["ok", "version_conflict", "frozen"]),
  draft: Schema.NullOr(PrHubReviewDraft),
});
export type PrHubReviewDraftResult = typeof PrHubReviewDraftResult.Type;

export const PrHubReviewOperation = Schema.Struct({
  comparisonStatus: Schema.optional(Schema.Literals(["current", "outdated", "unverified"])),
  id: Schema.String,
  status: Schema.Literals([
    "prepared",
    "creating",
    "created",
    "submitting",
    "succeeded",
    "failed_before_send",
    "rejected",
    "outcome_unknown",
    "abandoned",
  ]),
  payloadHash: Schema.String,
  payload: Schema.Struct({
    draft: PrHubReviewDraft,
    event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: Schema.String,
  }),
  remoteId: Schema.NullOr(Schema.String),
  correlationNonce: Schema.String,
});
export type PrHubReviewOperation = typeof PrHubReviewOperation.Type;
export const PrHubPrepareReviewInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  expectedVersion: NonNegativeInt,
  event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
});
export type PrHubPrepareReviewInput = typeof PrHubPrepareReviewInput.Type;
export const PrHubReviewOperationInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type PrHubReviewOperationInput = typeof PrHubReviewOperationInput.Type;

export const PrHubRecoverReviewInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  action: Schema.Literals(["abandon", "link"]),
  remoteId: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9]+$/))),
});
export type PrHubRecoverReviewInput = typeof PrHubRecoverReviewInput.Type;

export const PrHubFilesPage = Schema.Struct({
  files: Schema.Array(PrHubChangedFile),
  comparison: Schema.optional(PrHubComparisonIdentity),
  providerCapped: Schema.optional(Schema.Boolean),
  pageInfo: SourceControlPageInfo,
  stale: Schema.Boolean,
  warning: Schema.optional(Schema.String),
  refreshedAt: IsoDateTime,
});
export type PrHubFilesPage = typeof PrHubFilesPage.Type;

const PrHubMutationBody = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536));

export const PrHubUpdateCommentInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  commentId: Schema.String,
  kind: Schema.Literals(["issue-comment", "review-comment"]),
  body: PrHubMutationBody,
});
export type PrHubUpdateCommentInput = typeof PrHubUpdateCommentInput.Type;

export const PrHubSetReactionInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  subjectId: Schema.String,
  content: PrHubReactionContent,
  reacted: Schema.Boolean,
});
export type PrHubSetReactionInput = typeof PrHubSetReactionInput.Type;

export const PrHubChangeReviewersInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  add: Schema.Array(Schema.String).check(Schema.isMaxLength(25)),
  remove: Schema.Array(Schema.String).check(Schema.isMaxLength(25)),
});
export type PrHubChangeReviewersInput = typeof PrHubChangeReviewersInput.Type;

export const PrHubUpdateBranchInput = Schema.Struct({
  accountGeneration: Schema.optional(Schema.String),
  key: PullRequestKey,
  method: Schema.Literals(["merge", "rebase"]),
});
export type PrHubUpdateBranchInput = typeof PrHubUpdateBranchInput.Type;

export const PrHubDetailMutationResult = Schema.Struct({
  detail: PrHubDetailResult,
  timeline: PrHubTimelinePage,
});
export type PrHubDetailMutationResult = typeof PrHubDetailMutationResult.Type;

export const PR_HUB_WS_METHODS = {
  getOverview: "prHub.getOverview",
  listPullRequests: "prHub.listPullRequests",
  claimNotifications: "prHub.claimNotifications",
  acknowledgeNotifications: "prHub.acknowledgeNotifications",
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
  getDetail: "prHub.getDetail",
  getTimeline: "prHub.getTimeline",
  getFiles: "prHub.getFiles",
  getReviewDraft: "prHub.getReviewDraft",
  saveReviewDraft: "prHub.saveReviewDraft",
  prepareReview: "prHub.prepareReview",
  submitReview: "prHub.submitReview",
  getReviewOperation: "prHub.getReviewOperation",
  cancelReviewPreparation: "prHub.cancelReviewPreparation",
  recoverReview: "prHub.recoverReview",
  track: "prHub.track",
  getUnresolvedThreads: "prHub.getUnresolvedThreads",
  getReviewThreads: "prHub.getReviewThreads",
  setReviewThreadState: "prHub.setReviewThreadState",
  replyReviewThread: "prHub.replyReviewThread",
  getReplyOperation: "prHub.getReplyOperation",
  getReplyDraft: "prHub.getReplyDraft",
  saveReplyDraft: "prHub.saveReplyDraft",
  recoverReply: "prHub.recoverReply",
  updateComment: "prHub.updateComment",
  setReaction: "prHub.setReaction",
  changeReviewers: "prHub.changeReviewers",
  updateBranch: "prHub.updateBranch",
  clearData: "prHub.clearData",
} as const;

export const PR_HUB_WS_CHANNELS = {
  changed: "prHub.changed",
  advisoriesUpdated: "prHub.advisoriesUpdated",
} as const;
