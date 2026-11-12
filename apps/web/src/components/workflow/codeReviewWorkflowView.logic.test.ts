import { describe, expect, it } from "vitest";
import {
  CodeReviewWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflow,
} from "@t3tools/contracts";

import {
  canRetryConsolidation,
  canRetryFailedReviewers,
  codeReviewPostAction,
  collectCodeReviewWorkflowErrors,
  statusLabel,
} from "./codeReviewWorkflowView.logic";

const NOW = "2026-04-02T12:00:00.000Z";

function makeWorkflow(overrides: Partial<CodeReviewWorkflow> = {}): CodeReviewWorkflow {
  return {
    id: CodeReviewWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Code review",
    slug: "code-review",
    reviewPrompt: "Review this branch",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("codeReviewWorkflowView.logic", () => {
  it("hides retry actions while the workflow is still pending", () => {
    const workflow = makeWorkflow();
    expect(statusLabel(workflow)).toBe("Pending");
    expect(canRetryFailedReviewers(workflow)).toBe(false);
    expect(canRetryConsolidation(workflow)).toBe(false);
  });

  it("shows reviewer retry only when a reviewer failed", () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer failed",
      },
    });
    expect(statusLabel(workflow)).toBe("Error");
    expect(canRetryFailedReviewers(workflow)).toBe(true);
    expect(canRetryConsolidation(workflow)).toBe(false);
  });

  it("shows merge retry only when consolidation failed after both reviews completed", () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "error",
        error: "Merge failed",
      },
    });
    expect(canRetryFailedReviewers(workflow)).toBe(false);
    expect(canRetryConsolidation(workflow)).toBe(true);
  });

  it("returns exact reviewer and merge errors with safe fallback messages", () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A provider disconnected",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "error",
        error: null,
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "error",
        error: "Merge timed out",
      },
    });

    expect(collectCodeReviewWorkflowErrors(workflow)).toEqual([
      {
        key: "reviewerA",
        step: "Reviewer A",
        message: "Reviewer A provider disconnected",
      },
      { key: "reviewerB", step: "Reviewer B", message: "Reviewer failed." },
      { key: "consolidation", step: "Merge", message: "Merge timed out" },
    ]);
  });
});

describe("codeReviewPostAction", () => {
  const pullRequest = {
    url: "https://github.com/acme/app/pull/42",
    key: "github:github.com/acme/app#42",
  };
  const completed = (post: CodeReviewWorkflow["post"] = null) =>
    makeWorkflow({
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "completed",
        pinnedTurnId: "turn-merge",
      },
      pullRequest,
      post,
    });
  const post = (
    status: NonNullable<CodeReviewWorkflow["post"]>["status"],
    consolidationTurnId = "turn-merge",
  ): NonNullable<CodeReviewWorkflow["post"]> => ({
    trigger: "manual",
    status,
    operationId: "op",
    consolidationTurnId,
    commentUrl: status === "posted" ? `${pullRequest.url}#issuecomment-1` : null,
    error: status === "failed" ? "Forbidden" : null,
    updatedAt: NOW,
  });

  it("offers nothing until a GitHub merged review exists", () => {
    expect(codeReviewPostAction(makeWorkflow({ pullRequest }))).toBeNull();
    expect(codeReviewPostAction({ ...completed(), pullRequest: null })).toBeNull();
    expect(
      codeReviewPostAction({
        ...completed(),
        pullRequest: {
          url: "https://gitlab.com/acme/app/-/merge_requests/5",
          key: "gitlab:gitlab.com/acme/app#5",
        },
      }),
    ).toBeNull();
  });

  it("maps post states to actions", () => {
    expect(codeReviewPostAction(completed())?.kind).toBe("post");
    expect(codeReviewPostAction(completed(post("posting")))?.kind).toBe("posting");
    expect(codeReviewPostAction(completed(post("posted")))).toEqual({
      kind: "posted",
      label: "Posted",
      commentUrl: `${pullRequest.url}#issuecomment-1`,
    });
    expect(codeReviewPostAction(completed(post("posted", "turn-old")))?.kind).toBe("post-again");
    expect(codeReviewPostAction(completed(post("failed")))?.kind).toBe("retry");
    expect(codeReviewPostAction(completed(post("needs_recovery")))?.kind).toBe("check");
  });

  it("lists failed posts with the other failed steps and in the status", () => {
    expect(collectCodeReviewWorkflowErrors(completed(post("failed")))).toEqual([
      { key: "post", step: "Post to PR", message: "Forbidden" },
    ]);
    expect(statusLabel(completed(post("failed")))).toBe("Completed · post failed");
    expect(statusLabel(completed(post("needs_recovery")))).toBe("Completed · post unconfirmed");
    expect(statusLabel(completed(post("posted")))).toBe("Completed");
  });
});
