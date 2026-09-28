import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WorkflowPlatformCreateRunInput } from "./workflowPlatform";
import { DocumentReaderPass, DOCUMENT_WORKFLOW_TEMPLATE_ID } from "./planningWorkflow";
import {
  OrchestrationSkipDocumentReaderPassInput,
  OrchestrationSkipDocumentReaderPassResult,
} from "./orchestration";
const slot = { provider: "codex", model: "gpt-5-codex" };
const input = {
  templateId: DOCUMENT_WORKFLOW_TEMPLATE_ID,
  input: {
    projectId: "project",
    requirementPrompt: "Write the RFC",
    documentType: "rfc",
    branchA: slot,
    branchB: slot,
    merge: slot,
  },
};
describe("document workflow contracts", () => {
  const decode = Schema.decodeUnknownSync(WorkflowPlatformCreateRunInput);
  it("defaults reader and own-model reviews on", () => {
    const result = decode(input);
    expect(result.input).toMatchObject({ readerReviewEnabled: true, selfReviewEnabled: true });
  });
  it("rejects invalid versions, missing types and oversized inputs", () => {
    expect(() => decode({ ...input, templateVersion: 1 })).toThrow();
    for (const patch of [
      { documentType: undefined },
      { requirementPrompt: "x".repeat(24_001) },
      { readerPersona: "x".repeat(501) },
    ])
      expect(() => decode({ ...input, input: { ...input.input, ...patch } })).toThrow();
  });
  it("round trips reader state and defaults recovery counters", () => {
    const decodePass = Schema.decodeUnknownSync(DocumentReaderPass);
    const pass = decodePass({
      status: "reader_requested",
      draftTurnId: "draft",
      draftPlanId: "plan",
      readerThreadId: "reader",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(pass).toMatchObject({
      error: null,
      retryCount: 0,
      polishFormatRepairAttempts: 0,
      pinnedTurnId: null,
    });
    expect(decodePass(Schema.encodeSync(DocumentReaderPass)(pass))).toEqual(pass);
  });
  it("defines the skip RPC", () => {
    expect(
      Schema.decodeUnknownSync(OrchestrationSkipDocumentReaderPassInput)({
        workflowId: "workflow",
      }),
    ).toEqual({ workflowId: "workflow" });
    expect(
      Schema.decodeUnknownSync(OrchestrationSkipDocumentReaderPassResult)({ status: "completed" }),
    ).toEqual({ status: "completed" });
  });
});
