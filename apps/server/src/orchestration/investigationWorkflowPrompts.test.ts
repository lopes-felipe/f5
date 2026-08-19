import { describe, expect, it } from "vitest";

import {
  buildInvestigationCrossReviewPrompt,
  buildInvestigationCrossReviewPromptSections,
  buildInvestigationPrompt,
  buildInvestigationPromptSections,
  buildInvestigationSelfReviewPrompt,
  buildInvestigationSelfReviewPromptSections,
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
  it("builds the investigator contract with an attended question path", () => {
    const input = {
      workflowId: "wf",
      problemPrompt: "Find the cause",
      investigatorLabel: "Investigator A",
      lensBranch: "a" as const,
      branch: null,
      attended: true,
      targetSlot: codexSlot,
    };
    expect(headings(buildInvestigationPromptSections(input))).toContain("## Clarifying Questions");
    expect(buildInvestigationPrompt(input)).toContain("rg --files");
  });

  it("preserves the configured comparison ref and does not promise questions when unattended", () => {
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
    expect(prompt).not.toContain("## Clarifying Questions");
    expect(prompt).toContain("## Scrutiny Lens B");
  });

  it("builds unattended cross and self reviews with bounded artifacts", () => {
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
    expect(cross).toContain("## Retry Context");
    expect(
      headings(
        buildInvestigationCrossReviewPromptSections({
          workflowId: "wf",
          problemPrompt: "Find",
          peerLabel: "B",
          peerReport: "report",
          targetSlot: codexSlot,
        }),
      ),
    ).toContain("## Unattended Stage");

    const self = buildInvestigationSelfReviewPrompt({
      workflowId: "wf",
      problemPrompt: "Find",
      investigatorLabel: "A",
      investigationReport: report,
      targetSlot: codexSlot,
    });
    expect(self).toContain("upstream report truncated");
    expect(
      headings(
        buildInvestigationSelfReviewPromptSections({
          workflowId: "wf",
          problemPrompt: "Find",
          investigatorLabel: "A",
          investigationReport: "report",
          targetSlot: codexSlot,
        }),
      ),
    ).not.toContain("## Clarifying Questions");
  });

  it("gives synthesis provider guidance and preserves retry framing", () => {
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
    expect(prompt).toContain("## Provider-Specific Guidance");
    expect(prompt).toContain("fresh start");
    expect(headings(buildInvestigationSynthesisPromptSections(input))).toContain(
      "## Output Contract",
    );
  });
});
