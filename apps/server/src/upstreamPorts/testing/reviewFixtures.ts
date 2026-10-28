import {
  CodeReviewWorkflowId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { buildCodeReviewWorkflowRecord } from "../../orchestration/workflowRecordBuilders.ts";
import type { PortReviewContext } from "../portReview.ts";
import type { PortReviewRecord } from "../store.ts";

export const REVIEW_NOW = "2026-10-22T12:00:00.000Z";
export const REVIEW_PR = "https://github.com/o/f5/pull/42";
export const REVIEW_SLOTS = {
  reviewerA: { provider: "codex", model: "gpt-5-codex" },
  reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
  consolidation: { provider: "codex", model: "gpt-5" },
} as const;

export function reviewThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  const turnId = TurnId.makeUnsafe("port-turn");
  const messageId = MessageId.makeUnsafe("port-outcome");
  return {
    id: ThreadId.makeUnsafe("port-thread"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Port: settings",
    model: "gpt-5-codex",
    modelSelection: { instanceId: "codex" as never, model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "f5/upstream-pr-1",
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: REVIEW_NOW,
      startedAt: REVIEW_NOW,
      completedAt: REVIEW_NOW,
      assistantMessageId: messageId,
    },
    archivedAt: null,
    deletedAt: null,
    createdAt: REVIEW_NOW,
    lastInteractionAt: REVIEW_NOW,
    updatedAt: REVIEW_NOW,
    estimatedContextTokens: null,
    messages: [
      {
        id: messageId,
        role: "assistant",
        text: "UPSTREAM-OUTCOME: pr " + REVIEW_PR,
        turnId,
        streaming: false,
        createdAt: REVIEW_NOW,
        updatedAt: REVIEW_NOW,
      },
    ],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    activities: [],
    checkpoints: [],
    compaction: null,
    session: null,
    ...overrides,
  };
}

export function reviewRecord(overrides: Partial<PortReviewRecord> = {}): PortReviewRecord {
  return {
    projectId: "project-1",
    clientRequestId: "request-1",
    groupIndex: 0,
    threadId: "port-thread",
    reviewers: REVIEW_SLOTS,
    status: "waiting",
    reviewWorkflowId: null,
    errorStage: null,
    detail: null,
    prUrl: null,
    reviewedHeadSha: null,
    finalHeadSha: null,
    reviewInputJson: null,
    applyCommandJson: null,
    applyTurnId: null,
    submitFailures: 0,
    attempt: 0,
    updatedAt: REVIEW_NOW,
    ...overrides,
  };
}

export function reviewWorkflow(completed = false) {
  const workflow = buildCodeReviewWorkflowRecord({
    workflowId: CodeReviewWorkflowId.makeUnsafe("review-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Review",
    slug: "review",
    templateId: "builtin.code-review.dual",
    templateVersion: 2,
    reviewPrompt: "Review " + REVIEW_PR,
    branch: null,
    createdAt: REVIEW_NOW,
    reviewThreadIdA: ThreadId.makeUnsafe("reviewer-a"),
    reviewThreadIdB: ThreadId.makeUnsafe("reviewer-b"),
    ...REVIEW_SLOTS,
  });
  return completed
    ? {
        ...workflow,
        reviewerA: { ...workflow.reviewerA, status: "completed" as const },
        reviewerB: { ...workflow.reviewerB, status: "completed" as const },
        consolidation: {
          ...workflow.consolidation,
          status: "completed" as const,
          threadId: ThreadId.makeUnsafe("consolidation"),
          pinnedTurnId: "report-turn",
          pinnedAssistantMessageId: "report-message",
        },
      }
    : workflow;
}

export function reviewContext(overrides: Partial<PortReviewContext> = {}): PortReviewContext {
  return {
    thread: reviewThread(),
    group: {
      projectId: "project-1",
      clientRequestId: "request-1",
      groupIndex: 0,
      threadId: "port-thread",
      submissionId: "port-submission",
      topicIds: ["pr-1"],
      command: {},
      status: "submitted",
      reason: null,
    },
    links: [
      {
        projectId: "project-1",
        clientRequestId: "request-1",
        groupIndex: 0,
        topicId: "pr-1",
        epoch: 2,
        threadId: "port-thread",
        state: "active",
      },
    ],
    groupSubmissionDisposition: "started",
    projectedPrUrl: null,
    prLookup: {
      kind: "found",
      origin: "o/f5",
      pr: {
        number: 42,
        url: REVIEW_PR,
        state: "open",
        headRepoFullName: "o/f5",
        headRef: "f5/upstream-pr-1",
        headSha: "abc",
      },
    },
    workflow: null,
    reviewerThreadsMissing: false,
    report: null,
    submission: null,
    ...overrides,
  };
}
