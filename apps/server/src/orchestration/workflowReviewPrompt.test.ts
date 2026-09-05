import { describe, expect, it } from "vitest";
import { estimateModelContextWindowTokens } from "@t3tools/shared/model";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { buildCodeReviewPrompt } from "./workflowPrompts.ts";
import { prepareCodeReviewPrompt } from "./workflowReviewPrompt.ts";
import {
  workflowArtifactFit,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "./workflowSharedUtils.ts";

function input(
  overrides: Partial<Parameters<typeof prepareCodeReviewPrompt>[0]> = {},
): Parameters<typeof prepareCodeReviewPrompt>[0] {
  return {
    requirementPrompt: "Implement the complete requirement.",
    mergedPlanMarkdown: "# Approved plan\nPreserve every acceptance criterion.",
    reviewArtifact: {
      patchText: "diff --git a/a.ts b/a.ts\n+const a = 1;\n",
      source: { workflowId: "workflow-1", stage: "implementation", turnId: "turn-1" },
      fullPatchHash: "original-checkpoint-hash",
    },
    reviewerLabel: "Author A",
    lensBranch: "a",
    reviewerSlot: { provider: "codex", model: "gpt-5.6-sol" },
    enforceArtifactBudget: true,
    ...overrides,
  };
}

function prepared(options: Parameters<typeof prepareCodeReviewPrompt>[0]) {
  const result = prepareCodeReviewPrompt(options);
  if (!("prompt" in result)) throw result;
  expect(result.prompt.length).toBeLessThanOrEqual(WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT);
  expect(result.prompt).toContain(options.requirementPrompt);
  expect(result.prompt).toContain(options.mergedPlanMarkdown);
  if (options.enforceArtifactBudget) {
    expect(
      workflowArtifactFit({
        artifacts: result.artifacts,
        targetSlot: options.reviewerSlot,
        thread: options.thread ?? null,
      }).fits,
    ).toBe(true);
  }
  return result;
}

describe("prepareCodeReviewPrompt", () => {
  it("keeps fitting inputs unchanged, including previously truncated patches", () => {
    let options = input();
    expect(prepared(options).prompt).toBe(buildCodeReviewPrompt(options));
    options = {
      ...options,
      reviewArtifact: {
        ...options.reviewArtifact,
        truncated: true,
        truncationReason: "Original capture limit.",
      },
    };
    expect(prepared(options).prompt).toBe(buildCodeReviewPrompt(options));
  });

  it.each(["a", "b"] as const)(
    "budgets a 157,166-character input for reviewer %s without mutating saved evidence",
    (lensBranch) => {
      let options = input({
        lensBranch,
        reviewerSlot:
          lensBranch === "a"
            ? { provider: "codex", model: "gpt-5.6-sol" }
            : { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      });
      options = {
        ...options,
        mergedPlanMarkdown: options.mergedPlanMarkdown + "p".repeat(33_000),
        reviewArtifact: {
          ...options.reviewArtifact,
          truncated: true,
          truncationReason: "Original checkpoint capture omitted later files.",
        },
      };
      const extra = 157_166 - buildCodeReviewPrompt(options).length;
      options = {
        ...options,
        reviewArtifact: {
          ...options.reviewArtifact,
          patchText: options.reviewArtifact.patchText + "+".repeat(extra),
        },
      };
      expect(buildCodeReviewPrompt(options)).toHaveLength(157_166);
      const saved = structuredClone(options.reviewArtifact);
      const result = prepared(options);
      expect(result.prompt).toContain("original-checkpoint-hash");
      expect(result.prompt).toContain(saved.truncationReason);
      expect(result.prompt).toContain("read-only repository inspection");
      expect(result.prompt).toContain("coverage gap");
      expect(result.artifacts[2]!.length).toBeLessThan(saved.patchText.length);
      expect(options.reviewArtifact).toEqual(saved);
    },
  );

  it("respects remaining context on a reused reviewer thread", () => {
    let options = input();
    const window = estimateModelContextWindowTokens(
      options.reviewerSlot.model,
      options.reviewerSlot.provider,
    );
    options = {
      ...options,
      thread: { estimatedContextTokens: window - Math.max(8_000, Math.floor(window * 0.15)) - 400 },
      reviewArtifact: {
        ...options.reviewArtifact,
        patchText: `diff --git a/a b/a\n${"+line\n".repeat(5_000)}`,
      },
    };
    const result = prepared(options);
    expect(result.artifacts[2]!.length).toBeLessThan(800);
    expect(result.prompt).toContain("truncated");
  });

  it("preserves whole files when possible and valid Unicode for an oversized first file", () => {
    for (const patchText of [
      `diff --git a/small b/small\n+small\ndiff --git a/large b/large\n${"+large\n".repeat(30_000)}`,
      `diff --git a/unicode b/unicode\n${"+é😀漢字\n".repeat(30_000)}`,
    ]) {
      const options = input({ reviewArtifact: { ...input().reviewArtifact, patchText } });
      const patch = prepared(options).artifacts[2]!;
      expect(patch).toContain("diff --git");
      expect(patch).not.toContain("\uFFFD");
      if (patchText.includes("a/small")) expect(patch).toBe("diff --git a/small b/small\n+small\n");
    }
  });

  it("reports fixed-input overflow without dropping the requirement or plan", () => {
    const options = input({ mergedPlanMarkdown: "p".repeat(116_000) });
    const result = prepareCodeReviewPrompt(options);
    expect(result).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((result as OrchestrationCommandInvariantError).detail).toContain(
      "plan 116000 characters",
    );
    expect((result as OrchestrationCommandInvariantError).detail).toContain(
      "instructions and metadata",
    );
  });

  it.each([0, 1, 43])(
    "fits a prompt with only %i characters left for patch evidence",
    (allowance) => {
      const options = input({
        reviewArtifact: {
          ...input().reviewArtifact,
          patchText: `diff --git a/a b/a\n${"+x\n".repeat(60_000)}`,
        },
      });
      const first = prepared(options);
      const fixedLength = first.prompt.length - first.artifacts[2]!.length;
      const enlarged = {
        ...options,
        mergedPlanMarkdown:
          options.mergedPlanMarkdown +
          "p".repeat(WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT - fixedLength - allowance),
      };
      const result = prepared(enlarged);
      expect(result.artifacts[2]!.length).toBeLessThanOrEqual(allowance);
      expect(result.prompt).toContain("coverage gap");
    },
  );

  it("keeps an exactly full fitting prompt unchanged", () => {
    const options = input();
    const enlarged = {
      ...options,
      mergedPlanMarkdown:
        options.mergedPlanMarkdown +
        "p".repeat(WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT - buildCodeReviewPrompt(options).length),
    };
    expect(prepared(enlarged).prompt).toBe(buildCodeReviewPrompt(enlarged));
  });

  it("reports fixed artifact token overflow and respects the legacy budget policy", () => {
    const options = input({ thread: { estimatedContextTokens: 2_000_000 } });
    expect(prepareCodeReviewPrompt(options)).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect(prepared({ ...options, enforceArtifactBudget: false }).prompt).toBe(
      buildCodeReviewPrompt(options),
    );
  });
});
