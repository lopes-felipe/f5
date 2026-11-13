import { formatAttachmentMetadata } from "@t3tools/shared/attachmentMetadata";

import type { ProviderResolvedAttachment } from "./Services/ProviderAdapter.ts";

export function escapeRuntimeContextLine(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildProviderAttachmentRuntimeContext(
  attachments: ReadonlyArray<ProviderResolvedAttachment>,
): string | undefined {
  if (attachments.length === 0) {
    return undefined;
  }

  const lines = formatAttachmentMetadata(
    attachments.map((attachment) => ({
      attachment,
      localPath: attachment.localPath,
    })),
  );

  return [
    "<f5-attachment-context>",
    "Attachments are saved at the local paths listed below for best-effort access.",
    "Supported images and PDFs may also be supplied inline; other files and attachments beyond the inline limits are available by path. The active sandbox may prevent opening a path.",
    ...lines.map(escapeRuntimeContextLine),
    "</f5-attachment-context>",
  ].join("\n");
}

export function appendProviderAttachmentRuntimeContext(
  prompt: string | undefined,
  attachments: ReadonlyArray<ProviderResolvedAttachment>,
): string | undefined {
  const context = buildProviderAttachmentRuntimeContext(attachments);
  if (!context) {
    return prompt;
  }
  return prompt?.trim() ? `${prompt}\n\n${context}` : context;
}
