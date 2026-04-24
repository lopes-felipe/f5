import { describe, expect, it } from "vitest";
import { PlanningWorkflowId, ProjectId, ThreadId, type PlanningWorkflow } from "@t3tools/contracts";

import { deriveTimelinePhases } from "./workflowSidebarTimeline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-03-26T00:00:00.000Z";

// Phase index constants — keep tests readable when the phase order shifts.
const AUTHORING = 0;
const REVIEWS = 1;
const REVISION = 2;
const MERGE = 3;
const IMPLEMENTATION = 4;
const CODE_REVIEW = 5;
const APPLY_REVIEWS = 6;

function makeWorkflow(
  overrides?: Partial<Pick<PlanningWorkflow, "selfReviewEnabled" | "implementation">>,
): PlanningWorkflow {
  return {
    id: PlanningWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Implement the thing",
    plansDirectory: "plans",
    selfReviewEnabled: overrides?.selfReviewEnabled ?? true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5-codex" },
      authorThreadId: ThreadId.makeUnsafe("author-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      authorThreadId: ThreadId.makeUnsafe("author-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: NOW,
    },
    implementation: overrides?.implementation ?? null,
    totalCostUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
}

function withBranches(
  workflow: PlanningWorkflow,
  patch: {
    aStatus?: PlanningWorkflow["branchA"]["status"];
    bStatus?: PlanningWorkflow["branchB"]["status"];
    aReviews?: PlanningWorkflow["branchA"]["reviews"];
    bReviews?: PlanningWorkflow["branchB"]["reviews"];
    aError?: string | null;
    bError?: string | null;
  },
): PlanningWorkflow {
  return {
    ...workflow,
    branchA: {
      ...workflow.branchA,
      status: patch.aStatus ?? workflow.branchA.status,
      reviews: patch.aReviews ?? workflow.branchA.reviews,
      error: patch.aError ?? workflow.branchA.error,
    },
    branchB: {
      ...workflow.branchB,
      status: patch.bStatus ?? workflow.branchB.status,
      reviews: patch.bReviews ?? workflow.branchB.reviews,
      error: patch.bError ?? workflow.branchB.error,
    },
  };
}

function withMerge(
  workflow: PlanningWorkflow,
  patch: Partial<PlanningWorkflow["merge"]>,
): PlanningWorkflow {
  return { ...workflow, merge: { ...workflow.merge, ...patch } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveTimelinePhases", () => {
  it("early authoring: authoring=active, later phases pending", () => {
    const phases = deriveTimelinePhases(makeWorkflow());

    expect(phases[AUTHORING]!.id).toBe("authoring");
    expect(phases[AUTHORING]!.state).toBe("active");
    expect(phases[AUTHORING]!.steps[0]!.state).toBe("active");
    expect(phases[AUTHORING]!.steps[1]!.state).toBe("active");

    expect(phases[REVIEWS]!.id).toBe("reviews");
    expect(phases[REVIEWS]!.state).toBe("pending");

    expect(phases[REVISION]!.id).toBe("revision");
    expect(phases[REVISION]!.state).toBe("pending");

    expect(phases[MERGE]!.id).toBe("merge");
    expect(phases[MERGE]!.state).toBe("pending");

    expect(phases[IMPLEMENTATION]!.id).toBe("implementation");
    expect(phases[IMPLEMENTATION]!.state).toBe("pending");

    expect(phases[CODE_REVIEW]!.id).toBe("code-review");
    expect(phases[CODE_REVIEW]!.state).toBe("pending");

    expect(phases[APPLY_REVIEWS]!.id).toBe("apply-reviews");
    expect(phases[APPLY_REVIEWS]!.state).toBe("pending");
  });

  it("plans saved: authoring=completed, placeholder reviews visible", () => {
    const workflow = withBranches(makeWorkflow(), {
      aStatus: "plan_saved",
      bStatus: "plan_saved",
    });
    const phases = deriveTimelinePhases(workflow);

    expect(phases[AUTHORING]!.state).toBe("completed");
    expect(phases[AUTHORING]!.steps[0]!.state).toBe("completed");
    expect(phases[AUTHORING]!.steps[1]!.state).toBe("completed");

    // Reviews still pending — placeholder rows visible
    expect(phases[REVIEWS]!.state).toBe("pending");
    expect(phases[REVIEWS]!.steps).toHaveLength(4); // cross A, cross B, self A, self B
    expect(phases[REVIEWS]!.steps.every((s) => s.threadId === null)).toBe(true);
    expect(phases[REVIEWS]!.steps.map((s) => s.label)).toEqual([
      "Review A Cross",
      "Review B Cross",
      "Review A Self",
      "Review B Self",
    ]);
  });

  it("reviews in progress with real review steps", () => {
    const workflow = withBranches(makeWorkflow(), {
      aStatus: "reviews_requested",
      bStatus: "reviews_requested",
      aReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-a"),
          outputFilePath: null,
          status: "running",
          error: null,
          updatedAt: NOW,
        },
      ],
      bReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-b"),
          outputFilePath: null,
          status: "completed",
          error: null,
          updatedAt: NOW,
        },
      ],
    });
    const phases = deriveTimelinePhases(workflow);

    expect(phases[REVIEWS]!.state).toBe("active");
    expect(phases[REVIEWS]!.steps).toHaveLength(2);
    expect(phases[REVIEWS]!.steps[0]!.label).toBe("Review A Cross");
    expect(phases[REVIEWS]!.steps[0]!.state).toBe("active");
    expect(phases[REVIEWS]!.steps[0]!.threadId).toBe("review-cross-a");
    expect(phases[REVIEWS]!.steps[1]!.label).toBe("Review B Cross");
    expect(phases[REVIEWS]!.steps[1]!.state).toBe("completed");
  });

  it("selfReviewEnabled=false → only cross review placeholders", () => {
    const workflow = withBranches(makeWorkflow({ selfReviewEnabled: false }), {
      aStatus: "plan_saved",
      bStatus: "plan_saved",
    });
    const phases = deriveTimelinePhases(workflow);

    expect(phases[REVIEWS]!.steps).toHaveLength(2);
    expect(phases[REVIEWS]!.steps.map((s) => s.label)).toEqual([
      "Review A Cross",
      "Review B Cross",
    ]);
  });

  it("merge active state", () => {
    const workflow = withMerge(
      withBranches(makeWorkflow(), {
        aStatus: "revised",
        bStatus: "revised",
      }),
      { status: "in_progress", threadId: ThreadId.makeUnsafe("merge-thread") },
    );
    const phases = deriveTimelinePhases(workflow);

    expect(phases[MERGE]!.state).toBe("active");
    expect(phases[MERGE]!.steps[0]!.threadId).toBe("merge-thread");
    expect(phases[MERGE]!.steps[0]!.state).toBe("active");
  });

  it("merge completed (manual_review)", () => {
    const workflow = withMerge(
      withBranches(makeWorkflow(), {
        aStatus: "revised",
        bStatus: "revised",
      }),
      { status: "manual_review", threadId: ThreadId.makeUnsafe("merge-thread") },
    );
    const phases = deriveTimelinePhases(workflow);

    expect(phases[MERGE]!.state).toBe("completed");
    expect(phases[MERGE]!.steps[0]!.state).toBe("completed");
  });

  it("implementation active: implementation step only, code review is its own phase", () => {
    const workflow = withMerge(
      withBranches(
        makeWorkflow({
          implementation: {
            implementationSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("impl-thread"),
            implementationTurnId: "impl-turn",
            revisionTurnId: null,
            codeReviewEnabled: true,
            codeReviews: [
              {
                reviewerLabel: "Author A (codex:gpt-5-codex)",
                reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
                threadId: ThreadId.makeUnsafe("code-review-a"),
                status: "running",
                error: null,
                retryCount: 0,
                lastRetryAt: null,
                updatedAt: NOW,
              },
            ],
            status: "code_reviews_requested",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        }),
        {
          aStatus: "revised",
          bStatus: "revised",
        },
      ),
      { status: "manual_review", threadId: ThreadId.makeUnsafe("merge-thread") },
    );
    const phases = deriveTimelinePhases(workflow);

    // Implementation phase has exactly one step — no code-review sub-steps.
    expect(phases[IMPLEMENTATION]!.state).toBe("active");
    expect(phases[IMPLEMENTATION]!.steps).toHaveLength(1);
    expect(phases[IMPLEMENTATION]!.steps[0]!.key).toBe("implementation");
    expect(phases[IMPLEMENTATION]!.steps[0]!.state).toBe("active");
    expect(phases[IMPLEMENTATION]!.steps[0]!.threadId).toBe("impl-thread");

    // Code Review phase owns the review steps with generic labels.
    expect(phases[CODE_REVIEW]!.state).toBe("active");
    expect(phases[CODE_REVIEW]!.steps).toHaveLength(1);
    expect(phases[CODE_REVIEW]!.steps[0]!.label).toBe("Code Review A");
    expect(phases[CODE_REVIEW]!.steps[0]!.state).toBe("active");
    expect(phases[CODE_REVIEW]!.steps[0]!.threadId).toBe("code-review-a");

    // Apply Reviews has not started yet.
    expect(phases[APPLY_REVIEWS]!.state).toBe("pending");
  });

  it("implementation completed", () => {
    const workflow = withMerge(
      withBranches(
        makeWorkflow({
          implementation: {
            implementationSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("impl-thread"),
            implementationTurnId: "impl-turn",
            revisionTurnId: null,
            codeReviewEnabled: true,
            codeReviews: [],
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        }),
        {
          aStatus: "revised",
          bStatus: "revised",
        },
      ),
      { status: "manual_review", threadId: ThreadId.makeUnsafe("merge-thread") },
    );
    const phases = deriveTimelinePhases(workflow);

    expect(phases[IMPLEMENTATION]!.state).toBe("completed");
    expect(phases[IMPLEMENTATION]!.steps[0]!.state).toBe("completed");
    expect(phases[APPLY_REVIEWS]!.state).toBe("completed");
    expect(phases[APPLY_REVIEWS]!.steps[0]!.state).toBe("completed");
  });

  it("error states propagate correctly", () => {
    // Branch A error → authoring phase error
    const branchError = withBranches(makeWorkflow(), {
      aStatus: "error",
      aError: "something failed",
    });
    const branchPhases = deriveTimelinePhases(branchError);
    expect(branchPhases[AUTHORING]!.state).toBe("error");
    expect(branchPhases[AUTHORING]!.steps[0]!.state).toBe("error");
    expect(branchPhases[AUTHORING]!.steps[1]!.state).toBe("active"); // B is still pending
    // Revision phase does not claim errors that occurred before reviews.
    expect(branchPhases[REVISION]!.state).toBe("pending");

    // Review error → reviews phase error
    const reviewError = withBranches(makeWorkflow(), {
      aStatus: "reviews_requested",
      bStatus: "reviews_requested",
      aReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-a"),
          outputFilePath: null,
          status: "error",
          error: "review failed",
          updatedAt: NOW,
        },
      ],
    });
    const reviewPhases = deriveTimelinePhases(reviewError);
    expect(reviewPhases[REVIEWS]!.state).toBe("error");
    expect(reviewPhases[REVIEWS]!.steps[0]!.state).toBe("error");

    // Merge error → merge phase error
    const mergeError = withMerge(makeWorkflow(), { status: "error" });
    const mergePhases = deriveTimelinePhases(mergeError);
    expect(mergePhases[MERGE]!.state).toBe("error");

    // Implementation error → implementation phase error
    const implError = withMerge(
      withBranches(
        makeWorkflow({
          implementation: {
            implementationSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("impl-thread"),
            implementationTurnId: null,
            revisionTurnId: null,
            codeReviewEnabled: true,
            codeReviews: [],
            status: "error",
            error: "impl failed",
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        }),
        {
          aStatus: "revised",
          bStatus: "revised",
        },
      ),
      { status: "manual_review", threadId: ThreadId.makeUnsafe("merge-thread") },
    );
    const implPhases = deriveTimelinePhases(implError);
    expect(implPhases[IMPLEMENTATION]!.state).toBe("error");
    // Apply Reviews should not claim the error — code reviews never completed.
    expect(implPhases[APPLY_REVIEWS]!.state).toBe("pending");
  });

  it("always returns exactly 7 phases in the canonical order", () => {
    const phases = deriveTimelinePhases(makeWorkflow());

    expect(phases).toHaveLength(7);
    expect(phases.map((p) => p.id)).toEqual([
      "authoring",
      "reviews",
      "revision",
      "merge",
      "implementation",
      "code-review",
      "apply-reviews",
    ]);
  });

  it("authoring step threadIds are always present", () => {
    const phases = deriveTimelinePhases(makeWorkflow());
    expect(phases[AUTHORING]!.steps[0]!.threadId).toBe("author-a");
    expect(phases[AUTHORING]!.steps[1]!.threadId).toBe("author-b");
  });

  it("merge step threadId is null when merge has not started", () => {
    const phases = deriveTimelinePhases(makeWorkflow());
    expect(phases[MERGE]!.steps[0]!.threadId).toBeNull();
  });

  it("implementation step threadId is null when no implementation exists", () => {
    const phases = deriveTimelinePhases(makeWorkflow());
    expect(phases[IMPLEMENTATION]!.steps[0]!.threadId).toBeNull();
    expect(phases[IMPLEMENTATION]!.steps).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Revision phase
  // -------------------------------------------------------------------------

  describe("revision phase", () => {
    it("pending when branches haven't finished reviews", () => {
      const workflow = withBranches(makeWorkflow(), {
        aStatus: "plan_saved",
        bStatus: "plan_saved",
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[REVISION]!.state).toBe("pending");
      expect(phases[REVISION]!.steps).toHaveLength(2);
      expect(phases[REVISION]!.steps[0]!.state).toBe("pending");
      expect(phases[REVISION]!.steps[1]!.state).toBe("pending");
    });

    it("active when both branches have finished reviews but not started revising", () => {
      const workflow = withBranches(makeWorkflow(), {
        aStatus: "reviews_saved",
        bStatus: "reviews_saved",
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[REVISION]!.state).toBe("active");
      // No branch is actively revising yet, so per-branch steps remain pending.
      expect(phases[REVISION]!.steps[0]!.state).toBe("pending");
      expect(phases[REVISION]!.steps[1]!.state).toBe("pending");
    });

    it("active when one branch is revising", () => {
      const workflow = withBranches(makeWorkflow(), {
        aStatus: "revising",
        bStatus: "revised",
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[REVISION]!.state).toBe("active");
      expect(phases[REVISION]!.steps[0]!.state).toBe("active");
      expect(phases[REVISION]!.steps[1]!.state).toBe("completed");
    });

    it("completed when both branches are revised", () => {
      const workflow = withBranches(makeWorkflow(), {
        aStatus: "revised",
        bStatus: "revised",
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[REVISION]!.state).toBe("completed");
      expect(phases[REVISION]!.steps[0]!.state).toBe("completed");
      expect(phases[REVISION]!.steps[1]!.state).toBe("completed");
    });

    it("error when a branch errors past the reviews_saved stage", () => {
      const workflow = withBranches(makeWorkflow(), {
        aStatus: "error",
        bStatus: "revising",
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[REVISION]!.state).toBe("error");
      expect(phases[REVISION]!.steps[0]!.state).toBe("error");
      expect(phases[REVISION]!.steps[1]!.state).toBe("active");
    });

    it("steps link to the author thread (revision is a turn on that thread)", () => {
      const phases = deriveTimelinePhases(makeWorkflow());
      expect(phases[REVISION]!.steps[0]!.threadId).toBe("author-a");
      expect(phases[REVISION]!.steps[1]!.threadId).toBe("author-b");
    });
  });

  // -------------------------------------------------------------------------
  // Code Review phase
  // -------------------------------------------------------------------------

  describe("code review phase", () => {
    it("pending with no steps when no code reviews exist", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [],
          status: "implementing",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[CODE_REVIEW]!.state).toBe("pending");
      expect(phases[CODE_REVIEW]!.steps).toHaveLength(0);
    });

    it("pending with no steps when implementation is null", () => {
      const phases = deriveTimelinePhases(makeWorkflow());
      expect(phases[CODE_REVIEW]!.state).toBe("pending");
      expect(phases[CODE_REVIEW]!.steps).toHaveLength(0);
    });

    it("uses generic positional labels (Code Review A / Code Review B)", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Author A (codex:gpt-5-codex)",
              reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "running",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
            {
              reviewerLabel: "Author B (claudeAgent:claude-sonnet-4-5)",
              reviewerSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
              threadId: ThreadId.makeUnsafe("code-review-b"),
              status: "pending",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
          status: "code_reviews_requested",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[CODE_REVIEW]!.steps.map((s) => s.label)).toEqual([
        "Code Review A",
        "Code Review B",
      ]);
      // No reviewer model name should leak through.
      expect(phases[CODE_REVIEW]!.steps.some((s) => s.label.includes("codex"))).toBe(false);
      expect(phases[CODE_REVIEW]!.steps.some((s) => s.label.includes("claudeAgent"))).toBe(false);
    });

    it("completed when all reviews completed and status is past code_reviews_saved", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Author A (codex:gpt-5-codex)",
              reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "completed",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
          status: "code_reviews_saved",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[CODE_REVIEW]!.state).toBe("completed");
      expect(phases[CODE_REVIEW]!.steps[0]!.state).toBe("completed");
    });

    it("error when any code review errors", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Author A (codex:gpt-5-codex)",
              reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "error",
              error: "review failed",
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
          status: "code_reviews_requested",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[CODE_REVIEW]!.state).toBe("error");
      expect(phases[CODE_REVIEW]!.steps[0]!.state).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  // Apply Reviews phase
  // -------------------------------------------------------------------------

  describe("apply reviews phase", () => {
    it("pending before code reviews complete", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: null,
          codeReviewEnabled: true,
          codeReviews: [],
          status: "implementing",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[APPLY_REVIEWS]!.state).toBe("pending");
      expect(phases[APPLY_REVIEWS]!.steps[0]!.state).toBe("pending");
    });

    it("active when status is applying_reviews", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: "rev-turn",
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Author A (codex:gpt-5-codex)",
              reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "completed",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
          status: "applying_reviews",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[APPLY_REVIEWS]!.state).toBe("active");
      expect(phases[APPLY_REVIEWS]!.steps[0]!.state).toBe("active");
      expect(phases[APPLY_REVIEWS]!.steps[0]!.threadId).toBe("impl-thread");
    });

    it("completed when the implementation is completed", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: "rev-turn",
          codeReviewEnabled: true,
          codeReviews: [],
          status: "completed",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[APPLY_REVIEWS]!.state).toBe("completed");
      expect(phases[APPLY_REVIEWS]!.steps[0]!.state).toBe("completed");
    });

    it("error when implementation errors after code reviews completed", () => {
      const workflow = makeWorkflow({
        implementation: {
          implementationSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("impl-thread"),
          implementationTurnId: "impl-turn",
          revisionTurnId: "rev-turn",
          codeReviewEnabled: true,
          codeReviews: [
            {
              reviewerLabel: "Author A (codex:gpt-5-codex)",
              reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "completed",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
          status: "error",
          error: "apply failed",
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      });
      const phases = deriveTimelinePhases(workflow);
      expect(phases[APPLY_REVIEWS]!.state).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  // Retry scenarios
  // -------------------------------------------------------------------------

  it("retry: pending step with existing threadId preserves the threadId", () => {
    // After resetWorkflowForRetry, a branch is reset to "pending" but its
    // authorThreadId is never cleared. The step should still expose that
    // threadId so the UI can render a navigable link.
    const workflow = withBranches(makeWorkflow(), {
      aStatus: "pending",
      bStatus: "revised",
    });
    const phases = deriveTimelinePhases(workflow);

    // Branch A is pending but its threadId must still be present
    expect(phases[AUTHORING]!.steps[0]!.state).toBe("active");
    expect(phases[AUTHORING]!.steps[0]!.threadId).toBe("author-a");
  });

  it("retry: reviews phase shows completed when branches reset but reviews preserved", () => {
    // resetWorkflowForRetry resets branch status to "pending" but preserves
    // completed review threads. The reviews phase should reflect the actual
    // review statuses, not just the branch-level flags.
    const workflow = withBranches(makeWorkflow(), {
      aStatus: "pending",
      bStatus: "pending",
      aReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-a"),
          outputFilePath: null,
          status: "completed",
          error: null,
          updatedAt: NOW,
        },
      ],
      bReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-b"),
          outputFilePath: null,
          status: "completed",
          error: null,
          updatedAt: NOW,
        },
      ],
    });
    const phases = deriveTimelinePhases(workflow);

    // Reviews should be "completed" because all review objects are completed,
    // even though both branches are at "pending".
    expect(phases[REVIEWS]!.state).toBe("completed");
    expect(phases[REVIEWS]!.steps).toHaveLength(2);
    expect(phases[REVIEWS]!.steps[0]!.state).toBe("completed");
    expect(phases[REVIEWS]!.steps[0]!.threadId).toBe("review-cross-a");
    expect(phases[REVIEWS]!.steps[1]!.state).toBe("completed");
    expect(phases[REVIEWS]!.steps[1]!.threadId).toBe("review-cross-b");
  });

  it("retry: reviews phase shows active when branches reset with mixed review statuses", () => {
    // Partial retry scenario: one review completed, one still pending.
    const workflow = withBranches(makeWorkflow(), {
      aStatus: "pending",
      bStatus: "pending",
      aReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-a"),
          outputFilePath: null,
          status: "completed",
          error: null,
          updatedAt: NOW,
        },
      ],
      bReviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-cross-b"),
          outputFilePath: null,
          status: "pending",
          error: null,
          updatedAt: NOW,
        },
      ],
    });
    const phases = deriveTimelinePhases(workflow);

    // Reviews exist but aren't all completed → active, not pending
    expect(phases[REVIEWS]!.state).toBe("active");
  });
});
