import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";
import type {
  PrHubCommentInput,
  PrHubClearDataInput,
  PrHubClaimNotificationsInput,
  PrHubAcknowledgeNotificationsInput,
  PrHubNotificationBatch,
  PrHubOverview,
  PrHubOverviewInput,
  PrHubListInput,
  PrHubListPage,
  PrHubChanged,
  PrHubChangeReviewersInput,
  PrHubDetailInput,
  PrHubDetailMutationResult,
  PrHubDetailResult,
  PrHubFilesInput,
  PrHubFilesPage,
  PrHubThreadsInput,
  PrHubReplyInput,
  PrHubRecoverReplyInput,
  PrHubReplyDraft,
  PrHubReplyDraftResult,
  PrHubSaveReplyDraftInput,
  PrHubReplyOperation,
  PrHubThreadsPage,
  PrHubThreadStateInput,
  PrHubReviewThread,
  PrHubSaveReviewDraftInput,
  PrHubPrepareReviewInput,
  PrHubReviewOperationInput,
  PrHubRecoverReviewInput,
  PrHubReviewOperation,
  PrHubReviewDraftResult,
  PrHubUnresolvedThreadsResult,
  PrHubIgnoreInput,
  PrHubLocalCandidatesInput,
  PrHubLocalCheckoutCandidate,
  PrHubMarkNotifiedInput,
  PrHubMarkReadyInput,
  PrHubMarkSeenInput,
  PrHubMergeInput,
  PrHubRefreshInput,
  PrHubRequestChangesInput,
  PrHubReRequestInput,
  PrHubReviewInput,
  PrHubTrackInput,
  TrackedPullRequest,
  PrHubSnapshot,
  PrHubSetReactionInput,
  PrHubSnoozeInput,
  PrHubTimelineInput,
  PrHubTimelinePage,
  PrHubUnsnoozeInput,
  PrHubUpdateBranchInput,
  PrHubUpdateCommentInput,
} from "@t3tools/contracts";

import type { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";

export interface PrHubServiceShape {
  readonly startMonitoring: Effect.Effect<void>;
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly refreshNow: (input: PrHubRefreshInput) => Effect.Effect<PrHubSnapshot>;
  readonly streamChanges: Stream.Stream<PrHubChanged>;
  readonly getOverview: (input: PrHubOverviewInput) => Effect.Effect<PrHubOverview>;
  readonly claimNotifications: (
    input: PrHubClaimNotificationsInput,
  ) => Effect.Effect<PrHubNotificationBatch, SourceControlProviderError>;
  readonly acknowledgeNotifications: (
    input: PrHubAcknowledgeNotificationsInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly listPullRequests: (input: PrHubListInput) => Effect.Effect<PrHubListPage>;
  readonly approve: (
    input: PrHubReviewInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly requestChanges: (
    input: PrHubRequestChangesInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly comment: (
    input: PrHubCommentInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly merge: (
    input: PrHubMergeInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly markReady: (
    input: PrHubMarkReadyInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly reRequestReview: (
    input: PrHubReRequestInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly snooze: (
    input: PrHubSnoozeInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly unsnooze: (
    input: PrHubUnsnoozeInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly ignore: (
    input: PrHubIgnoreInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly markSeen: (
    input: PrHubMarkSeenInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly markNotified: (
    input: PrHubMarkNotifiedInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly listLocalCheckoutCandidates: (
    input: PrHubLocalCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<PrHubLocalCheckoutCandidate>>;
  readonly getDetail: (
    input: PrHubDetailInput,
  ) => Effect.Effect<PrHubDetailResult, SourceControlProviderError>;
  readonly getTimeline: (
    input: PrHubTimelineInput,
  ) => Effect.Effect<PrHubTimelinePage, SourceControlProviderError>;
  readonly getUnresolvedThreads: (
    input: PrHubDetailInput,
  ) => Effect.Effect<PrHubUnresolvedThreadsResult, SourceControlProviderError>;
  readonly replyReviewThread: (
    input: PrHubReplyInput,
  ) => Effect.Effect<PrHubReplyOperation, SourceControlProviderError>;
  readonly recoverReply: (
    input: PrHubRecoverReplyInput,
  ) => Effect.Effect<PrHubReplyOperation, SourceControlProviderError>;
  readonly getReplyDraft: (
    input: PrHubThreadsInput,
  ) => Effect.Effect<PrHubReplyDraft | null, SourceControlProviderError>;
  readonly saveReplyDraft: (
    input: PrHubSaveReplyDraftInput,
  ) => Effect.Effect<PrHubReplyDraftResult, SourceControlProviderError>;
  readonly getReplyOperation: (
    input: PrHubThreadsInput,
  ) => Effect.Effect<PrHubReplyOperation | null, SourceControlProviderError>;
  readonly getReviewThreads: (
    input: PrHubThreadsInput,
  ) => Effect.Effect<PrHubThreadsPage, SourceControlProviderError>;
  readonly setReviewThreadState: (
    input: PrHubThreadStateInput,
  ) => Effect.Effect<PrHubReviewThread, SourceControlProviderError>;
  readonly getReviewDraft: (
    input: PrHubDetailInput,
  ) => Effect.Effect<PrHubReviewDraftResult, SourceControlProviderError>;
  readonly prepareReview: (
    input: PrHubPrepareReviewInput,
  ) => Effect.Effect<PrHubReviewOperation, SourceControlProviderError>;
  readonly track: (
    input: PrHubTrackInput,
  ) => Effect.Effect<TrackedPullRequest, SourceControlProviderError>;
  readonly recoverReview: (
    input: PrHubRecoverReviewInput,
  ) => Effect.Effect<PrHubReviewOperation, SourceControlProviderError>;
  readonly submitReview: (
    input: PrHubReviewOperationInput,
  ) => Effect.Effect<PrHubReviewOperation, SourceControlProviderError>;
  readonly getReviewOperation: (
    input: PrHubDetailInput,
  ) => Effect.Effect<PrHubReviewOperation | null, SourceControlProviderError>;
  readonly cancelReviewPreparation: (
    input: PrHubReviewOperationInput,
  ) => Effect.Effect<PrHubReviewOperation, SourceControlProviderError>;
  readonly saveReviewDraft: (
    input: PrHubSaveReviewDraftInput,
  ) => Effect.Effect<PrHubReviewDraftResult, SourceControlProviderError>;
  readonly getFiles: (
    input: PrHubFilesInput,
  ) => Effect.Effect<PrHubFilesPage, SourceControlProviderError>;
  readonly updateComment: (
    input: PrHubUpdateCommentInput,
  ) => Effect.Effect<PrHubDetailMutationResult, SourceControlProviderError>;
  readonly setReaction: (
    input: PrHubSetReactionInput,
  ) => Effect.Effect<PrHubDetailMutationResult, SourceControlProviderError>;
  readonly changeReviewers: (
    input: PrHubChangeReviewersInput,
  ) => Effect.Effect<PrHubDetailMutationResult, SourceControlProviderError>;
  readonly updateBranch: (
    input: PrHubUpdateBranchInput,
  ) => Effect.Effect<PrHubDetailMutationResult, SourceControlProviderError>;
  readonly clearData: (
    input?: PrHubClearDataInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
}

export class PrHubService extends ServiceMap.Service<PrHubService, PrHubServiceShape>()(
  "t3/prHub/Services/PrHubService",
) {}
