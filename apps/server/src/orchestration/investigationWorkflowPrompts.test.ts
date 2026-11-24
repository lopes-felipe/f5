import { describe, expect, it } from "vitest";

import {
  buildBudgetedInvestigationSynthesisPrompt,
  buildInvestigationCrossReviewPrompt,
  buildInvestigationPrompt,
  buildInvestigationPromptSections,
  buildInvestigationSelfReviewPrompt,
  buildInvestigationSynthesisPrompt,
  buildInvestigationSynthesisPromptSections,
  investigationSynthesisShareAtCreation,
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
          crossReviews: [{ reviewerLabel: "B", text: "review" }],
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

describe("investigation workflow prompts with more than two investigators", () => {
  const contribution = (label: string, peers: string[], text = `${label} report`) => ({
    label: `Investigator ${label}`,
    investigation: text,
    crossReviews: peers.map((peer) => ({
      reviewerLabel: `Investigator ${peer}`,
      text: `${peer} on ${label}`,
    })),
    selfReview: `${label} self`,
  });
  const base = { workflowId: "wf", problemPrompt: "Find the regression", targetSlot: codexSlot };

  it("tells each investigator how many peers work in parallel", () => {
    const prompt = buildInvestigationPrompt({
      ...base,
      investigatorLabel: "Investigator C",
      investigatorCount: 4,
      lensBranch: "a",
      branch: null,
      attended: false,
    });
    expect(prompt).toContain(
      "You are Investigator C in a 4-model root-cause investigation. 3 other models investigate the same problem independently",
    );
  });

  it("names the reviewer of every peer cross-review in the synthesis", () => {
    const prompt = buildInvestigationSynthesisPrompt({
      ...base,
      contributions: [
        contribution("A", ["B", "C"]),
        contribution("B", ["A", "C"]),
        contribution("C", ["A", "B"]),
      ],
    });
    expect(prompt).toContain("Weigh each investigation against every peer cross-review of it");
    expect(prompt).toContain(
      "### Peer Cross-Review Of This Investigation By Investigator C\n\nC on A",
    );
    expect(prompt).toContain("### Own-Model Review Of This Investigation\n\nC self");
  });

  it("fits four investigators with self-review and one oversized report under the limit", () => {
    const labels = ["A", "B", "C", "D"];
    const result = buildBudgetedInvestigationSynthesisPrompt({
      ...base,
      contributions: labels.map((label) =>
        contribution(
          label,
          labels.filter((peer) => peer !== label),
          label === "B" ? "y".repeat(200_000) : undefined,
        ),
      ),
      maxRenderedChars: 60_000,
    });
    expect(result.prompt.length).toBeLessThanOrEqual(60_000);
    expect(result.smallestExcerpt).toBeGreaterThan(40_000);
    expect(result.prompt).toContain("D on C");
  });

  it("computes the creation-time share per report only for mesh runs", () => {
    const labels = ["A", "B", "C", "D"];
    const input = {
      problemPrompt: "p".repeat(4_000),
      selfReviewEnabled: true,
      synthesisSlot: codexSlot,
      renderedMessageCharLimit: 250_000,
    };
    expect(
      investigationSynthesisShareAtCreation({
        ...input,
        investigatorLabels: ["Investigator A", "Investigator B"],
      }),
    ).toBeNull();
    const share = investigationSynthesisShareAtCreation({
      ...input,
      investigatorLabels: labels.map((label) => `Investigator ${label}`),
    })!;
    // 4 investigations + 12 cross-reviews + 4 own-model reviews, all long, on a retry: the
    // runtime gives every report exactly the creation-time share.
    const long = "z".repeat(100_000);
    const runtime = buildBudgetedInvestigationSynthesisPrompt({
      ...base,
      problemPrompt: input.problemPrompt,
      retry: { kind: "retry", reusedThread: true },
      contributions: labels.map((label) => ({
        ...contribution(
          label,
          labels.filter((peer) => peer !== label),
          long,
        ),
        crossReviews: labels
          .filter((peer) => peer !== label)
          .map((peer) => ({ reviewerLabel: `Investigator ${peer}`, text: long })),
        selfReview: long,
      })),
      maxRenderedChars: input.renderedMessageCharLimit,
    });
    expect(runtime.smallestExcerpt).toBe(share);
  });
});
