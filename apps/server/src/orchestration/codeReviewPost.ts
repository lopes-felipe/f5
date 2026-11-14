import type {
  CodeReviewPost,
  CodeReviewWorkflow,
  OrchestrationReadModel,
  PrHubCommentOperation,
  PullRequestKey,
} from "@t3tools/contracts";
import {
  CODE_REVIEW_POST_BODY_MAX_CHARS,
  codeReviewPostFooter,
  formatCodeReviewReport,
  isGitHubCodeReviewPullRequest,
} from "@t3tools/shared/codeReviewPullRequest";
import { Cause, Effect } from "effect";

import { userFacingCauseMessage } from "../causeMessage.ts";
import type { PrHubFederationShape } from "../prHub/Layers/PrHubFederation.ts";

export const CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE =
  "GitHub may have received the comment. Check again re-verifies it without resending; Post anyway abandons that attempt and posts again, which can leave a duplicate comment.";

export interface CodeReviewPostJob {
  readonly workflowId: CodeReviewWorkflow["id"];
  readonly operationId: string;
  /** Re-verify an unknown outcome only; never prepares or sends. */
  readonly checkOnly: boolean;
  /**
   * Resumed after a restart: the operation may already have been sent, so a
   * failure before it is read back cannot be reported as "not posted".
   */
  readonly resumed: boolean;
  /** A previous attempt's operation, which may still be pending in PR Hub. */
  readonly supersededOperationId: string | null;
  /**
   * The previous attempt delivered this same merged review and its outcome is
   * not known to be negative, so a sent or unknown operation is adopted rather
   * than posted over.
   */
  readonly adoptSuperseded: boolean;
  /** "Post anyway": abandon a superseded operation whose outcome is unknown. */
  readonly abandonSuperseded: boolean;
}

export type CodeReviewPostOutcome = Pick<CodeReviewPost, "status" | "commentUrl" | "error"> & {
  /** Set when the outcome belongs to an adopted earlier operation. */
  readonly operationId?: string | undefined;
};

export function newCodeReviewPostOperationId(workflowId: string): string {
  return `f5-code-review:${workflowId}:${crypto.randomUUID()}`;
}

export function withCodeReviewPost(
  workflow: CodeReviewWorkflow,
  post: CodeReviewPost | null,
  updatedAt: string,
): CodeReviewWorkflow {
  return { ...workflow, post, updatedAt };
}

export function startedCodeReviewPost(input: {
  readonly workflow: CodeReviewWorkflow;
  readonly trigger: CodeReviewPost["trigger"];
  readonly operationId: string;
  readonly updatedAt: string;
}): CodeReviewPost {
  return {
    trigger: input.trigger,
    status: "posting",
    operationId: input.operationId,
    consolidationTurnId: input.workflow.consolidation.pinnedTurnId,
    commentUrl: null,
    error: null,
    updatedAt: input.updatedAt,
  };
}

/** Auto-post fires once per workflow, after the first completed merge. */
export function shouldAutoPostCodeReview(workflow: CodeReviewWorkflow): boolean {
  return (
    workflow.autoPost === true &&
    !workflow.post &&
    workflow.deletedAt === null &&
    workflow.consolidation.status === "completed" &&
    isGitHubCodeReviewPullRequest(workflow.pullRequest)
  );
}

/** Why a manual post cannot start now, or null when it can. */
export function manualCodeReviewPostBlocker(workflow: CodeReviewWorkflow): string | null {
  if (workflow.deletedAt !== null) return "This code review was deleted.";
  if (workflow.consolidation.status !== "completed") {
    return "The merged review is not finished yet.";
  }
  if (!isGitHubCodeReviewPullRequest(workflow.pullRequest)) {
    return "This code review has no GitHub pull request to post to.";
  }
  if (workflow.post?.status === "posting") return "The merged review is already being posted.";
  if (
    workflow.post?.status === "posted" &&
    workflow.post.consolidationTurnId === workflow.consolidation.pinnedTurnId
  ) {
    return "This merged review is already posted.";
  }
  return null;
}

/**
 * The merged review exactly as the workflow page shows it: the pinned
 * assistant message's text. Reasoning and proposed plans are internal
 * agent-to-agent channels and are never published.
 */
export function codeReviewMergedReviewText(
  workflow: CodeReviewWorkflow,
  snapshot: Pick<OrchestrationReadModel, "threads">,
): string | null {
  const threadId = workflow.consolidation.threadId;
  const thread = threadId ? snapshot.threads.find((entry) => entry.id === threadId) : undefined;
  if (!thread) return null;
  const pinnedId = workflow.consolidation.pinnedAssistantMessageId;
  const message = pinnedId
    ? thread.messages.find((entry) => entry.id === pinnedId)
    : thread.messages.toReversed().find((entry) => entry.role === "assistant" && !entry.streaming);
  const text = message?.text.trim() ?? "";
  return text.length > 0 ? text : null;
}

export function codeReviewPostBody(workflow: CodeReviewWorkflow, mergedReview: string): string {
  return formatCodeReviewReport(mergedReview, {
    pullRequest: workflow.pullRequest,
    footer: codeReviewPostFooter({
      reviewerA: workflow.reviewerA.slot,
      reviewerB: workflow.reviewerB.slot,
      consolidation: workflow.consolidation.slot,
    }),
  });
}

function causeDetail(cause: Cause.Cause<unknown>, fallback: string): string {
  const squashed = Cause.squash(cause);
  if (
    squashed &&
    typeof squashed === "object" &&
    "detail" in squashed &&
    typeof squashed.detail === "string" &&
    squashed.detail.trim().length > 0
  ) {
    return squashed.detail.trim();
  }
  return userFacingCauseMessage(cause, fallback, { maxLength: 500 });
}

function outcomeFromOperation(
  operation: PrHubCommentOperation,
  pullRequestUrl: string,
): CodeReviewPostOutcome {
  switch (operation.status) {
    case "succeeded":
      return {
        status: "posted",
        commentUrl: operation.remoteId
          ? `${pullRequestUrl}#issuecomment-${operation.remoteId}`
          : pullRequestUrl,
        error: null,
      };
    case "creating":
    case "outcome_unknown":
      return {
        status: "needs_recovery",
        commentUrl: null,
        error: CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE,
      };
    case "prepared":
    case "failed_before_send":
    case "rejected":
    case "abandoned":
      return {
        status: "failed",
        commentUrl: null,
        error: operation.errorMessage?.trim() || "GitHub did not accept the comment.",
      };
  }
}

/**
 * Deliver the merged review through PR Hub's durable comment operation. The
 * operation id makes a resumed job idempotent: an existing operation is read
 * back instead of re-created, and only a `prepared` operation is ever sent.
 * Every call goes through the federated hub, which routes the PR to its
 * account and translates the account generation for that account's hub.
 */
export function runCodeReviewPostJob(input: {
  readonly federation: PrHubFederationShape | null;
  readonly workflow: CodeReviewWorkflow;
  readonly job: CodeReviewPostJob;
  readonly body: string | null;
}): Effect.Effect<CodeReviewPostOutcome> {
  const { workflow, job } = input;
  const pullRequest = workflow.pullRequest;
  const failed = (error: string): CodeReviewPostOutcome => ({
    status: "failed",
    commentUrl: null,
    error,
  });
  if (!pullRequest || !isGitHubCodeReviewPullRequest(pullRequest)) {
    return Effect.succeed(failed("This code review has no GitHub pull request to post to."));
  }
  if (!input.federation) {
    return Effect.succeed(failed("PR Hub is unavailable, so the review cannot be posted."));
  }
  const federation = input.federation;
  const hub = federation.hub;
  const needsRecovery = (detail?: string, operationId?: string): CodeReviewPostOutcome => ({
    status: "needs_recovery",
    commentUrl: null,
    error: detail
      ? `${CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE} (${detail})`
      : CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE,
    ...(operationId ? { operationId } : {}),
  });
  // Until our own operation is read back, a failure cannot prove the comment
  // is absent: a check, or a job resumed after a restart, may follow a send.
  let sendMayHaveStarted = job.checkOnly || job.resumed;

  return Effect.gen(function* () {
    const runtime = yield* federation.resolve({ url: pullRequest.url });
    const accountGeneration = runtime.account.generation;
    const tracked = yield* hub.track({ url: pullRequest.url, accountGeneration });
    const key: PullRequestKey = tracked.key;
    // Reads and reconciles exactly this operation, not the PR's latest one.
    const readOperation = (id: string) =>
      hub
        .getCommentOperation({ accountGeneration, key, id })
        .pipe(Effect.map((operation) => (operation?.id === id ? operation : null)));

    if (job.checkOnly) {
      const operation = yield* readOperation(job.operationId);
      return operation ? outcomeFromOperation(operation, pullRequest.url) : needsRecovery();
    }

    if (job.resumed) {
      const existing = yield* readOperation(job.operationId);
      if (existing && existing.status !== "prepared") {
        return outcomeFromOperation(existing, pullRequest.url);
      }
      // Missing or `prepared`: nothing was sent yet.
      sendMayHaveStarted = false;
    }

    if (job.supersededOperationId) {
      const superseded = yield* readOperation(job.supersededOperationId);
      if (superseded?.status === "prepared") {
        yield* hub.recoverComment({
          accountGeneration,
          key,
          id: superseded.id,
          payloadHash: superseded.payloadHash,
          action: "cancel",
        });
      } else if (
        superseded &&
        (superseded.status === "creating" || superseded.status === "outcome_unknown")
      ) {
        if (job.abandonSuperseded) {
          yield* hub.recoverComment({
            accountGeneration,
            key,
            id: superseded.id,
            payloadHash: superseded.payloadHash,
            action: "abandon",
          });
        } else if (job.adoptSuperseded) {
          return needsRecovery(undefined, superseded.id);
        }
      } else if (superseded?.status === "succeeded" && job.adoptSuperseded) {
        return { ...outcomeFromOperation(superseded, pullRequest.url), operationId: superseded.id };
      }
    }

    if (!input.body) return failed("The merged review text is unavailable.");
    if (input.body.length > CODE_REVIEW_POST_BODY_MAX_CHARS) {
      return failed(
        `The merged review is ${input.body.length.toLocaleString("en-US")} characters; GitHub comments allow ${CODE_REVIEW_POST_BODY_MAX_CHARS.toLocaleString("en-US")}.`,
      );
    }

    let operation = yield* hub.prepareComment({
      accountGeneration,
      key,
      id: job.operationId,
      body: input.body,
    });
    if (operation.status === "prepared") {
      sendMayHaveStarted = true;
      operation = yield* hub.submitComment({
        accountGeneration,
        key,
        id: operation.id,
        payloadHash: operation.payloadHash,
      });
    }
    if (operation.status === "creating" || operation.status === "outcome_unknown") {
      operation = (yield* readOperation(job.operationId)) ?? operation;
    }
    return outcomeFromOperation(operation, pullRequest.url);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(
        sendMayHaveStarted
          ? needsRecovery(causeDetail(cause, "Verification failed."))
          : failed(causeDetail(cause, "Could not post the merged review.")),
      ),
    ),
  );
}
