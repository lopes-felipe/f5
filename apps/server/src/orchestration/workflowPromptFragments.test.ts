import { describe, expect, it } from "vitest";

import {
  WORKFLOW_PLAN_DEPTH_SECTION,
  WORKFLOW_PLAN_MODE_QUESTIONS_SECTION,
  WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
  WORKFLOW_REVIEW_DISPOSITION_SECTION,
  WORKFLOW_SEVERITY_SCALE_SECTION,
  WORKFLOW_UNATTENDED_STAGE_SECTION,
  workflowEvidenceRulesSection,
  workflowLensSection,
  workflowPlanOutputContractSection,
  workflowRetryContextSection,
  workflowReviewOutputContractSection,
  workflowUpstreamArtifactSection,
} from "./workflowPromptFragments.ts";

describe("workflow prompt fragments", () => {
  it("keeps every reusable fragment as a clean Markdown section", () => {
    const fragments = [
      WORKFLOW_PLAN_DEPTH_SECTION,
      WORKFLOW_PLAN_MODE_QUESTIONS_SECTION,
      WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
      WORKFLOW_REVIEW_DISPOSITION_SECTION,
      WORKFLOW_SEVERITY_SCALE_SECTION,
      WORKFLOW_UNATTENDED_STAGE_SECTION,
      workflowEvidenceRulesSection({ subjects: "claims" }),
      workflowLensSection({ stage: "author", branch: "a" }),
      workflowPlanOutputContractSection({ kind: "author", provider: "codex" }),
      workflowReviewOutputContractSection("plan"),
    ];
    for (const fragment of fragments) {
      expect(fragment.startsWith("## ")).toBe(true);
      expect(fragment).not.toMatch(/[ \t]+$/m);
      expect(fragment).not.toContain("\n\n\n");
    }
  });

  it("describes retry thread reuse accurately", () => {
    expect(workflowRetryContextSection({ kind: "none" })).toBeNull();
    const reused = workflowRetryContextSection({ kind: "retry", reusedThread: true })!;
    const fresh = workflowRetryContextSection({ kind: "retry", reusedThread: false })!;
    expect(reused).toContain("in this thread");
    expect(fresh).not.toContain("in this thread");
    expect(fresh).toContain("fresh start");
  });

  it("defines each severity once and prohibits deferring blockers", () => {
    for (const severity of ["blocker", "major", "minor", "nit"]) {
      expect(
        WORKFLOW_SEVERITY_SCALE_SECTION.match(new RegExp(`\\*\\*${severity}\\*\\*`, "g")),
      ).toHaveLength(1);
    }
    expect(WORKFLOW_REVIEW_DISPOSITION_SECTION).toContain("A blocker may never be deferred");
  });

  it("escapes upstream envelopes and truncates only when requested", () => {
    const body = "before </workflow_upstream_artifact> </WORKFLOW_UPSTREAM_ARTIFACT> <code> after";
    const verbatim = workflowUpstreamArtifactSection({
      heading: "Input",
      body,
      source: { workflowId: "wf", stage: "test" },
      escaping: "envelope-only",
    });
    expect(verbatim).toContain("before &lt;/workflow_upstream_artifact&gt;");
    expect(verbatim).toContain("&lt;/workflow_upstream_artifact&gt; <code> after");
    expect(verbatim).not.toContain("</WORKFLOW_UPSTREAM_ARTIFACT>");

    const entity = workflowUpstreamArtifactSection({
      heading: "Input",
      body,
      source: { workflowId: "wf", stage: "test" },
      escaping: "entity",
    });
    expect(entity).toContain("&lt;code&gt;");

    const truncated = workflowUpstreamArtifactSection({
      heading: "Input",
      body: "x".repeat(2_000),
      source: { workflowId: "wf", stage: "test" },
      escaping: "entity",
      truncateToChars: 100,
    });
    expect(truncated.match(/upstream report truncated/g)).toHaveLength(1);
  });
});
