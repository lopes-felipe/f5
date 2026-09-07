import type { PrHubRemoteActions } from "../remoteActions.ts";
import type { PrHubSnapshot, PrHubTimelinePage } from "@t3tools/contracts";
import type { CachedPrDetailRead } from "../detailCache.ts";
import { ServiceMap, type Effect } from "effect";
import type { PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";
import type {
  SourceControlProviderRegistry,
  SourceControlProviderError,
} from "../../sourceControl/SourceControlProvider.ts";
import type { PrHubServiceShape } from "./PrHubService.ts";

export type PrHubReviewMethods = PrHubRemoteActions &
  Pick<
    PrHubServiceShape,
    | "recoverReview"
    | "getReviewDraft"
    | "saveReviewDraft"
    | "prepareComment"
    | "submitComment"
    | "getCommentOperation"
    | "recoverComment"
    | "prepareQuickReview"
    | "prepareReview"
    | "submitReview"
    | "getReviewOperation"
    | "cancelReviewPreparation"
    | "getReviewThreads"
    | "setReviewThreadState"
    | "replyReviewThread"
    | "getReplyOperation"
    | "getReplyDraft"
    | "recoverReply"
    | "saveReplyDraft"
  >;
export interface PrHubReviewContext {
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly trackedPrByUrl: (
    url: string,
  ) => Effect.Effect<TrackedPullRequest, SourceControlProviderError>;
  readonly getDetail: PrHubServiceShape["getDetail"];
  readonly getTimeline: PrHubServiceShape["getTimeline"];
  readonly timelineCache: Map<string, CachedPrDetailRead<PrHubTimelinePage>>;
  readonly decodeDetailResponse: <A>(
    pr: TrackedPullRequest,
    operation: string,
    decode: () => A,
  ) => Effect.Effect<A, SourceControlProviderError>;

  readonly cwd: string;
  readonly sourceControlProviders: SourceControlProviderRegistry;
  readonly trackedPrByKey: (
    key: PullRequestKey,
  ) => Effect.Effect<TrackedPullRequest, SourceControlProviderError>;
  readonly getFiles: PrHubServiceShape["getFiles"];
  readonly prHubActionError: (detail: string) => SourceControlProviderError;
  readonly requestRefresh: Effect.Effect<void>;
  readonly invalidateThreads: () => void;
}
export class PrHubReviewOperations extends ServiceMap.Service<
  PrHubReviewOperations,
  {
    readonly create: (context: PrHubReviewContext) => PrHubReviewMethods;
  }
>()("t3/prHub/Services/PrHubReviewOperations") {}
