import { getServerAttachmentLimits, getServerProviderSendLimits } from "../protocolState";
import type { ComposerImageAttachment } from "../composerDraftStore";

/** Recomputed when the provider or attachments change; authoritative validation also runs at dispatch. */
export function composerAttachmentStatus(
  files: readonly ComposerImageAttachment[],
  provider: string,
): { error: string | null; notice: string | null } {
  if (!files.length) return { error: null, notice: null };
  try {
    const limits = getServerAttachmentLimits();
    const providerLimits = getServerProviderSendLimits(provider);
    const images = files.filter((file) => file.type === "image");
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    let error: string | null = null;
    if (files.length > limits.maxCount) error = `Attach at most ${limits.maxCount} files.`;
    else if (
      files.some(
        (file) =>
          file.sizeBytes > (file.type === "image" ? limits.maxImageBytes : limits.maxFileBytes),
      )
    )
      error = "An attachment exceeds the server size limit.";
    else if (images.reduce((sum, file) => sum + file.sizeBytes, 0) > limits.maxImagesBytes)
      error = "Images exceed the total image-size limit.";
    else if (total > limits.maxTotalBytes) error = "Attachments exceed the total turn-size limit.";
    else if (total > (providerLimits.maxAttachmentBytes ?? limits.maxTotalBytes))
      error = "Attachments exceed this provider’s total turn-size limit.";
    const overflow = Math.max(0, images.length - providerLimits.maxImagesPerTurn);
    return {
      error,
      notice: overflow
        ? `${overflow} ${overflow === 1 ? "image will" : "images will"} be delivered as ${overflow === 1 ? "a file" : "files"} because this provider's inline image limit was reached.`
        : null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Waiting for server attachment limits.",
      notice: null,
    };
  }
}
