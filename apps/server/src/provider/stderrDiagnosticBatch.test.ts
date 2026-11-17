import { expect, it } from "vitest";
import { EventId, ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { MAX_DIAGNOSTIC_TEXT_BYTES, StderrDiagnosticBatch } from "./stderrDiagnosticBatch.ts";

const event = (message: string): ProviderEvent => ({
  id: EventId.makeUnsafe("stderr"),
  threadId: ThreadId.makeUnsafe("thread"),
  provider: "codex",
  kind: "error",
  createdAt: "2026-11-17T11:06:44.704Z",
  method: "process/stderr",
  message,
});

it("retains the leading error and bounds 8,690 source lines with an omission count", () => {
  const batch = new StderrDiagnosticBatch(event("apply_patch verification failed"));
  for (let index = 0; index < 8690; index++) batch.append("import { Source } from './source';");
  const result = batch.toEvent();
  expect(result.message).toMatch(/^apply_patch verification failed\nimport/);
  expect(Buffer.byteLength(result.message!)).toBeLessThan(MAX_DIAGNOSTIC_TEXT_BYTES + 100);
  expect(result.payload).toMatchObject({ omittedLines: expect.any(Number) });
  expect(result.message).toMatch(/\[\d+ stderr lines omitted\]$/);
  expect(batch.first.message).toBeUndefined();
});

it("truncates UTF-8 at code point boundaries and preserves earlier omissions", () => {
  const batch = new StderrDiagnosticBatch(event("🙂".repeat(10000)), 17);
  const result = batch.toEvent();
  expect(result.message).not.toContain("�");
  expect(result.payload).toMatchObject({ omittedLines: 18 });
  expect(Buffer.byteLength(result.message!.split("\n")[0]!)).toBe(MAX_DIAGNOSTIC_TEXT_BYTES);
});

it("keeps a contiguous leading excerpt after truncation", () => {
  const batch = new StderrDiagnosticBatch(event("a".repeat(MAX_DIAGNOSTIC_TEXT_BYTES - 2)));
  batch.append("🙂");
  batch.append("x");
  expect(batch.toEvent().message).not.toContain("x");
  expect(batch.toEvent().payload).toMatchObject({ omittedLines: 2 });
});
