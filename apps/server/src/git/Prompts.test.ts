import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDeterministicCommitMessage,
  buildDeterministicPrContent,
  prefixGeneratedBranchName,
} from "./Prompts.ts";

const defaults = DEFAULT_SERVER_SETTINGS.sourceControlWriting;

describe("source-control writing prompts", () => {
  it("applies style, body, and custom instructions to commit prompts", () => {
    const { prompt } = buildCommitMessagePrompt({
      branch: "feature/demo",
      stagedSummary: "src/demo.ts",
      stagedPatch: "+demo",
      includeBranch: false,
      writingPreferences: {
        ...defaults,
        commitMessageStyle: "conventional",
        commitMessageIncludeBody: false,
        customInstructions: "Use product terminology.",
      },
    });
    expect(prompt).toContain("Conventional Commits");
    expect(prompt).toContain("body must be an empty string");
    expect(prompt).toContain("Use product terminology.");
  });

  it("includes writing instructions in branch prompts", () => {
    const { prompt } = buildBranchNamePrompt({
      message: "Add a safer importer",
      writingPreferences: { ...defaults, customInstructions: "Prefer nouns." },
    });
    expect(prompt).toContain("Additional instructions: Prefer nouns.");
  });

  it("builds deterministic commit and PR content when generation is disabled", () => {
    expect(
      buildDeterministicCommitMessage("src/a.ts\nsrc/b.ts", {
        ...defaults,
        commitMessageStyle: "conventional",
      }),
    ).toEqual({
      subject: "chore: update project files",
      body: "- src/a.ts\n- src/b.ts",
    });

    const pr = buildDeterministicPrContent({
      headBranch: "feature/safe-import",
      commitSummary: "Add safe import",
      diffSummary: "1 file changed",
      writingPreferences: defaults,
    });
    expect(pr.title).toBe("Update feature safe import");
    expect(pr.body).toContain("- Add safe import");
    expect(pr.body).toContain("- Not run (generated without AI)");
  });

  it("prefixes only generated branch names", () => {
    expect(
      prefixGeneratedBranchName("safe-import", { ...defaults, branchNamePrefix: "team/f5" }),
    ).toBe("team/f5/safe-import");
    expect(prefixGeneratedBranchName("safe-import", defaults)).toBe("safe-import");
  });
});
