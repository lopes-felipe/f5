import type { ChatAttachment } from "@t3tools/contracts";

export interface AttachmentMetadataInput {
  readonly attachment: ChatAttachment;
  readonly localPath?: string;
}

// This record intentionally fails to compile when the contract adds an
// attachment type before the provider attachment pipeline is updated.
const SUPPORTED_ATTACHMENT_TYPES = {
  image: true,
} satisfies Record<ChatAttachment["type"], true>;

/**
 * Formats attachment metadata without reading attachment contents. Quoting
 * user-controlled values keeps the resulting provider prompt unambiguous.
 */
export function formatAttachmentMetadataLine(input: AttachmentMetadataInput): string {
  const { attachment } = input;
  switch (attachment.type) {
    case "image":
      return [
        `- ${JSON.stringify(attachment.name)}`,
        `(${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
        ...(input.localPath ? [`saved at ${JSON.stringify(input.localPath)}`] : []),
      ].join(" ");
    default:
      throw new Error(
        `Unsupported attachment type '${String((attachment as { type?: unknown }).type)}'.`,
      );
  }
}

void SUPPORTED_ATTACHMENT_TYPES;

export function formatAttachmentMetadata(
  attachments: ReadonlyArray<AttachmentMetadataInput>,
): ReadonlyArray<string> {
  return attachments.map(formatAttachmentMetadataLine);
}
