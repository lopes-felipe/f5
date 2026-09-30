import { expect, it } from "vitest";
import { nativeProviderAttachments, getProviderAttachmentLimitError } from "./attachmentLimits";
import type { ChatAttachment } from "@t3tools/contracts";
const images: ChatAttachment[] = Array.from({ length: 21 }, (_, i) => ({
  type: "image",
  id: String(i),
  name: `${i}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
}));
it("keeps every image within the turn cap and selects only supported inline counts", () => {
  expect(getProviderAttachmentLimitError(images, "claudeAgent")).toBeNull();
  expect(nativeProviderAttachments(images, "claudeAgent")).toHaveLength(20);
  expect(nativeProviderAttachments(images, "codex")).toHaveLength(20);
  expect(nativeProviderAttachments(images, "grok")).toHaveLength(10);
  expect(images).toHaveLength(21);
});
it("selects OpenCode file parts without exposing arbitrary binaries inline", () => {
  const files: ChatAttachment[] = [
    { type: "file", id: "a", name: "file.pdf", mimeType: "application/pdf", sizeBytes: 1 },
    { type: "file", id: "b", name: "file.zip", mimeType: "application/zip", sizeBytes: 1 },
  ];
  expect(nativeProviderAttachments(files, "opencode").map((file) => file.id)).toEqual(["a"]);
  expect(nativeProviderAttachments(files, "claudeAgent")).toEqual([]);
});
it("enforces aggregate and Antigravity byte ceilings at dispatch", () => {
  expect(
    getProviderAttachmentLimitError(
      images.map((file) => ({ ...file, sizeBytes: 10 * 1024 * 1024 })),
      "codex",
    ),
  ).toContain("80 MiB");
  const files: ChatAttachment[] = Array.from({ length: 6 }, (_, i) => ({
    type: "file",
    id: String(i),
    name: "file.pdf",
    mimeType: "application/pdf",
    sizeBytes: 50 * 1024 * 1024,
  }));
  expect(getProviderAttachmentLimitError(files, "claudeAgent")).toContain("256 MiB");
  expect(getProviderAttachmentLimitError(files.slice(0, 2), "antigravity")).toContain("50 MiB");
});
