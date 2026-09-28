import { describe, expect, it } from "vitest";
import { DOCUMENT_WORKFLOW_TEMPLATE_ID } from "@t3tools/contracts";
import {
  WORKFLOW_DOCUMENT_PROFILES,
  WORKFLOW_DOCUMENT_TYPE_ORDER,
  normalizeDocumentMarkdown,
  validateDocumentArtifact,
  planningWorkflowDocumentType,
  defaultDocumentReaderSlot,
} from "./documentWorkflow";

const rfc =
  "# Safer retries\n\n" +
  WORKFLOW_DOCUMENT_PROFILES.rfc.sections
    .map(({ heading }) => `## ${heading}\nConcrete evidence and recommendations.\n`)
    .join("\n");
describe("document artifacts", () => {
  it("rejects a bare title marker whose whitespace spans lines", () => {
    expect(validateDocumentArtifact("#\n\nBody\n## Summary\nContent", "rfc", "capture").valid).toBe(
      false,
    );
  });
  it("defines all eight audience profiles", () => {
    expect(Object.keys(WORKFLOW_DOCUMENT_PROFILES)).toEqual([...WORKFLOW_DOCUMENT_TYPE_ORDER]);
    for (const type of WORKFLOW_DOCUMENT_TYPE_ORDER) {
      const profile = WORKFLOW_DOCUMENT_PROFILES[type];
      expect(profile.readerPersona.length).toBeGreaterThan(20);
      if (type !== "custom") expect(profile.sections.length).toBeGreaterThanOrEqual(3);
    }
  });
  it("identifies documents only by template and heals missing types as custom", () => {
    expect(planningWorkflowDocumentType({ documentType: "rfc" })).toBeNull();
    expect(planningWorkflowDocumentType({ templateId: DOCUMENT_WORKFLOW_TEMPLATE_ID })).toBe(
      "custom",
    );
  });
  it("defaults the reader to an author different from merge", () => {
    const a = { provider: "codex" as const, model: "a" };
    const b = { provider: "claudeAgent" as const, model: "b" };
    expect(defaultDocumentReaderSlot({ branchA: a, branchB: b, merge: a })).toBe(b);
    expect(defaultDocumentReaderSlot({ branchA: a, branchB: b, merge: b })).toBe(a);
  });
  it("normalizes short preambles, CRLF and genuine wrappers idempotently", () => {
    for (const input of [
      rfc,
      `Here is the RFC.\nFor your review.\n\n${rfc}`,
      `<proposed_plan>\r\n${rfc}\r\n</proposed_plan>`,
    ]) {
      expect(normalizeDocumentMarkdown(input)).toBe(rfc.trimEnd() + "\n");
      expect(normalizeDocumentMarkdown(normalizeDocumentMarkdown(input))).toBe(
        normalizeDocumentMarkdown(input),
      );
    }
  });
  it("does not mistake code examples for headings or strip literal plan tags", () => {
    const code = "```md\n# Example\n<proposed_plan>\n## Example\n</proposed_plan>\n```";
    expect(normalizeDocumentMarkdown(`# Title\n## Details\n${code}`)).toContain(code);
    expect(validateDocumentArtifact(`# Title\n${code}`, "rfc", "capture").valid).toBe(false);
    expect(validateDocumentArtifact(code, "custom", "capture").valid).toBe(false);
  });
  it("preserves a long preamble and rejects it", () => {
    const input = "preamble\n".repeat(6) + rfc;
    expect(normalizeDocumentMarkdown(input)).toContain("preamble");
    expect(validateDocumentArtifact(input, "rfc", "capture").valid).toBe(false);
  });
  it("is lenient at capture but protects complete replacements", () => {
    expect(validateDocumentArtifact(rfc, "rfc", "replacement").valid).toBe(true);
    const renamed = "# RFC\n## Different heading\nUseful body";
    expect(validateDocumentArtifact(renamed, "rfc", "capture").valid).toBe(true);
    for (const input of [
      renamed,
      "An answer",
      "# Plan\n## Summary\nA\n## Key Changes\nB\n## Test Plan\nC",
    ])
      expect(validateDocumentArtifact(input, "rfc", "replacement").valid).toBe(false);
  });
  it.each([
    "No title\n## Body\nText",
    "# Title",
    "# Title\nBody without sections",
    `# Title\n## Section\n${"x".repeat(36_001)}`,
  ])("rejects malformed or oversized capture", (input) => {
    expect(validateDocumentArtifact(input, "rfc", "capture").valid).toBe(false);
  });
});
