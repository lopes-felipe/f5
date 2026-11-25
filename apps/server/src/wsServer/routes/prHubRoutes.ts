import { PR_HUB_WS_METHODS, PR_WATCH_WS_METHODS } from "@t3tools/contracts";
import { Effect, Option, Struct } from "effect";

import type { PullRequestWatchService } from "../../orchestration/Layers/PullRequestWatchService.ts";
import type { PrHubExtensions } from "../../prHub/PrHubExtensions.ts";
import { prHubPeekErrorCode } from "../../prHub/prHubPeekError.ts";
import { withPrHubThreadLinks } from "../../prHub/readModel.ts";
import type { PrHubReviewGuideService } from "../../prHub/Layers/PrHubReviewGuideService.ts";
import type { PrHubAdvisoryService } from "../../prHub/Services/PrHubAdvisoryService.ts";
import type { PrHubService } from "../../prHub/Services/PrHubService.ts";
import type { ForgeAccounts } from "../../sourceControl/accountRouting.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { RouteTable } from "./routeTable.ts";

type PrHubMethod =
  | (typeof PR_HUB_WS_METHODS)[keyof typeof PR_HUB_WS_METHODS]
  | typeof PR_WATCH_WS_METHODS.list
  | typeof PR_WATCH_WS_METHODS.start
  | typeof PR_WATCH_WS_METHODS.stop;

export interface PrHubRouteDependencies {
  readonly prHub: typeof PrHubService.Service;
  readonly prHubAdvisory: typeof PrHubAdvisoryService.Service;
  readonly prHubReviewGuide: typeof PrHubReviewGuideService.Service;
  readonly forgeAccounts: Option.Option<typeof ForgeAccounts.Service>;
  readonly prHubExtensions: Option.Option<typeof PrHubExtensions.Service>;
  readonly runtime: Effect.Effect<
    {
      readonly pullRequestWatches: typeof PullRequestWatchService.Service;
    },
    RouteRequestError
  >;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

const overviewInput = (body: object) => ({
  accountGeneration:
    "accountGeneration" in body
      ? (body as { readonly accountGeneration?: string | undefined }).accountGeneration
      : undefined,
});

/**
 * PR Hub overview, list, detail, review/comment/reply operations, advisories,
 * review guides, forge accounts, and pull request watch routes.
 */
export const prHubRoutes = ({
  prHub,
  prHubAdvisory,
  prHubReviewGuide,
  forgeAccounts,
  prHubExtensions,
  runtime,
}: PrHubRouteDependencies): RouteTable<PrHubMethod, never, Error> => {
  const requireForgeAccounts = () =>
    Option.isSome(forgeAccounts)
      ? Effect.succeed(forgeAccounts.value)
      : Effect.fail(new Error("Forge accounts are unavailable."));

  const requirePrHubExtensions = () =>
    Option.isSome(prHubExtensions)
      ? Effect.succeed(prHubExtensions.value)
      : Effect.fail(new Error("PR Hub extensions are unavailable."));

  const mutateAndReturnOverview = <Body extends { readonly _tag: string }>(
    mutate: (body: Omit<Body, "_tag">) => Effect.Effect<unknown, Error>,
  ) => {
    return (request: Body) =>
      Effect.gen(function* () {
        yield* mutate(withoutTag(request));
        return yield* prHub.getOverview(overviewInput(request));
      });
  };

  return {
    [PR_HUB_WS_METHODS.claimNotifications]: (request) =>
      prHub.claimNotifications(withoutTag(request)),
    [PR_HUB_WS_METHODS.acknowledgeNotifications]: mutateAndReturnOverview((body) =>
      prHub.acknowledgeNotifications(body),
    ),

    [PR_HUB_WS_METHODS.listAccounts]: () =>
      Effect.flatMap(requireForgeAccounts(), (accounts) => accounts.listAccounts()),
    [PR_HUB_WS_METHODS.removeAccount]: (request) =>
      Effect.flatMap(requireForgeAccounts(), (accounts) =>
        accounts.removeAccount(request.accountId),
      ),
    [PR_HUB_WS_METHODS.saveAccount]: (request) =>
      Effect.flatMap(requireForgeAccounts(), (accounts) =>
        accounts.saveAccount(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.listAccountRouting]: () =>
      Effect.flatMap(requireForgeAccounts(), (accounts) => accounts.listRouting()),
    [PR_HUB_WS_METHODS.removeAccountRouting]: (request) =>
      Effect.flatMap(requireForgeAccounts(), (accounts) =>
        accounts.removeRouting(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.setAccountRouting]: (request) =>
      Effect.flatMap(requireForgeAccounts(), (accounts) =>
        accounts.setRouting(withoutTag(request)),
      ),

    [PR_HUB_WS_METHODS.peek]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.peek(withoutTag(request)).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
                code: prHubPeekErrorCode(error),
              }),
          ),
        ),
      ),
    [PR_HUB_WS_METHODS.getStack]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getStack(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.getViewedFiles]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getViewedFiles(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.setViewedFile]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.setViewedFile(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.getThreadLinks]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getThreadLinks(request.threadId),
      ),
    [PR_HUB_WS_METHODS.getThreadsForPr]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getThreadsForPr(request.key),
      ),
    [PR_HUB_WS_METHODS.prepareOperation]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.prepareOperation(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.submitOperation]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.submitOperation(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.getOperation]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getOperation(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.cancelOperation]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.cancelOperation(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.recoverOperation]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.recoverOperation(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.listReviewerCandidates]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.listReviewerCandidates(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.completions]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.completions(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.getChecks]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getChecks(withoutTag(request)),
      ),
    [PR_HUB_WS_METHODS.getCheckLog]: (request) =>
      Effect.flatMap(requirePrHubExtensions(), (extensions) =>
        extensions.getCheckLog(withoutTag(request)),
      ),

    [PR_HUB_WS_METHODS.getOverview]: (request) => prHub.getOverview(withoutTag(request)),
    [PR_HUB_WS_METHODS.listPullRequests]: (request) =>
      Effect.gen(function* () {
        const page = yield* prHub.listPullRequests(withoutTag(request));
        if (Option.isNone(prHubExtensions)) return page;
        return yield* withPrHubThreadLinks(page, prHubExtensions.value.getThreadsForPrs);
      }),

    [PR_HUB_WS_METHODS.refresh]: mutateAndReturnOverview((body) => prHub.refreshNow(body)),
    [PR_HUB_WS_METHODS.approve]: mutateAndReturnOverview((body) => prHub.approve(body)),
    [PR_HUB_WS_METHODS.requestChanges]: mutateAndReturnOverview((body) =>
      prHub.requestChanges(body),
    ),
    [PR_HUB_WS_METHODS.comment]: mutateAndReturnOverview((body) => prHub.comment(body)),
    [PR_HUB_WS_METHODS.merge]: mutateAndReturnOverview((body) => prHub.merge(body)),
    [PR_HUB_WS_METHODS.markReady]: mutateAndReturnOverview((body) => prHub.markReady(body)),
    [PR_HUB_WS_METHODS.reRequestReview]: mutateAndReturnOverview((body) =>
      prHub.reRequestReview(body),
    ),
    [PR_HUB_WS_METHODS.snooze]: mutateAndReturnOverview((body) => prHub.snooze(body)),
    [PR_HUB_WS_METHODS.unsnooze]: mutateAndReturnOverview((body) => prHub.unsnooze(body)),
    [PR_HUB_WS_METHODS.ignore]: mutateAndReturnOverview((body) => prHub.ignore(body)),
    [PR_HUB_WS_METHODS.unignore]: mutateAndReturnOverview((body) => prHub.unignore(body)),
    [PR_HUB_WS_METHODS.bulkUpdate]: (request) => prHub.bulkUpdate(withoutTag(request)),
    [PR_HUB_WS_METHODS.acknowledgeAttention]: mutateAndReturnOverview((body) =>
      prHub.acknowledgeAttention(body),
    ),
    [PR_HUB_WS_METHODS.markSeen]: mutateAndReturnOverview((body) => prHub.markSeen(body)),
    [PR_HUB_WS_METHODS.markNotified]: mutateAndReturnOverview((body) => prHub.markNotified(body)),
    [PR_HUB_WS_METHODS.clearData]: mutateAndReturnOverview((body) => prHub.clearData(body)),

    [PR_HUB_WS_METHODS.analyzeAdvisories]: (request) =>
      prHubAdvisory.analyzeAdvisories(withoutTag(request)),
    [PR_HUB_WS_METHODS.getAdvisories]: (request) =>
      prHubAdvisory.getAdvisories(withoutTag(request)),
    [PR_HUB_WS_METHODS.getReviewGuide]: (request) => prHubReviewGuide.get(withoutTag(request)),
    [PR_HUB_WS_METHODS.generateReviewGuide]: (request) =>
      prHubReviewGuide.generate(withoutTag(request)),

    [PR_HUB_WS_METHODS.resolveLocalCheckout]: (request) =>
      prHub.resolveLocalCheckout(withoutTag(request)),
    [PR_HUB_WS_METHODS.listLocalCheckoutCandidates]: (request) =>
      prHub.listLocalCheckoutCandidates(withoutTag(request)),
    [PR_HUB_WS_METHODS.getDetail]: (request) => prHub.getDetail(withoutTag(request)),
    [PR_HUB_WS_METHODS.getTimeline]: (request) => prHub.getTimeline(withoutTag(request)),
    [PR_HUB_WS_METHODS.getUnresolvedThreads]: (request) =>
      prHub.getUnresolvedThreads(withoutTag(request)),
    [PR_HUB_WS_METHODS.prepareComment]: (request) => prHub.prepareComment(withoutTag(request)),
    [PR_HUB_WS_METHODS.submitComment]: (request) => prHub.submitComment(withoutTag(request)),
    [PR_HUB_WS_METHODS.getCommentOperation]: (request) =>
      prHub.getCommentOperation(withoutTag(request)),
    [PR_HUB_WS_METHODS.recoverComment]: (request) => prHub.recoverComment(withoutTag(request)),
    [PR_HUB_WS_METHODS.prepareQuickReview]: (request) =>
      prHub.prepareQuickReview(withoutTag(request)),
    [PR_HUB_WS_METHODS.prepareReview]: (request) => prHub.prepareReview(withoutTag(request)),
    [PR_HUB_WS_METHODS.submitReview]: (request) => prHub.submitReview(withoutTag(request)),
    [PR_HUB_WS_METHODS.getReviewOperation]: (request) =>
      prHub.getReviewOperation(withoutTag(request)),
    [PR_HUB_WS_METHODS.track]: (request) => prHub.track(withoutTag(request)),
    [PR_HUB_WS_METHODS.recoverReview]: (request) => prHub.recoverReview(withoutTag(request)),
    [PR_HUB_WS_METHODS.cancelReviewPreparation]: (request) =>
      prHub.cancelReviewPreparation(withoutTag(request)),
    [PR_HUB_WS_METHODS.replyReviewThread]: (request) =>
      prHub.replyReviewThread(withoutTag(request)),
    [PR_HUB_WS_METHODS.recoverReply]: (request) => prHub.recoverReply(withoutTag(request)),
    [PR_HUB_WS_METHODS.getReplyDraft]: (request) => prHub.getReplyDraft(withoutTag(request)),
    [PR_HUB_WS_METHODS.saveReplyDraft]: (request) => prHub.saveReplyDraft(withoutTag(request)),
    [PR_HUB_WS_METHODS.getReplyOperation]: (request) =>
      prHub.getReplyOperation(withoutTag(request)),
    [PR_HUB_WS_METHODS.getReviewThreads]: (request) => prHub.getReviewThreads(withoutTag(request)),
    [PR_HUB_WS_METHODS.setReviewThreadState]: (request) =>
      prHub.setReviewThreadState(withoutTag(request)),
    [PR_HUB_WS_METHODS.getReviewDraft]: (request) => prHub.getReviewDraft(withoutTag(request)),
    [PR_HUB_WS_METHODS.saveReviewDraft]: (request) => prHub.saveReviewDraft(withoutTag(request)),
    [PR_HUB_WS_METHODS.getFiles]: (request) => prHub.getFiles(withoutTag(request)),
    [PR_HUB_WS_METHODS.getChangeBreakdown]: (request) =>
      prHub.getChangeBreakdown(withoutTag(request)),
    [PR_HUB_WS_METHODS.updateComment]: (request) => prHub.updateComment(withoutTag(request)),
    [PR_HUB_WS_METHODS.setReaction]: (request) => prHub.setReaction(withoutTag(request)),
    [PR_HUB_WS_METHODS.changeReviewers]: (request) => prHub.changeReviewers(withoutTag(request)),
    [PR_HUB_WS_METHODS.updateBranch]: (request) => prHub.updateBranch(withoutTag(request)),

    [PR_WATCH_WS_METHODS.list]: (request) =>
      Effect.flatMap(runtime, ({ pullRequestWatches }) =>
        pullRequestWatches.list(request.threadId),
      ),
    [PR_WATCH_WS_METHODS.start]: (request) =>
      Effect.flatMap(runtime, ({ pullRequestWatches }) =>
        pullRequestWatches.startWatch(withoutTag(request)),
      ),
    [PR_WATCH_WS_METHODS.stop]: (request) =>
      Effect.flatMap(runtime, ({ pullRequestWatches }) =>
        pullRequestWatches.stopWatch(withoutTag(request)),
      ),
  };
};
