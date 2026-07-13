import {
  CodeReviewWorkflowId,
  InvestigationWorkflowId,
  PlanningWorkflowId,
  ProjectId,
  type WorkflowPlatformCreateRunInput,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { CodeReviewWorkflowServiceShape } from "./orchestration/Services/CodeReviewWorkflowService.ts";
import type { InvestigationWorkflowServiceShape } from "./orchestration/Services/InvestigationWorkflowService.ts";
import type { WorkflowServiceShape } from "./orchestration/Services/WorkflowService.ts";
import { applyWorkflowTurnCost, workflowBudgetError } from "./orchestration/workflowBudget.ts";
import { BUILTIN_WORKFLOW_TEMPLATES, createWorkflowPlatformRun } from "./workflowPlatform.ts";

const slot = { provider: "codex" as const, model: "gpt-5.1-codex" };
const projectId = ProjectId.makeUnsafe("workflow-platform-project");

function services() {
  const planning = vi.fn(() => Effect.succeed(PlanningWorkflowId.makeUnsafe("planning-run")));
  const codeReview = vi.fn(() =>
    Effect.succeed(CodeReviewWorkflowId.makeUnsafe("code-review-run")),
  );
  const investigation = vi.fn(() =>
    Effect.succeed(InvestigationWorkflowId.makeUnsafe("investigation-run")),
  );
  return {
    calls: { planning, codeReview, investigation },
    value: {
      planning: { createWorkflow: planning } as unknown as WorkflowServiceShape,
      codeReview: { createWorkflow: codeReview } as unknown as CodeReviewWorkflowServiceShape,
      investigation: {
        createWorkflow: investigation,
      } as unknown as InvestigationWorkflowServiceShape,
    },
  };
}

describe("workflow platform", () => {
  it("publishes versioned built-ins covering every supported node kind", () => {
    expect(BUILTIN_WORKFLOW_TEMPLATES.map((template) => [template.id, template.version])).toEqual([
      ["builtin.planning.dual", 1],
      ["builtin.code-review.dual", 1],
      ["builtin.investigation.dual", 1],
    ]);
    const kinds = new Set(
      BUILTIN_WORKFLOW_TEMPLATES.flatMap((template) => template.nodes.map((node) => node.kind)),
    );
    expect(kinds).toEqual(
      new Set([
        "agent",
        "parallel-agent",
        "review",
        "synthesis",
        "manual-approval",
        "project-script",
      ]),
    );
  });

  it("routes a declarative run to the compatibility engine with the cost limit intact", async () => {
    const configured = services();
    const input = {
      templateId: "builtin.code-review.dual",
      templateVersion: 1,
      maxCostUsd: 1.25,
      input: {
        projectId,
        reviewPrompt: "Review reconnect behavior",
        reviewerA: slot,
        reviewerB: { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" },
        consolidation: slot,
      },
    } satisfies WorkflowPlatformCreateRunInput;

    const result = await Effect.runPromise(createWorkflowPlatformRun(input, configured.value));
    expect(result).toEqual({ runKind: "codeReview", workflowId: "code-review-run" });
    expect(configured.calls.codeReview).toHaveBeenCalledWith({
      ...input.input,
      maxCostUsd: 1.25,
    });
    expect(configured.calls.planning).not.toHaveBeenCalled();
    expect(configured.calls.investigation).not.toHaveBeenCalled();
  });

  it("accumulates cost deterministically and blocks the next node at the limit", () => {
    const workflow = {
      totalCostUsd: 0.1,
      maxCostUsd: 0.25,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const below = applyWorkflowTurnCost(workflow, 0.149999, "2026-01-01T00:00:01.000Z");
    expect(below.totalCostUsd).toBe(0.249999);
    expect(workflowBudgetError(below)).toBeNull();
    const reached = applyWorkflowTurnCost(below, 0.000001, "2026-01-01T00:00:02.000Z");
    expect(workflowBudgetError(reached)?.message).toContain("cost limit reached");
  });
});
