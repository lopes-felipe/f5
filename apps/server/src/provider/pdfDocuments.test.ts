import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { estimateClaudePdfPages, pdfDocuments } from "./pdfDocuments";
import type { ProviderResolvedAttachment } from "./Services/ProviderAdapter";

const roots: string[] = [];
afterEach(async () => {
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
it("embeds a PDF with an explicit page tree and retains budgets across calls", async () => {
  const input = await fixture();
  const docs = await pdfDocuments(input);
  expect(Buffer.from(docs[0]!.data, "base64")).toEqual(pdf);
  await pdfDocuments({ ...input, baseBytes: 28 * 1024 * 1024, attachments: [] });
  expect(await pdfDocuments(input)).toEqual([]);
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
