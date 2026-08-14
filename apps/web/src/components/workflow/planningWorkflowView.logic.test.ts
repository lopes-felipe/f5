import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";

import { createPlanningWorkflow } from "../../test/workflowFixtures";
import {
  canRetryFailedPlanningWorkflow,
  collectPlanningWorkflowErrors,
  planningWorkflowStatusLabel,
} from "./planningWorkflowView.logic";

describe("planningWorkflowView.logic", () => {
  it("treats a nested review error as a workflow error with exact details", () => {
    const workflow = createPlanningWorkflow({
      branchA: {
        planTurnId: "plan-a",
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a-cross"),
            outputFilePath: null,
            status: "error",
            error: "WebSocket connection reset",
            retryCount: 2,
            lastRetryAt: null,
            updatedAt: "2026-03-11T12:00:00.000Z",
          },
        ],
      },
    });

    expect(planningWorkflowStatusLabel(workflow)).toBe("Error");
    expect(canRetryFailedPlanningWorkflow(workflow)).toBe(true);
    expect(collectPlanningWorkflowErrors(workflow)).toEqual([
      expect.objectContaining({
        step: "Reviews · Review A Cross",
        message: "WebSocket connection reset",
      }),
    ]);
  });

  it("attributes branch errors using planTurnId and errorStage", () => {
    const authoring = createPlanningWorkflow({
      branchA: {
        status: "error",
        error: "Author failed",
        errorStage: "authoring",
      },
    });
    const revision = createPlanningWorkflow({
      branchA: {
        planTurnId: "plan-a",
        status: "error",
        error: "Revision failed",
        errorStage: "revision",
      },
    });

    expect(collectPlanningWorkflowErrors(authoring)[0]?.step).toBe("Authoring · Branch A");
    expect(collectPlanningWorkflowErrors(revision)[0]?.step).toBe("Revision · Branch A");
  });

  it("uses the shared legacy fallback for authoring, reviews, and revision errors", () => {
    const authoring = createPlanningWorkflow({
      branchA: { status: "error", error: "legacy author error", errorStage: null },
    });
    const reviews = createPlanningWorkflow({
      branchA: {
        planTurnId: "plan-a",
        status: "error",
        error: "legacy review error",
        errorStage: null,
        reviews: [],
      },
    });
    const revision = createPlanningWorkflow({
      branchA: {
        planTurnId: "plan-a",
        status: "error",
        error: "legacy revision error",
        errorStage: null,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("completed-review"),
            outputFilePath: null,
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: "2026-03-11T12:00:00.000Z",
          },
        ],
      },
    });

    expect(collectPlanningWorkflowErrors(authoring)[0]?.step).toBe("Authoring · Branch A");
    expect(collectPlanningWorkflowErrors(reviews)[0]?.step).toBe("Reviews · Branch A");
    expect(collectPlanningWorkflowErrors(revision)[0]?.step).toBe("Revision · Branch A");
  });

  it("labels active branch revision explicitly", () => {
    const workflow = createPlanningWorkflow({
      branchA: { planTurnId: "plan-a", status: "revising" },
      branchB: { planTurnId: "plan-b", status: "reviews_saved" },
    });

    expect(planningWorkflowStatusLabel(workflow)).toBe("Revising");
  });
});
