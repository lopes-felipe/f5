import { describe, expect, it } from "vitest";
import { createPlanningWorkflow, createDocumentReaderPass } from "../../test/workflowFixtures";
import { canStartImplementation, resolveDocumentDisplayMarkdown } from "./workflowUtils";
import {
  planningWorkflowStatusLabel,
  collectPlanningWorkflowErrors,
} from "./planningWorkflowView.logic";
import { deriveTimelinePhases } from "./workflowSidebarTimeline";
const workflow = () =>
  createPlanningWorkflow({
    templateId: "builtin.document.dual",
    documentType: "rfc",
    readerReviewEnabled: true,
    readerPass: createDocumentReaderPass(),
    merge: { status: "merged" },
  });
describe("document workflow presentation", () => {
  it("labels reader and polish stages, failures and final readiness", () => {
    const base = workflow();
    expect(planningWorkflowStatusLabel(base)).toBe("Reader reviewing");
    expect(
      planningWorkflowStatusLabel({
        ...base,
        readerPass: createDocumentReaderPass({ status: "polishing" }),
      }),
    ).toBe("Polishing");
    expect(
      planningWorkflowStatusLabel({
        ...base,
        merge: { ...base.merge, status: "manual_review" },
        readerPass: createDocumentReaderPass({ status: "completed" }),
      }),
    ).toBe("Document ready");
    for (const stage of ["reader", "polish"] as const)
      expect(
        collectPlanningWorkflowErrors({
          ...base,
          readerPass: createDocumentReaderPass({
            status: "error",
            errorStage: stage,
            error: "Failed",
          }),
        })[0]?.step,
      ).toBe(stage === "reader" ? "Reader review" : "Polish");
  });
  it("shows only the pinned document and never enables implementation", () => {
    const base = workflow();
    const thread = {
      proposedPlans: [
        { id: "draft-plan", planMarkdown: "# Draft\n## Summary\nDraft body" },
        { id: "final", planMarkdown: "# Final\n## Summary\nFinal body" },
        { id: "partial", planMarkdown: "Partial edit" },
      ],
    };
    expect(resolveDocumentDisplayMarkdown(base, thread)).toContain("# Draft");
    const final = {
      ...base,
      merge: { ...base.merge, status: "manual_review" as const, approvedPlanId: "final" },
    };
    expect(resolveDocumentDisplayMarkdown(final, thread)).toContain("# Final");
    expect(canStartImplementation(final)).toBe(false);
    expect(
      resolveDocumentDisplayMarkdown(
        { ...final, merge: { ...final.merge, approvedPlanId: "draft-plan" } },
        thread,
      ),
    ).toContain("# Draft");
  });
  it("renders four phases without reader review and five with it", () => {
    const base = workflow();
    expect(deriveTimelinePhases(base).map((phase) => phase.label)).toEqual([
      "Drafting",
      "Reviews",
      "Revision",
      "Merge",
      "Reader pass",
    ]);
    expect(deriveTimelinePhases({ ...base, readerReviewEnabled: false })).toHaveLength(4);
    const skipped = deriveTimelinePhases({
      ...base,
      readerPass: createDocumentReaderPass({ status: "skipped" }),
    }).at(-1)!;
    expect(skipped.state).toBe("skipped");
    expect(skipped.steps.every((step) => step.state === "skipped")).toBe(true);
  });
});
