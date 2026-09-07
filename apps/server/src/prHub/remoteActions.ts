import { prComparisonsEqual } from "@t3tools/shared/prReview";

import { PR_DETAIL_CACHE_TTL_MS } from "./detailCache.ts";

import { GitHubCredentialScope } from "../git/githubApi.ts";

import { type PrHubTimelineComment, type TrackedPullRequest } from "@t3tools/contracts";
import { canViewerReview } from "@t3tools/shared/prHub";

import { Effect, Option } from "effect";

import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

import { type PrHubServiceShape } from "./Services/PrHubService.ts";
import {
  GITHUB_ADD_REACTION_MUTATION,
  GITHUB_REACTION_CONTENT,
  GITHUB_REMOVE_REACTION_MUTATION,
} from "./githubPrDetails.ts";

import { asRecord, stringValue } from "./discoveryModel.ts";

import type { PrHubReviewContext } from "./Services/PrHubReviewOperations.ts";
export type PrHubRemoteActions = Pick<
  PrHubServiceShape,
  | "approve"
  | "requestChanges"
  | "comment"
  | "merge"
  | "markReady"
  | "reRequestReview"
  | "updateComment"
  | "setReaction"
  | "changeReviewers"
  | "updateBranch"
>;
export function createPrHubRemoteActions(
  context: PrHubReviewContext,
  durable: Pick<PrHubServiceShape, "submitReview" | "getReviewOperation" | "submitComment">,
): PrHubRemoteActions {
  const {
    cwd,
    sourceControlProviders,
    trackedPrByKey,
    trackedPrByUrl,
    getFiles,
    getDetail,
    getTimeline,
    getSnapshot,
    timelineCache,
    decodeDetailResponse,
    requestRefresh,
    prHubActionError,
  } = context;
  const { submitReview, getReviewOperation, submitComment } = durable;
  const refreshAfterAction = <E>(effect: Effect.Effect<void, E>) =>
    effect.pipe(Effect.andThen(requestRefresh), Effect.andThen(getSnapshot));
  const reconcileDetailMutation = (pr: TrackedPullRequest) =>
    Effect.all(
      [getDetail({ key: pr.key, mode: "force" }), getTimeline({ key: pr.key, mode: "force" })],
      { concurrency: 2 },
    ).pipe(Effect.map(([detail, timeline]) => ({ detail, timeline })));

  const cachedAuthoritativeTimelineComment = (
    pr: TrackedPullRequest,
    predicate: (comment: PrHubTimelineComment) => boolean,
    generation: string,
  ): PrHubTimelineComment | null => {
    const prefix = `${generation}:${pr.key}|`;
    for (const [key, cached] of timelineCache) {
      if (!key.startsWith(prefix) || Date.now() - cached.storedAt >= PR_DETAIL_CACHE_TTL_MS)
        continue;
      const match = cached.value.entries.find(
        (entry): entry is PrHubTimelineComment => entry.type === "comment" && predicate(entry),
      );
      if (match) return match;
    }
    return null;
  };

  const findAuthoritativeTimelineComment = (
    pr: TrackedPullRequest,
    predicate: (comment: PrHubTimelineComment) => boolean,
  ): Effect.Effect<PrHubTimelineComment | null, SourceControlProviderError> =>
    Effect.gen(function* () {
      const capture = yield* Effect.serviceOption(GitHubCredentialScope);
      const cachedMatch = cachedAuthoritativeTimelineComment(
        pr,
        predicate,
        Option.isSome(capture) ? capture.value.generation : "unverified",
      );
      if (cachedMatch) return cachedMatch;
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = yield* getTimeline({ key: pr.key, cursor, mode: "if_stale" });
        if (page.stale) {
          return yield* prHubActionError(
            "GitHub could not verify the selected pull request object. Refresh and try again.",
          );
        }
        const match = page.entries.find(
          (entry): entry is PrHubTimelineComment => entry.type === "comment" && predicate(entry),
        );
        if (match) return match;
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return null;
        cursor = page.pageInfo.endCursor;
      }
      return yield* prHubActionError(
        "The selected pull request object is outside the authorized timeline window.",
      );
    });

  const authorizeCommentUpdate = (
    pr: TrackedPullRequest,
    input: { readonly commentId: string; readonly kind: "issue-comment" | "review-comment" },
  ) =>
    findAuthoritativeTimelineComment(
      pr,
      (comment) =>
        comment.databaseId === input.commentId &&
        comment.kind === input.kind &&
        comment.viewerCanUpdate,
    ).pipe(
      Effect.flatMap((comment) =>
        comment
          ? Effect.void
          : Effect.fail(
              prHubActionError(
                "The selected comment does not belong to this pull request or cannot be edited.",
              ),
            ),
      ),
    );

  const authorizeReactionSubject = (pr: TrackedPullRequest, subjectId: string) =>
    getDetail({ key: pr.key, mode: "force" }).pipe(
      Effect.flatMap((result) => {
        if (result.stale) {
          return Effect.fail(
            prHubActionError(
              "GitHub could not verify the selected pull request object. Refresh and try again.",
            ),
          );
        }
        const providerDetails = result.detail.providerDetails;
        if (providerDetails.provider === "github" && providerDetails.nodeId === subjectId) {
          return Effect.void;
        }
        return findAuthoritativeTimelineComment(pr, (comment) => comment.id === subjectId).pipe(
          Effect.flatMap((comment) =>
            comment
              ? Effect.void
              : Effect.fail(
                  prHubActionError(
                    "The selected reaction target does not belong to this pull request.",
                  ),
                ),
          ),
        );
      }),
    );

  const validateReactionMutation = (
    pr: TrackedPullRequest,
    response: unknown,
    reacted: boolean,
  ): Effect.Effect<void, SourceControlProviderError> =>
    decodeDetailResponse(pr, "prHub.setReaction.decode", () => {
      const root = asRecord(response);
      if (!root || (Array.isArray(root.errors) && root.errors.length > 0)) {
        throw new Error("GitHub rejected the reaction mutation.");
      }
      const data = asRecord(root.data);
      const payload = asRecord(data?.[reacted ? "addReaction" : "removeReaction"]);
      const subject = asRecord(payload?.subject);
      if (!payload || stringValue(subject?.id) === null) {
        throw new Error("GitHub returned an incomplete reaction mutation response.");
      }
    });

  const requireTrackedPr = (
    url: string,
    predicate: (pr: TrackedPullRequest) => boolean,
    detail: string,
  ): Effect.Effect<TrackedPullRequest, SourceControlProviderError> =>
    trackedPrByUrl(url).pipe(
      Effect.flatMap((pr) =>
        predicate(pr) ? Effect.succeed(pr) : Effect.fail(prHubActionError(detail)),
      ),
    );

  const validReviewerPattern = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;
  const normalizeReviewerInputs = (reviewers: ReadonlyArray<string>) =>
    reviewers.map((reviewer) => reviewer.trim()).filter(Boolean);

  const validateReviewers = (
    reviewers: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, SourceControlProviderError> => {
    const normalized = normalizeReviewerInputs(reviewers);
    if (normalized.length === 0) {
      return Effect.fail(prHubActionError("No reviewers are available to re-request."));
    }
    const invalid = normalized.find((reviewer) => !validReviewerPattern.test(reviewer));
    if (invalid) {
      return Effect.fail(prHubActionError(`Invalid reviewer name: ${invalid}`));
    }
    return Effect.succeed(normalized);
  };

  const updateComment: PrHubServiceShape["updateComment"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        /^\d+$/.test(input.commentId)
          ? authorizeCommentUpdate(pr, input).pipe(
              Effect.andThen(sourceControlProviders.get(pr.provider)),
              Effect.flatMap((provider) =>
                provider.updatePullRequestComment({
                  cwd,
                  host: pr.host,
                  repository: pr.repository.nameWithOwner,
                  commentId: input.commentId,
                  kind: input.kind,
                  body: input.body,
                }),
              ),
              Effect.andThen(reconcileDetailMutation(pr)),
            )
          : Effect.fail(prHubActionError("The selected comment cannot be edited.")),
      ),
    );

  const setReaction: PrHubServiceShape["setReaction"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        authorizeReactionSubject(pr, input.subjectId).pipe(
          Effect.andThen(sourceControlProviders.get(pr.provider)),
          Effect.flatMap((provider) =>
            provider.requireCapability("react").pipe(
              Effect.andThen(
                provider
                  .query({
                    cwd,
                    host: pr.host,
                    document: input.reacted
                      ? GITHUB_ADD_REACTION_MUTATION
                      : GITHUB_REMOVE_REACTION_MUTATION,
                    variables: {
                      subjectId: input.subjectId,
                      content: GITHUB_REACTION_CONTENT[input.content],
                    },
                  })
                  .pipe(
                    Effect.flatMap((response) =>
                      validateReactionMutation(pr, response, input.reacted),
                    ),
                  ),
              ),
            ),
          ),
          Effect.andThen(reconcileDetailMutation(pr)),
        ),
      ),
    );

  const changeReviewers: PrHubServiceShape["changeReviewers"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const add = [...new Set(normalizeReviewerInputs(input.add))];
          const remove = [...new Set(normalizeReviewerInputs(input.remove))];
          if (add.length === 0 && remove.length === 0) {
            return yield* prHubActionError("Choose at least one reviewer change.");
          }
          const invalid = [...add, ...remove].find(
            (reviewer) => !validReviewerPattern.test(reviewer),
          );
          if (invalid) {
            return yield* prHubActionError(`Invalid reviewer name: ${invalid}`);
          }
          const removing = new Set(remove.map((reviewer) => reviewer.toLowerCase()));
          const overlap = add.find((reviewer) => removing.has(reviewer.toLowerCase()));
          if (overlap) {
            return yield* prHubActionError(
              `Reviewer '${overlap}' cannot be added and removed together.`,
            );
          }
          const provider = yield* sourceControlProviders.get(pr.provider);
          yield* provider.changePullRequestReviewers({ cwd, url: pr.url, add, remove });
          yield* requestRefresh;
          return yield* reconcileDetailMutation(pr);
        }),
      ),
    );

  const updateBranch: PrHubServiceShape["updateBranch"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        pr.state === "open"
          ? sourceControlProviders.get(pr.provider).pipe(
              Effect.flatMap((provider) =>
                provider.updatePullRequestBranch({ cwd, url: pr.url, method: input.method }),
              ),
              Effect.tap(() => requestRefresh),
              Effect.tap(() => Effect.sync(() => {})),
              Effect.andThen(reconcileDetailMutation(pr)),
            )
          : Effect.fail(prHubActionError("Only open pull-request branches can be updated.")),
      ),
    );

  return {
    approve: (input) =>
      requireTrackedPr(
        input.url,
        canViewerReview,
        "Approve is only available for tracked PRs requesting your review.",
      ).pipe(
        Effect.flatMap((pr) =>
          Effect.gen(function* () {
            if (!input.operationId || !input.payloadHash)
              return yield* prHubActionError(
                "Reload PR Hub and prepare a submission preview before publishing this review.",
              );
            const operation = yield* getReviewOperation({ key: pr.key });
            if (
              !operation ||
              operation.id !== input.operationId ||
              operation.payloadHash !== input.payloadHash ||
              operation.payload.source !== "quick_review" ||
              operation.payload.event !== "APPROVE"
            )
              return yield* prHubActionError(
                "The prepared review does not match this action. Reload its preview.",
              );
            const result = yield* submitReview({
              key: pr.key,
              id: operation.id,
              payloadHash: input.payloadHash,
            });
            if (result.status !== "succeeded")
              return yield* prHubActionError(
                "The review requires recovery. Open its saved submission state.",
              );
            return yield* getSnapshot;
          }),
        ),
      ),
    requestChanges: (input) =>
      requireTrackedPr(
        input.url,
        canViewerReview,
        "Request changes is only available for tracked PRs requesting your review.",
      ).pipe(
        Effect.flatMap((pr) =>
          Effect.gen(function* () {
            if (!input.operationId || !input.payloadHash)
              return yield* prHubActionError(
                "Reload PR Hub and prepare a submission preview before publishing this review.",
              );
            const operation = yield* getReviewOperation({ key: pr.key });
            if (
              !operation ||
              operation.id !== input.operationId ||
              operation.payloadHash !== input.payloadHash ||
              operation.payload.source !== "quick_review" ||
              operation.payload.event !== "REQUEST_CHANGES"
            )
              return yield* prHubActionError(
                "The prepared review does not match this action. Reload its preview.",
              );
            const result = yield* submitReview({
              key: pr.key,
              id: operation.id,
              payloadHash: input.payloadHash,
            });
            if (result.status !== "succeeded")
              return yield* prHubActionError(
                "The review requires recovery. Open its saved submission state.",
              );
            return yield* getSnapshot;
          }),
        ),
      ),
    comment: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.state === "open",
        "Comment is only available for tracked open PRs.",
      ).pipe(
        Effect.flatMap((pr) =>
          Effect.gen(function* () {
            if (!input.operationId || !input.payloadHash || !input.accountGeneration)
              return yield* prHubActionError(
                "Reload F5 and preview the comment before submitting.",
              );
            const result = yield* submitComment({
              key: pr.key,
              accountGeneration: input.accountGeneration,
              id: input.operationId,
              payloadHash: input.payloadHash,
            });
            if (result.status !== "succeeded")
              return yield* prHubActionError(
                "The saved comment requires recovery. Open its submission state.",
              );
            return yield* getSnapshot;
          }),
        ),
      ),
    merge: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.roles.includes("author") && pr.attentionState === "ready_to_merge",
        "Merge is only available for tracked author PRs that are ready to merge.",
      ).pipe(
        Effect.flatMap((pr) => {
          const headRefOid = pr.headRefOid;
          if (!headRefOid) {
            return Effect.fail(
              prHubActionError("Cannot merge because the tracked PR head commit is unknown."),
            );
          }
          if (!input.expectedComparison || input.expectedComparison.headOid !== headRefOid)
            return Effect.fail(
              prHubActionError(
                "The merge comparison is missing or stale. Reopen the merge preview.",
              ),
            );
          return getFiles({ key: pr.key, mode: "force" }).pipe(
            Effect.flatMap((page) =>
              prComparisonsEqual(page.comparison, input.expectedComparison)
                ? trackedPrByKey(pr.key)
                : Effect.fail(
                    prHubActionError("The PR comparison changed. Reopen the merge preview."),
                  ),
            ),
            Effect.flatMap(() => sourceControlProviders.get(pr.provider)),
            Effect.flatMap((provider) =>
              refreshAfterAction(
                provider.mergePullRequest({
                  cwd,
                  url: input.url,
                  method: input.method,
                  expectedHeadOid: headRefOid,
                }),
              ),
            ),
          );
        }),
      ),
    markReady: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.roles.includes("author") && pr.attentionState === "draft",
        "Mark ready is only available for tracked draft PRs you authored.",
      ).pipe(
        Effect.flatMap((pr) => sourceControlProviders.get(pr.provider)),
        Effect.flatMap((provider) =>
          refreshAfterAction(provider.markPullRequestReady({ cwd, ...input })),
        ),
      ),
    reRequestReview: (input) =>
      requireTrackedPr(
        input.url,
        (pr) =>
          pr.roles.includes("author") &&
          (pr.attentionState === "awaiting_review" || pr.attentionState === "unresolved_comments"),
        "Re-request review is only available for tracked author PRs awaiting review.",
      ).pipe(
        Effect.flatMap((pr) =>
          validateReviewers(
            input.reviewers?.length ? input.reviewers : pr.reviewRequestReviewers,
          ).pipe(
            Effect.flatMap((reviewers) =>
              sourceControlProviders.get(pr.provider).pipe(
                Effect.flatMap((provider) =>
                  refreshAfterAction(
                    provider.addPullRequestReviewers({
                      cwd,
                      url: input.url,
                      reviewers,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    updateComment,
    setReaction,
    changeReviewers,
    updateBranch,
  };
}
