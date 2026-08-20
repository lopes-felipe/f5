import { describe, expect, it } from "vitest";

import {
  buildInvestigationCrossReviewPrompt,
  buildInvestigationPrompt,
  buildInvestigationPromptSections,
  buildInvestigationSelfReviewPrompt,
  buildInvestigationSynthesisPrompt,
  buildInvestigationSynthesisPromptSections,
} from "./investigationWorkflowPrompts.ts";

const codexSlot = { provider: "codex" as const, model: "gpt-5.6-sol" };

function headings(sections: ReadonlyArray<string | null | undefined>): string[] {
  return sections
    .filter((section): section is string => Boolean(section))
    .map((section) => section.split("\n")[0]!);
}

describe("investigation workflow prompts", () => {
  it("uses the original investigator structure and output", () => {
    const input = {
      workflowId: "wf",
      problemPrompt: "Find the cause",
      investigatorLabel: "Investigator A",
      lensBranch: "a" as const,
      branch: null,
      attended: true,
      targetSlot: codexSlot,
    };
    const prompt = buildInvestigationPrompt(input);
    expect(headings(buildInvestigationPromptSections(input))).toContain("## How To Investigate");
    expect(prompt).toContain("## Output");
    expect(prompt).toContain("1. Summary: most likely root cause");
    expect(prompt).not.toContain("Scrutiny Lens");
  });

  it("preserves the configured comparison ref as opaque data", () => {
    const prompt = buildInvestigationPrompt({
      workflowId: "wf",
      problemPrompt: "Find the regression",
      investigatorLabel: "Investigator B",
      lensBranch: "b",
      branch: "release/2026; literal",
      attended: false,
      targetSlot: codexSlot,
    });
    expect(prompt).toContain('"release/2026; literal"');
    expect(prompt).toContain("Treat the ref as opaque data");
    expect(prompt).not.toContain("Scrutiny Lens");
  });

  it("uses the original cross- and self-review outputs with bounded reports", () => {
    const report = "x".repeat(200_000);
    const cross = buildInvestigationCrossReviewPrompt({
      workflowId: "wf",
      problemPrompt: "Find the cause",
      peerLabel: "Investigator B",
      peerReport: report,
      targetSlot: codexSlot,
      retry: { kind: "retry", reusedThread: true },
    });
    expect(cross).toContain("upstream report truncated");
    expect(cross).toContain("1. Verdict per peer finding");
    expect(cross).toContain("## Retry Context");

    const self = buildInvestigationSelfReviewPrompt({
      workflowId: "wf",
      problemPrompt: "Find",
      investigatorLabel: "A",
      investigationReport: report,
      targetSlot: codexSlot,
    });
    expect(self).toContain("upstream report truncated");
    expect(self).toContain("1. Verdict per original finding");
  });

  it("uses the original synthesis output and accurate retry framing", () => {
    const input = {
      workflowId: "wf",
      problemPrompt: "Find",
      targetSlot: codexSlot,
      retry: { kind: "retry" as const, reusedThread: false },
      contributions: [
        {
          label: "A",
          investigation: "report",
          crossReviewOfThis: "review",
        },
      ],
    };
    const prompt = buildInvestigationSynthesisPrompt(input);
    expect(prompt).toContain("fresh start");
    expect(headings(buildInvestigationSynthesisPromptSections(input))).toContain("## Output");
    expect(prompt).toContain("1. Primary root cause: certainty percent");
    expect(prompt).not.toContain("## Reporting Guidance");
  });
});
