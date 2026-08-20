import { describe, expect, it } from "vitest";

import {
  extractProposedPlanMarkdown,
  stripProposedPlanBlockTags,
  validateProposedPlanOutput,
} from "./proposedPlan";

describe("extractProposedPlanMarkdown", () => {
  it("uses the outer line-delimited wrapper when the plan quotes the tags", () => {
    const text = `<proposed_plan>
# Plan

\`\`\`text
<proposed_plan>
example
</proposed_plan>
\`\`\`
</proposed_plan>`;

    expect(extractProposedPlanMarkdown(text)).toBe(`# Plan

\`\`\`text
<proposed_plan>
example
</proposed_plan>
\`\`\``);
  });

  it("takes the outer span across sibling blocks", () => {
    expect(
      extractProposedPlanMarkdown(
        "<proposed_plan>\nA\n</proposed_plan>\n<proposed_plan>\nB\n</proposed_plan>",
      ),
    ).toBe("A\n</proposed_plan>\n<proposed_plan>\nB");
  });

  it("matches delimiters case-insensitively", () => {
    expect(extractProposedPlanMarkdown("<PROPOSED_PLAN>\nPlan\n</Proposed_Plan>")).toBe("Plan");
  });

  it("rejects orphan and inline delimiters", () => {
    expect(extractProposedPlanMarkdown("Plan\n</proposed_plan>")).toBeUndefined();
    expect(
      extractProposedPlanMarkdown("prefix <proposed_plan>\nPlan\n</proposed_plan> suffix"),
    ).toBeUndefined();
  });
});

describe("validateProposedPlanOutput", () => {
  it("requires the wrapper to be the only outer response content", () => {
    expect(validateProposedPlanOutput("<proposed_plan>\n# Plan\n</proposed_plan>")).toEqual({
      valid: true,
      markdown: "# Plan",
    });
    expect(
      validateProposedPlanOutput("summary\n<proposed_plan>\n# Plan\n</proposed_plan>"),
    ).toEqual({
      valid: false,
      error: "The first non-whitespace line must be <proposed_plan>.",
    });
    expect(validateProposedPlanOutput("<proposed_plan>\n</proposed_plan>")).toEqual({
      valid: false,
      error: "The proposed plan block was empty.",
    });
  });

  it("rejects questions, orphaned wrappers, and sibling wrappers", () => {
    for (const text of [
      "Which approach do you want?",
      "# Plan\n</proposed_plan>",
      "<proposed_plan>\n# Plan",
      "<proposed_plan>\nA\n</proposed_plan>\n<proposed_plan>\nB\n</proposed_plan>",
    ]) {
      expect(validateProposedPlanOutput(text).valid).toBe(false);
    }
  });

  it("allows delimiter examples inside fenced code blocks", () => {
    expect(
      validateProposedPlanOutput(`<proposed_plan>
# Plan

\`\`\`text
<proposed_plan>
example
</proposed_plan>
\`\`\`
</proposed_plan>`),
    ).toEqual({
      valid: true,
      markdown: `# Plan

\`\`\`text
<proposed_plan>
example
</proposed_plan>
\`\`\``,
    });
  });
});

describe("stripProposedPlanBlockTags", () => {
  it("removes only line-delimited wrapper tags, including orphan closers", () => {
    expect(stripProposedPlanBlockTags("<proposed_plan>\nPlan\n</proposed_plan>")).toBe("Plan");
    expect(stripProposedPlanBlockTags("Plan\n</PROPOSED_PLAN>")).toBe("Plan");
    expect(stripProposedPlanBlockTags("inline <proposed_plan> remains")).toBe(
      "inline <proposed_plan> remains",
    );
  });

  it("preserves delimiter examples inside fenced code blocks", () => {
    const text = "```text\n<proposed_plan>\nexample\n</proposed_plan>\n```";
    expect(stripProposedPlanBlockTags(text)).toBe(text);
  });
});
