import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import {
  acpPdfDocuments,
  deletePdfDocumentBudgets,
  estimateClaudePdfPages,
  estimateClaudePdfPagesAsync,
  pdfDocuments,
} from "./pdfDocuments";
import type { ProviderResolvedAttachment } from "./Services/ProviderAdapter";
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: vi.fn(original.readFile),
    writeFile: vi.fn(original.writeFile),
    rename: vi.fn(original.rename),
  };
});

const roots: string[] = [];
it("yields to the event loop while scanning a large PDF comment", async () => {
  const data = Buffer.concat([
    Buffer.from("%PDF-1.7\n%"),
    Buffer.alloc(2 * 1024 * 1024, 120),
    Buffer.from("\n"),
    pdf,
  ]);
  let progressed = false;
  setImmediate(() => {
    progressed = true;
  });
  expect(await estimateClaudePdfPagesAsync(data)).toBe(1);
  expect(progressed).toBe(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const pdf = Buffer.from(
  "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
);
async function fixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "f5-pdf-test-"));
  roots.push(stateDir);
  const file = path.join(stateDir, "scan.pdf");
  await writeFile(file, pdf);
  const attachment = {
    type: "file",
    id: "scan",
    name: "scan.pdf",
    mimeType: "application/pdf",
    sizeBytes: pdf.length,
    localPath: file,
  } as ProviderResolvedAttachment;
  return { stateDir, sessionKey: "session", baseBytes: 100, attachments: [attachment] };
}
it("counts current request bytes without charging unrelated turns to the lifetime PDF budget", async () => {
  const input = await fixture();
  const docs = await pdfDocuments(input);
  expect(Buffer.from(docs[0]!.data, "base64")).toEqual(pdf);
  await pdfDocuments({ ...input, baseBytes: 28 * 1024 * 1024, attachments: [] });
  expect(await pdfDocuments({ ...input, baseBytes: 28 * 1024 * 1024 })).toEqual([]);
  expect(await pdfDocuments(input)).toHaveLength(1);
});
it("does no budget I/O for a turn without PDFs", async () => {
  const input = await fixture();
  const read = vi.mocked(fs.readFile).mockClear();
  const write = vi.mocked(fs.writeFile).mockClear();
  expect(await pdfDocuments({ ...input, attachments: [] })).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it("falls back to paths when persisting a reservation fails", async () => {
  const input = await fixture();
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Disk full"));
  expect(await pdfDocuments(input)).toEqual([]);
  expect(await pdfDocuments(input)).toHaveLength(1);
});
it("reclaims only the deleted thread's budget records", async () => {
  const input = await fixture();
  await pdfDocuments({ ...input, sessionKey: "claude:deleted" });
  await pdfDocuments({ ...input, sessionKey: "claude:kept" });
  await deletePdfDocumentBudgets(input.stateDir, "deleted");
  expect(await fs.readdir(path.join(input.stateDir, "provider-document-budgets"))).toHaveLength(1);
});
it("sends PDFs as ACP resources only with embedded-context capability", async () => {
  const input = await fixture();
  expect(await acpPdfDocuments(input, false)).toEqual([]);
  expect(await acpPdfDocuments(input, true)).toEqual([
    {
      type: "resource",
      resource: {
        uri: expect.stringMatching(/^attachment:/),
        mimeType: "application/pdf",
        blob: pdf.toString("base64"),
      },
    },
  ]);
});
it("serializes concurrent reservations so the page budget cannot be oversubscribed", async () => {
  const input = await fixture();
  const results = await Promise.all(Array.from({ length: 101 }, () => pdfDocuments(input)));
  expect(results.flat()).toHaveLength(100);
});
it("keeps malformed, encrypted, and unknown-page PDFs path-only", async () => {
  expect(estimateClaudePdfPages(Buffer.from("%PDF-1.7\n/Type /Page\n%%EOF"))).toBeNull();
  expect(estimateClaudePdfPages(Buffer.concat([pdf, Buffer.from("\n/Encrypt 1 0 R")]))).toBeNull();
  const input = await fixture();
  await writeFile(input.attachments[0]!.localPath, "not a PDF");
  expect(await pdfDocuments(input)).toEqual([]);
});
