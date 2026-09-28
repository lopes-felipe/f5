import { PlanningWorkflowId, ProjectId, ThreadId, PlanningWorkflow } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { buildPlanningWorkflowRecord } from "./workflowRecordBuilders.ts";
import {
  markDocumentMergeDrafted,
  markReaderRunning,
  markReaderSaved,
  markPolishRequested,
  markPolishCompleted,
  markReaderPassError,
  markReaderPassSkipped,
} from "./documentReaderPass.ts";
import {
  documentWorkflowForThread,
  documentReaderPersona,
  documentReaderPassPhase,
} from "@t3tools/shared/documentWorkflow";
import { archivedWorkflowThreadIds } from "@t3tools/shared/workflowThreads";
const now = "2026-04-01T00:00:00.000Z";
const slot = { provider: "codex" as const, model: "gpt-5-codex" };
const base = buildPlanningWorkflowRecord({
  workflowId: PlanningWorkflowId.makeUnsafe("workflow"),
  projectId: ProjectId.makeUnsafe("project"),
  title: "Document",
  slug: "document",
  templateId: "builtin.document.dual",
  templateVersion: 2,
  documentType: "rfc",
  requirementPrompt: "Brief",
  plansDirectory: "plans",
  selfReviewEnabled: true,
  authorThreadIdA: ThreadId.makeUnsafe("a"),
  authorThreadIdB: ThreadId.makeUnsafe("b"),
  branchA: slot,
  branchB: slot,
  merge: slot,
  createdAt: now,
});
const drafted = () =>
  markDocumentMergeDrafted(base, {
    turnId: "draft",
    draftPlanId: "draft-plan",
    readerThreadId: ThreadId.makeUnsafe("reader"),
    updatedAt: now,
  });
describe("document reader transitions", () => {
  it("pins the draft separately and only approves the polished document", () => {
    let workflow = drafted();
    expect(workflow.merge).toMatchObject({
      status: "merged",
      approvedPlanId: null,
      turnId: "draft",
    });
    expect(documentReaderPassPhase(workflow)).toBe("reading");
    workflow = markReaderRunning(workflow, now);
    expect(workflow.readerPass?.readerStartedAt).toBe(now);
    workflow = markReaderSaved(workflow, {
      turnId: "reader-turn",
      messageId: "report",
      updatedAt: now,
    });
    expect(documentReaderPassPhase(workflow)).toBe("polishing");
    workflow = markPolishRequested(workflow, now);
    expect(workflow.readerPass?.polishRequestedAt).toBe(now);
    workflow = markPolishCompleted(workflow, {
      turnId: "polish-turn",
      planId: "polished-plan",
      updatedAt: now,
    });
    expect(workflow.merge).toMatchObject({
      status: "manual_review",
      approvedPlanId: "polished-plan",
      turnId: "polish-turn",
    });
    expect(documentReaderPassPhase(workflow)).toBe("done");
  });
  it.each(["reader", "polish"] as const)(
    "preserves the draft through %s failure and skip",
    (stage) => {
      const failed = markReaderPassError(drafted(), stage, "Failure", now);
      expect(documentReaderPassPhase(failed)).toBe("error");
      const skipped = markReaderPassSkipped(failed, now);
      expect(skipped.merge).toMatchObject({
        status: "manual_review",
        approvedPlanId: "draft-plan",
        turnId: "draft",
      });
      expect(skipped.readerPass?.status).toBe("skipped");
    },
  );
  it("includes reader threads in lookup and archive, ignoring deleted/feature records", () => {
    const initial = drafted();
    const workflow = {
      ...initial,
      merge: { ...initial.merge, threadId: ThreadId.makeUnsafe("merge") },
      readerPass: {
        ...initial.readerPass!,
        previousReaderThreadIds: [ThreadId.makeUnsafe("previous-reader")],
      },
    };
    for (const threadId of [
      base.branchA.authorThreadId,
      base.branchB.authorThreadId,
      workflow.readerPass!.readerThreadId,
      workflow.merge.threadId,
      ...workflow.readerPass.previousReaderThreadIds,
    ])
      expect(documentWorkflowForThread([workflow], threadId)).toBe(workflow);
    expect(
      documentWorkflowForThread(
        [{ ...workflow, deletedAt: now }],
        workflow.readerPass!.readerThreadId,
      ),
    ).toBeNull();
    expect(
      documentWorkflowForThread(
        [{ ...workflow, templateId: "builtin.planning.dual" }],
        base.branchA.authorThreadId,
      ),
    ).toBeNull();
    expect(
      archivedWorkflowThreadIds([{ ...workflow, archivedAt: now }], [], []).has(
        workflow.readerPass!.readerThreadId,
      ),
    ).toBe(true);
    expect(
      archivedWorkflowThreadIds([{ ...workflow, archivedAt: now }], [], []).has(
        ThreadId.makeUnsafe("previous-reader"),
      ),
    ).toBe(true);
    expect(documentReaderPersona({ ...workflow, readerPersona: "CFO" })).toBe("CFO");
    expect(documentReaderPersona(workflow)).toContain("neighboring team");
  });
  it("decodes old records with document defaults", () => {
    const {
      documentType: _type,
      readerReviewEnabled: _enabled,
      readerPersona: _persona,
      readerSlot: _slot,
      readerPass: _pass,
      ...legacy
    } = base;
    expect(Schema.decodeUnknownSync(PlanningWorkflow)(legacy)).toMatchObject({
      documentType: null,
      readerReviewEnabled: false,
      readerPersona: null,
      readerSlot: null,
      readerPass: null,
    });
  });
});
