import { describe, expect, it } from "vitest";

import {
  assertWorkflowStageProviderSupported,
  resolveWorkflowBehavior,
  UnsupportedWorkflowProviderError,
  workflowTurnBehaviorFields,
} from "./workflowBehavior.ts";

describe("workflowBehavior", () => {
  it("treats missing record metadata as legacy v1", () => {
    const behavior = resolveWorkflowBehavior({ runKind: "planning" });
    expect(behavior.templateVersion).toBe(1);
    expect(behavior.strictPlanCapture).toBe(false);
    expect(behavior.executionProfileForStage("author")).toBeUndefined();
  });

  it("assigns attended and unattended read-only profiles in v2", () => {
    const behavior = resolveWorkflowBehavior({ runKind: "planning", templateVersion: 2 });
    expect(behavior.executionProfileForStage("author")).toBe("attended-readonly");
    expect(behavior.executionProfileForStage("plan-review")).toBe("unattended-readonly");
    expect(behavior.executionProfileForStage("implementation")).toBeUndefined();
    expect(behavior.strictPlanCapture).toBe(false);
    expect(behavior.planCaptureForProvider("claudeAgent")).toBe("assistant-fallback");
    expect(behavior.planCaptureForProvider("codex")).toBe("assistant-fallback");
  });

  it("keeps user-facing reconciliation stages attended so they can ask questions", () => {
    const planning = resolveWorkflowBehavior({ runKind: "planning", templateVersion: 2 });
    // `revision` and `merge` reconcile competing artifacts in front of the user,
    // so a clarifying question must reach a reply path instead of failing the turn.
    expect(planning.executionProfileForStage("revision")).toBe("attended-readonly");
    expect(planning.executionProfileForStage("merge")).toBe("attended-readonly");
    // Fan-out reviewer stages stay unattended.
    for (const stage of [
      "plan-review",
      "implementation-review",
      "investigation-review",
      "synthesis",
      "standalone-review",
      "consolidation",
    ] as const) {
      expect(planning.executionProfileForStage(stage)).toBe("unattended-readonly");
    }
    // `workflowTurnBehaviorFields` is what `startMergeTurn` /
    // `startPlanRevisionTurn` spread onto the dispatched `thread.turn.start`
    // command, so this is the shape those stages actually launch with.
    // Reclassification must not change their interaction mode.
    for (const stage of ["merge", "revision"] as const) {
      expect(
        workflowTurnBehaviorFields({ runKind: "planning", templateVersion: 2, stage }),
      ).toEqual({ interactionMode: "plan", workflowExecutionProfile: "attended-readonly" });
    }
    // A fan-out reviewer stage still launches unattended.
    expect(
      workflowTurnBehaviorFields({ runKind: "planning", templateVersion: 2, stage: "plan-review" }),
    ).toEqual({ interactionMode: "plan", workflowExecutionProfile: "unattended-readonly" });
  });

  it("keeps behavior fields centralized and rejects unsupported profiled providers", () => {
    expect(
      workflowTurnBehaviorFields({
        runKind: "codeReview",
        templateVersion: 2,
        stage: "standalone-review",
      }),
    ).toEqual({
      interactionMode: "plan",
      workflowExecutionProfile: "unattended-readonly",
    });
    const behavior = resolveWorkflowBehavior({ runKind: "planning", templateVersion: 2 });
    expect(() =>
      assertWorkflowStageProviderSupported({ behavior, stage: "author", provider: "grok" }),
    ).toThrow(UnsupportedWorkflowProviderError);
  });
});
