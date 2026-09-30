import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_IMAGES_BYTES,
  ATTACHMENT_MAX_TURN_BYTES,
  type ChatAttachment,
  type ProviderKind,
} from "@t3tools/contracts";

export function providerMaxAttachmentBytes(provider: ProviderKind): number {
  return provider === "antigravity" ? ATTACHMENT_MAX_FILE_BYTES : ATTACHMENT_MAX_TURN_BYTES;
}
export function providerMaxImages(provider: ProviderKind): number {
  return provider === "cursor" || provider === "grok" ? 10 : 20;
}
export function getProviderAttachmentLimitError(
  attachments: ReadonlyArray<ChatAttachment>,
  provider?: ProviderKind,
): string | null {
  if (attachments.length > ATTACHMENT_MAX_COUNT)
    return "A turn can include at most 100 attachments.";
  let total = 0;
  let images = 0;
  for (const file of attachments) {
    const limit = file.type === "image" ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > limit)
      return `Attachment ${file.name} is empty or exceeds its size limit.`;
    total += file.sizeBytes;
    if (file.type === "image") images += file.sizeBytes;
  }
  if (images > ATTACHMENT_MAX_IMAGES_BYTES) return "Images exceed the 80 MiB turn limit.";
  if (total > ATTACHMENT_MAX_TURN_BYTES) return "Attachments exceed the 256 MiB turn limit.";
  if (provider !== undefined && total > providerMaxAttachmentBytes(provider))
    return "Antigravity accepts at most 50 MiB of attachments per turn.";
  return null;
}
export function nativeProviderAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
  provider: ProviderKind,
): ChatAttachment[] {
  let images = 0;
  return attachments.filter((file) =>
    file.type === "image"
      ? ++images <= providerMaxImages(provider)
      : provider === "opencode" &&
        (file.mimeType.startsWith("text/") || file.mimeType === "application/pdf"),
  );
}
