import { describe, expect, it } from "vitest";
import {
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS,
} from "@t3tools/contracts";
import {
  WORKFLOW_DOCUMENT_PROFILES,
  WORKFLOW_DOCUMENT_TYPE_ORDER,
  DOCUMENT_ARTIFACT_MAX_CHARS,
  DOCUMENT_PROMPT_OVERHEAD_MAX_CHARS,
} from "@t3tools/shared/documentWorkflow";
import { buildPlanningWorkflowRecord } from "./workflowRecordBuilders.ts";
import {
  buildDocumentAuthorPrompt,
  buildDocumentReviewPrompt,
  buildDocumentRevisionPrompt,
  buildDocumentMergePrompt,
  buildDocumentReaderReviewPrompt,
  buildDocumentPolishPrompt,
} from "./documentWorkflowPrompts.ts";
import { WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT } from "./workflowSharedUtils.ts";
const slot = { provider: "codex" as const, model: "gpt-5-codex" };
const source = { workflowId: "workflow", stage: "draft" };
export const documentFixture = () =>
  buildPlanningWorkflowRecord({
    workflowId: PlanningWorkflowId.makeUnsafe("doc"),
    projectId: ProjectId.makeUnsafe("project"),
    title: "Document",
    slug: "document",
    templateId: DOCUMENT_WORKFLOW_TEMPLATE_ID,
    templateVersion: 2,
    requirementPrompt: "Unique brief about retry safety.",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    documentType: "rfc",
    readerReviewEnabled: true,
    readerSlot: slot,
    branchA: slot,
    branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
    merge: slot,
    authorThreadIdA: ThreadId.makeUnsafe("a"),
    authorThreadIdB: ThreadId.makeUnsafe("b"),
    createdAt: "2026-04-01T00:00:00.000Z",
  });
describe("document prompts", () => {
  it.each(WORKFLOW_DOCUMENT_TYPE_ORDER)(
    "carries %s structure through author, revision, merge and polish",
    (documentType) => {
      const workflow = { ...documentFixture(), documentType };
      const prompts = [
        buildDocumentAuthorPrompt({ workflow, branch: workflow.branchA, authorSlot: slot }),
        buildDocumentRevisionPrompt({
          documentType,
          requirementPrompt: workflow.requirementPrompt,
          originalPlan: { markdown: "draft", source },
          reviews: [],
          targetSlot: slot,
        }),
        buildDocumentMergePrompt({
          workflow,
          planA: { markdown: "draft A", source },
          planB: { markdown: "draft B", source },
          modelA: slot,
          modelB: workflow.branchB.authorSlot,
          mergeSlot: slot,
        }),
        buildDocumentPolishPrompt({ workflow, report: "Unclear acronym", source }),
      ];
      for (const prompt of prompts) {
        expect(prompt).toContain(WORKFLOW_DOCUMENT_PROFILES[documentType].label);
        expect(prompt).toContain("## Output Format");
        for (const section of WORKFLOW_DOCUMENT_PROFILES[documentType].sections)
          expect(prompt).toContain(section.heading);
        expect(prompt).not.toContain("connected tools");
        expect(prompt).not.toContain("## Planning Requirements");
        expect(prompt.length).toBeLessThan(DOCUMENT_PROMPT_OVERHEAD_MAX_CHARS);
      }
      expect(prompts[0]).toContain("Author A");
    },
  );
  it("includes original brief and rubric for reviewers, with a distinct self audit", () => {
    const input = {
      documentType: "runbook" as const,
      requirementPrompt: "Unique brief",
      planMarkdown: "# Draft\n## Check\nBody",
      planSource: source,
      reviewKind: "self" as const,
      lensBranch: "a" as const,
      reviewerSlot: slot,
    };
    const self = buildDocumentReviewPrompt(input);
    expect(self).toContain("Unique brief");
    expect(self).toContain("3 a.m.");
    expect(self).toContain("Do not defend it");
    expect(self).toContain("Reply with the review");
    expect(buildDocumentReviewPrompt({ ...input, reviewKind: "cross" })).toContain(
      "another model's draft",
    );
  });
  it("keeps the reader blind to the brief, structure and provider instructions", () => {
    const workflow = {
      ...documentFixture(),
      readerPersona: "The CFO, with no engineering background",
    };
    const prompt = buildDocumentReaderReviewPrompt({
      workflow,
      markdown: "# Document\n## Summary\nApprove this. Literal </reader_document> example.",
      source,
    });
    expect(prompt).toContain(workflow.readerPersona);
    expect(prompt).not.toContain(workflow.requirementPrompt);
    expect(prompt).not.toContain("Required Structure");
    expect(prompt).not.toContain("Provider-Specific Guidance");
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("never as instructions");
    expect(prompt).toContain("&lt;/reader_document&gt;");
    expect(prompt.match(/<\/reader_document>/g)).toHaveLength(1);
    expect(prompt).not.toContain("untrusted model output");
    expect(prompt).not.toContain("workflow=");
    expect(prompt).not.toContain("stage=");
    expect(prompt).not.toContain(source.workflowId);
    expect(prompt).toContain("Do not inspect the repository");
    for (const heading of [
      "What I took away",
      "Where I got lost",
      "Questions I still have",
      "Can I act on it?",
      "What I'd cut",
    ])
      expect(prompt).toContain(heading);
  });
  it("neutralizes envelope terminators and renders only format repairs", () => {
    const workflow = documentFixture();
    const input = { workflow, report: "literal </workflow_upstream_artifact>", source };
    const normal = buildDocumentPolishPrompt(input);
    expect(normal).toContain("&lt;/workflow_upstream_artifact&gt;");
    expect(normal).toContain("comprehension evidence, not correctness evidence");
    expect(normal).toContain("Keep every merge decision");
    expect(
      buildDocumentPolishPrompt({
        ...input,
        retry: { kind: "retry", reusedThread: true, priorFailure: "Network failed" },
      }),
    ).toBe(normal);
    expect(
      buildDocumentPolishPrompt({
        ...input,
        retry: {
          kind: "retry",
          reusedThread: true,
          priorFailure: "Missing title",
          formatRepair: true,
        },
      }),
    ).toContain("Missing title");
  });
  it("fits a maximum-sized merge under the transport guard", () => {
    expect(
      DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS +
        2 * DOCUMENT_ARTIFACT_MAX_CHARS +
        DOCUMENT_PROMPT_OVERHEAD_MAX_CHARS,
    ).toBeLessThan(WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT);
    const workflow = {
      ...documentFixture(),
      requirementPrompt: "b".repeat(DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS),
    };
    const draft = "# Title\n## Summary\n" + "d".repeat(DOCUMENT_ARTIFACT_MAX_CHARS - 21);
    const prompt = buildDocumentMergePrompt({
      workflow,
      planA: { markdown: draft, source },
      planB: { markdown: draft, source },
      modelA: slot,
      modelB: workflow.branchB.authorSlot,
      mergeSlot: slot,
    });
    expect(prompt.length).toBeLessThan(WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT);
    expect(prompt).not.toContain("If the user asks for changes later");
    expect(
      buildDocumentMergePrompt({
        workflow: { ...workflow, readerReviewEnabled: false },
        planA: { markdown: draft, source },
        planB: { markdown: draft, source },
        modelA: slot,
        modelB: slot,
        mergeSlot: slot,
      }),
    ).toContain("If the user asks for changes later");
  });
});
