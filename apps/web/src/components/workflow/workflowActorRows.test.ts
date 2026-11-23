import { describe, expect, it } from "vitest";

import {
  formatWorkflowTurnEstimate,
  workflowActorDuplicateIndexes,
  workflowActorLimitMessage,
  workflowActorMax,
  workflowActorRowLabel,
  workflowAddActorLabel,
} from "./workflowActorRows";

describe("workflow actor rows", () => {
  it("labels rows and limits each type", () => {
    expect(workflowActorRowLabel("planning", 2)).toBe("Author C");
    expect(workflowActorRowLabel("codeReview", 5)).toBe("Reviewer F");
    expect(workflowActorRowLabel("investigation", 1)).toBe("Investigator B");
    expect(workflowAddActorLabel("investigation")).toBe("Add investigator");
    expect(workflowActorMax("planning")).toBe(4);
    expect(workflowActorMax("codeReview")).toBe(6);
    expect(workflowActorLimitMessage("planning")).toBe(
      "Feature workflows support up to 4 authors.",
    );
    expect(workflowActorLimitMessage("codeReview")).toBe(
      "Code review workflows support up to 6 reviewers.",
    );
  });

  it("flags repeated models only where every actor must differ", () => {
    const slots = [
      { provider: "codex", model: "gpt-5.5" },
      { provider: "claudeAgent", model: "opus" },
      { provider: "codex", model: "gpt-5.5" },
    ] as const;
    expect([...workflowActorDuplicateIndexes("document", slots)]).toEqual([0, 2]);
    expect([...workflowActorDuplicateIndexes("investigation", slots)]).toEqual([0, 2]);
    expect(workflowActorDuplicateIndexes("planning", slots).size).toBe(0);
    expect(workflowActorDuplicateIndexes("codeReview", slots).size).toBe(0);
  });

  it("describes the turns a run starts", () => {
    expect(formatWorkflowTurnEstimate("planning", 3, true)).toBe(
      "3 authors: 6 cross-reviews, 3 own-model reviews, 3 revisions, 1 merge",
    );
    expect(formatWorkflowTurnEstimate("investigation", 4, false)).toBe(
      "4 investigators: 12 cross-reviews, 1 synthesis",
    );
    expect(formatWorkflowTurnEstimate("codeReview", 5, true)).toBe(
      "5 reviewers: 5 reviews, 1 consolidation",
    );
  });
});
