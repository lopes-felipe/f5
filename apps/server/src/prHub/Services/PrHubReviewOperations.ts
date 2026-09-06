import { ServiceMap, type Effect } from "effect";
import type { PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";
import type {
  SourceControlProviderRegistry,
  SourceControlProviderError,
} from "../../sourceControl/SourceControlProvider.ts";
import type { PrHubServiceShape } from "./PrHubService.ts";

export type PrHubReviewMethods = Pick<
  PrHubServiceShape,
  | "recoverReview"
  | "getReviewDraft"
  | "saveReviewDraft"
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
