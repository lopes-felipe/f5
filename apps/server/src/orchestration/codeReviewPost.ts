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
import type { PrHubServiceShape } from "../prHub/Services/PrHubService.ts";
import { latestAssistantFeedback, reviewFeedbackForPinnedTurn } from "./workflowSharedUtils.ts";

export const CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE =
  "GitHub may have received the comment. Check the pull request; Check again re-verifies without resending.";

export interface CodeReviewPostJob {
  readonly workflowId: CodeReviewWorkflow["id"];
  readonly operationId: string;
  /** Re-verify an unknown outcome only; never prepares or sends. */
  readonly checkOnly: boolean;
  /** A previous attempt's operation that may still sit `prepared` in PR Hub. */
  readonly supersededOperationId: string | null;
}

export type CodeReviewPostOutcome = Pick<CodeReviewPost, "status" | "commentUrl" | "error">;

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

/** The pinned merged-review text from the consolidation thread. */
export function codeReviewMergedReviewText(
  workflow: CodeReviewWorkflow,
  snapshot: Pick<OrchestrationReadModel, "threads">,
): string | null {
  const threadId = workflow.consolidation.threadId;
  const thread = threadId ? snapshot.threads.find((entry) => entry.id === threadId) : undefined;
  if (!thread) return null;
  const feedback =
    reviewFeedbackForPinnedTurn(
      thread,
      workflow.consolidation.pinnedTurnId,
      workflow.consolidation.pinnedAssistantMessageId,
    ) ?? latestAssistantFeedback(thread, workflow.consolidation.pinnedAssistantMessageId);
  const text = feedback?.text.trim() ?? "";
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
  const needsRecovery = (detail?: string): CodeReviewPostOutcome => ({
    status: "needs_recovery",
    commentUrl: null,
    error: detail
      ? `${CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE} (${detail})`
      : CODE_REVIEW_POST_NEEDS_RECOVERY_MESSAGE,
  });
  // Once a send may have started, a failure no longer proves the comment is absent.
  let sendMayHaveStarted = job.checkOnly;

  return Effect.gen(function* () {
    const runtime = yield* federation.resolve({ url: pullRequest.url });
    const hub: PrHubServiceShape = runtime.hub;
    const accountGeneration = runtime.account.generation;
    const tracked = yield* hub.track({ url: pullRequest.url, accountGeneration });
    const key: PullRequestKey = tracked.key;

    // Reconciles an in-flight or unknown operation, then reports the PR's most
    // relevant one; it only answers for ours when the id matches.
    const readOwnOperation = hub
      .getCommentOperation({ accountGeneration, key })
      .pipe(Effect.map((operation) => (operation?.id === job.operationId ? operation : null)));

    if (job.checkOnly) {
      const operation = yield* readOwnOperation;
      return operation ? outcomeFromOperation(operation, pullRequest.url) : needsRecovery();
    }

    if (!input.body) return failed("The merged review text is unavailable.");
    if (input.body.length > CODE_REVIEW_POST_BODY_MAX_CHARS) {
      return failed(
        `The merged review is ${input.body.length.toLocaleString("en-US")} characters; GitHub comments allow ${CODE_REVIEW_POST_BODY_MAX_CHARS.toLocaleString("en-US")}.`,
      );
    }

    if (job.supersededOperationId) {
      const lingering = yield* hub.getCommentOperation({ accountGeneration, key });
      if (lingering?.id === job.supersededOperationId && lingering.status === "prepared") {
        yield* hub.recoverComment({
          accountGeneration,
          key,
          id: lingering.id,
          payloadHash: lingering.payloadHash,
          action: "cancel",
        });
      }
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
      operation = (yield* readOwnOperation) ?? operation;
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
