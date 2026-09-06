import { prComparisonsEqual } from "@t3tools/shared/prReview";
import { readReplyDraft, saveReplyDraft as persistReplyDraft } from "../replyDrafts.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { replyToReviewThread, reconcileThreadReply, recoverThreadReply } from "../threadReplies.ts";
import {
  readReviewThreadPage,
  setReviewThreadResolved,
  type ThreadReaderContext,
} from "../threadReader.ts";
import {
  prepareReviewOperation,
  readReviewOperation,
  transitionReviewOperation,
} from "../reviewOperations.ts";
import {
  submitPreparedReview,
  linkReviewSubmission,
  reconcileReviewSubmission,
  type ReviewSubmissionDependencies,
} from "../submitReview.ts";
import { prReviewLines } from "@t3tools/shared/prReview";
import { readPrHubReviewDraft, savePrHubReviewDraft } from "../reviewDrafts.ts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { PrHubReviewDraft, PrHubReviewOperation, PullRequestKey } from "@t3tools/contracts";
import { GitHubCredentialScope } from "../../git/githubApi.ts";
import { mapGitHubCliError } from "../../sourceControl/GitHubSourceControlProvider.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";
import type { PrHubServiceShape } from "../Services/PrHubService.ts";
import {
  PrHubReviewOperations,
  type PrHubReviewContext,
  type PrHubReviewMethods,
} from "../Services/PrHubReviewOperations.ts";

function create(
  context: PrHubReviewContext & { sql: SqlClient.SqlClient; githubCli: GitHubCliShape },
): PrHubReviewMethods {
  const {
    sql,
    githubCli,
    cwd,
    sourceControlProviders,
    trackedPrByKey,
    getFiles,
    prHubActionError,
    requestRefresh,
    invalidateThreads,
  } = context;
  const activeSubmissions = new Set<string>();
  const exclusive = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (activeSubmissions.has(key))
          return Effect.fail(
            prHubActionError("A review submission or recovery is still running for this PR."),
          );
        activeSubmissions.add(key);
        return Effect.void;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          activeSubmissions.delete(key);
        }),
    );
  const draftOwner = (key: Parameters<PrHubServiceShape["getReviewDraft"]>[0]["key"]) =>
    Effect.gen(function* () {
      const pr = yield* trackedPrByKey(key);
      const captured = yield* Effect.serviceOption(GitHubCredentialScope);
      if (Option.isNone(captured))
        return yield* new SourceControlProviderError({
          provider: pr.provider,
          operation: "prHub.reviewDraft",
          kind: "unauthenticated",
          detail: "A verified account is required.",
        });
      return {
        provider: pr.provider,
        host: pr.host,
        viewerId: String(captured.value.viewerId),
        repo: pr.repository.nameWithOwner,
        number: pr.number,
      };
    });
  const draftError = (cause: unknown) =>
    new SourceControlProviderError({
      provider: "github",
      operation: "prHub.reviewDraft",
      kind: "generic",
      detail: "The review draft could not be read or saved.",
      cause,
    });
  const getReviewDraft: PrHubServiceShape["getReviewDraft"] = (input) =>
    draftOwner(input.key).pipe(
      Effect.flatMap((owner) =>
        readPrHubReviewDraft(owner).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
      Effect.map((draft) => ({ status: "ok" as const, draft })),
      Effect.mapError(draftError),
    );
  const validateDraftComparison = (
    key: PullRequestKey,
    expected: PrHubReviewDraft["comparison"],
    content: PrHubReviewDraft["content"],
  ) =>
    Effect.gen(function* () {
      if (expected.mode !== "current_pr")
        return yield* prHubActionError("Only the current PR comparison supports review comments.");
      const remaining = new Map(content.comments.map((comment) => [comment.id, comment]));
      const viewedFiles: (typeof content.viewedFiles)[number][] = [];
      let cursor: string | undefined;
      do {
        const page = yield* getFiles({ key, mode: "force", ...(cursor ? { cursor } : {}) });
        if (!prComparisonsEqual(page.comparison, expected))
          return yield* prHubActionError(
            "The PR comparison changed. Revalidate your draft before submitting.",
          );
        for (const file of page.files) {
          if (
            content.viewedFiles.some(
              (viewed) => viewed.path === file.path && viewed.blobOid === file.blobOid,
            )
          )
            viewedFiles.push({ path: file.path, blobOid: file.blobOid! });
          for (const [id, comment] of remaining) {
            if (file.path !== comment.path) continue;
            if (
              file.patchStatus !== "available" ||
              !file.patch ||
              !prReviewLines(file.patch).get(comment.side)?.has(comment.line)
            )
              return yield* prHubActionError(
                "A review comment no longer points to a commentable diff line.",
              );
            if (comment.startLine !== undefined) {
              if (comment.startSide !== comment.side || comment.line - comment.startLine > 200_000)
                return yield* prHubActionError("Invalid multiline review anchor.");
              const lines = prReviewLines(file.patch).get(comment.side);
              for (let line = comment.startLine; line <= comment.line; line++)
                if (!lines?.has(line))
                  return yield* prHubActionError(
                    "The review range crosses unavailable diff lines.",
                  );
            }
            remaining.delete(id);
          }
        }
        cursor =
          (remaining.size || content.viewedFiles.length) && page.pageInfo.hasNextPage
            ? (page.pageInfo.endCursor ?? undefined)
            : undefined;
      } while (cursor);
      if (remaining.size)
        return yield* prHubActionError(
          "Some review comment files are unavailable. Revalidate the draft before submission.",
        );
      return { ...content, viewedFiles };
    });
  const saveReviewDraft: PrHubServiceShape["saveReviewDraft"] = (input) =>
    draftOwner(input.key).pipe(
      Effect.flatMap((owner) =>
        Effect.gen(function* () {
          const content = input.revalidate
            ? yield* validateDraftComparison(input.key, input.comparison, input.content)
            : input.content;
          return yield* savePrHubReviewDraft(owner, { ...input, content }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        }),
      ),
      Effect.mapError(draftError),
    );

  const reviewDependencies = (key: Parameters<PrHubServiceShape["getReviewDraft"]>[0]["key"]) =>
    Effect.gen(function* () {
      const owner = yield* draftOwner(key);
      const capture = yield* Effect.serviceOption(GitHubCredentialScope);
      if (Option.isNone(capture)) return yield* prHubActionError("A verified account is required.");
      const context = capture.value;
      const request: ReviewSubmissionDependencies["request"] = (method, endpoint, body, query) =>
        githubCli
          .request({
            cwd,
            context,
            method,
            endpoint,
            ...(body === undefined ? {} : { body }),
            ...(query ? { query } : {}),
          })
          .pipe(Effect.mapError(mapGitHubCliError));
      const verify: ReviewSubmissionDependencies["verify"] = (operation) =>
        Effect.gen(function* () {
          const expected = operation.payload.draft.comparison;
          yield* validateDraftComparison(key, expected, operation.payload.draft.content);
          const response = yield* request(
            "GET",
            `repos/${owner.repo.split("/").map(encodeURIComponent).join("/")}/pulls/${owner.number}`,
          );
          const live = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              state: Schema.String,
              locked: Schema.Boolean,
              user: Schema.Struct({ id: Schema.Number }),
              base: Schema.Struct({
                sha: Schema.String,
                ref: Schema.String,
                repo: Schema.Struct({ full_name: Schema.String }),
              }),
              head: Schema.Struct({
                sha: Schema.String,
                ref: Schema.String,
                repo: Schema.Struct({ full_name: Schema.String }),
              }),
            }),
          )(response.body).pipe(
            Effect.mapError(() =>
              prHubActionError("GitHub permissions and PR state could not be verified."),
            ),
          );
          if (
            response.status !== 200 ||
            live.state !== "open" ||
            live.locked ||
            (String(live.user.id) === owner.viewerId && operation.payload.event !== "COMMENT")
          )
            return yield* prHubActionError(
              "This review action is not permitted for the current PR state and account.",
            );
          if (
            live.base.sha !== expected.baseOid ||
            live.base.ref !== expected.baseRef ||
            live.base.repo.full_name !== expected.baseRepository ||
            live.head.sha !== expected.headOid ||
            live.head.ref !== expected.headRef ||
            live.head.repo.full_name !== expected.headRepository
          )
            return yield* prHubActionError("The PR changed while validating the review.");
          const current = yield* githubCli
            .getCredentialContext({ cwd, host: owner.host })
            .pipe(Effect.mapError(mapGitHubCliError));
          if (current.generation !== context.generation)
            return yield* prHubActionError("The GitHub account changed. The review was not sent.");
        });
      return { owner, dependencies: { request, verify } satisfies ReviewSubmissionDependencies };
    });
  const reviewError = (cause: unknown) =>
    Schema.is(SourceControlProviderError)(cause)
      ? cause
      : new SourceControlProviderError({
          provider: "github",
          operation: "prHub.review",
          kind: "generic",
          detail: "The review operation could not be completed. Its saved state is retained.",
          cause,
        });
  const prepareReview: PrHubServiceShape["prepareReview"] = (input) =>
    draftOwner(input.key).pipe(
      Effect.flatMap((owner) => prepareReviewOperation(owner, input)),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(reviewError),
    );
  const annotateSubmittedComparison = (key: PullRequestKey, operation: PrHubReviewOperation) =>
    operation.status !== "succeeded"
      ? Effect.succeed(operation)
      : getFiles({ key, mode: "force" }).pipe(
          Effect.map(
            (page): PrHubReviewOperation => ({
              ...operation,
              comparisonStatus: prComparisonsEqual(
                page.comparison,
                operation.payload.draft.comparison,
              )
                ? "current"
                : "outdated",
            }),
          ),
          Effect.catch(() =>
            Effect.succeed({ ...operation, comparisonStatus: "unverified" as const }),
          ),
        );
  const submitReview: PrHubServiceShape["submitReview"] = (input) =>
    reviewDependencies(input.key).pipe(
      Effect.flatMap(({ owner, dependencies }) =>
        exclusive(JSON.stringify(owner), submitPreparedReview(owner, input.id, dependencies)),
      ),
      Effect.flatMap((result) => annotateSubmittedComparison(input.key, result)),
      Effect.tap((result) => (result.status === "succeeded" ? requestRefresh : Effect.void)),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(reviewError),
    );
  const recoverReview: PrHubServiceShape["recoverReview"] = (input) =>
    reviewDependencies(input.key).pipe(
      Effect.flatMap(({ owner, dependencies }) =>
        exclusive(
          JSON.stringify(owner),
          Effect.gen(function* () {
            if (input.action === "link") {
              if (!input.remoteId)
                return yield* prHubActionError("Enter the GitHub review ID to verify.");
              return yield* linkReviewSubmission(owner, input.id, input.remoteId, dependencies);
            }
            const operation = yield* readReviewOperation(owner, input.id);
            if (
              !operation ||
              !["creating", "created", "submitting", "outcome_unknown"].includes(operation.status)
            )
              return yield* prHubActionError("This review does not require recovery.");
            yield* transitionReviewOperation(owner, {
              id: input.id,
              from: operation.status,
              to: "abandoned",
            });
            return (yield* readReviewOperation(owner, input.id))!;
          }),
        ),
      ),
      Effect.flatMap((result) => annotateSubmittedComparison(input.key, result)),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(reviewError),
    );
  const getReviewOperation: PrHubServiceShape["getReviewOperation"] = (input) =>
    Effect.gen(function* () {
      const { owner, dependencies } = yield* reviewDependencies(input.key);
      const rows = yield* sql<{ operation_id: string }>`SELECT operation_id FROM pr_hub_operations
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
        AND repo = ${owner.repo} AND number = ${owner.number} AND kind = 'review'
      ORDER BY CASE WHEN status IN ('prepared', 'creating', 'created', 'submitting', 'outcome_unknown') THEN 0 ELSE 1 END,
        draft_version DESC, created_at DESC, operation_id DESC LIMIT 1`;
      if (!rows[0]) return null;
      const operation = yield* reconcileReviewSubmission(owner, rows[0].operation_id, dependencies);
      return operation ? yield* annotateSubmittedComparison(input.key, operation) : null;
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));
  const cancelReviewPreparation: PrHubServiceShape["cancelReviewPreparation"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* draftOwner(input.key);
      yield* transitionReviewOperation(owner, {
        id: input.id,
        from: "prepared",
        to: "failed_before_send",
      });
      const result = yield* readReviewOperation(owner, input.id);
      if (!result) return yield* prHubActionError("Review operation not found.");
      return result;
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));

  const threadReaderContext = (key: Parameters<PrHubServiceShape["getReviewDraft"]>[0]["key"]) =>
    Effect.gen(function* () {
      const pr = yield* trackedPrByKey(key);
      const capture = yield* Effect.serviceOption(GitHubCredentialScope);
      if (Option.isNone(capture)) return yield* prHubActionError("A verified account is required.");
      const credential = capture.value;
      const provider = yield* sourceControlProviders.get(pr.provider);
      return {
        key,
        host: pr.host,
        repository: pr.repository.nameWithOwner,
        number: pr.number,
        account: credential.generation,
        query: (document, variables) => provider.query({ cwd, host: pr.host, document, variables }),
        verifyAccount: githubCli.getCredentialContext({ cwd, host: pr.host }).pipe(
          Effect.mapError(mapGitHubCliError),
          Effect.flatMap((current) =>
            current.generation === credential.generation
              ? Effect.void
              : Effect.fail(prHubActionError("The GitHub account changed.")),
          ),
        ),
      } satisfies ThreadReaderContext;
    });
  const getReviewThreads: PrHubServiceShape["getReviewThreads"] = (input) =>
    threadReaderContext(input.key).pipe(
      Effect.flatMap((context) => readReviewThreadPage(context, input)),
      Effect.map(({ threads, pageInfo, comparisonVersion, refreshedAt }) => ({
        threads,
        pageInfo,
        comparisonVersion,
        refreshedAt,
      })),
    );
  const setReviewThreadState: PrHubServiceShape["setReviewThreadState"] = (input) =>
    threadReaderContext(input.key).pipe(
      Effect.flatMap((context) => setReviewThreadResolved(context, input.threadId, input.resolved)),
      Effect.tap(() => {
        invalidateThreads();
        return requestRefresh;
      }),
    );

  const replyReviewThread: PrHubServiceShape["replyReviewThread"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* draftOwner(input.key);
      const context = yield* threadReaderContext(input.key);
      const result = yield* exclusive(
        JSON.stringify([owner, input.threadId]),
        replyToReviewThread(owner, context, input),
      );
      if (result.status === "succeeded") {
        invalidateThreads();
        yield* requestRefresh;
      }
      return result;
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));
  const recoverReply: PrHubServiceShape["recoverReply"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* draftOwner(input.key);
      const context = yield* threadReaderContext(input.key);
      return yield* exclusive(
        JSON.stringify([owner, input.threadId]),
        recoverThreadReply(owner, context, input),
      );
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));
  const getReplyDraft: PrHubServiceShape["getReplyDraft"] = (input) =>
    Effect.gen(function* () {
      if (!input.threadId) return yield* prHubActionError("A review thread is required.");
      const owner = yield* draftOwner(input.key);
      return yield* readReplyDraft(owner, input.threadId);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));
  const saveReplyDraft: PrHubServiceShape["saveReplyDraft"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* draftOwner(input.key);
      return yield* persistReplyDraft(owner, input);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));
  const getReplyOperation: PrHubServiceShape["getReplyOperation"] = (input) =>
    Effect.gen(function* () {
      if (!input.threadId) return yield* prHubActionError("A review thread is required.");
      const owner = yield* draftOwner(input.key);
      const context = yield* threadReaderContext(input.key);
      return yield* reconcileThreadReply(owner, context, input.threadId);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(reviewError));

  return {
    getReviewDraft,
    saveReviewDraft,
    prepareReview,
    submitReview,
    getReviewOperation,
    cancelReviewPreparation,
    recoverReview,
    getReviewThreads,
    setReviewThreadState,
    replyReviewThread,
    getReplyOperation,
    getReplyDraft,
    recoverReply,
    saveReplyDraft,
  };
}

export const PrHubReviewOperationsLive = Layer.effect(
  PrHubReviewOperations,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const githubCli = yield* GitHubCli;
    return { create: (context: PrHubReviewContext) => create({ ...context, sql, githubCli }) };
  }),
);
