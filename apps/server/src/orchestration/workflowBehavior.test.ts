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
    expect(behavior.planCaptureForProvider("claudeAgent")).toBe("exit-plan-mode");
    expect(behavior.planCaptureForProvider("codex")).toBe("line-wrapper");
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
