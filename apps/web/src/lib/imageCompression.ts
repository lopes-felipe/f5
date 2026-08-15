import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS,
} from "@t3tools/contracts";

import {
  COMPOSER_IMAGE_OUTPUT_MIME_TYPE,
  type ImageCompressionFailureReason,
  type ImageCompressionWorkerResult,
} from "./imageCompression.core";
import { randomUUID } from "./utils";

export type CompressComposerImageResult =
  | {
      readonly ok: true;
      readonly file: File;
      readonly recompressed: boolean;
      readonly originalSizeBytes: number;
      readonly finalSizeBytes: number;
    }
  | { readonly ok: false; readonly reason: ImageCompressionFailureReason };

export type ComposerImageProcessor = (
  file: File,
  options?: { readonly signal?: AbortSignal | undefined },
) => Promise<CompressComposerImageResult>;

function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === COMPOSER_IMAGE_OUTPUT_MIME_TYPE ? ".webp" : "";
  const trimmedName = name.trim() || "image";
  if (!extension) return trimmedName;
  const dotIndex = trimmedName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? trimmedName.slice(0, dotIndex) : trimmedName;
  return `${baseName}${extension}`;
}

export function imageCompressionFailureMessage(
  fileName: string,
  reason: ImageCompressionFailureReason,
): string {
  const displayName = fileName.trim() || "image";
  switch (reason) {
    case "animated":
      return `'${displayName}' is animated. Animated GIF and WebP images cannot be attached.`;
    case "cancelled":
      return `'${displayName}' was not attached because the destination thread was removed.`;
    case "too-large":
      return `'${displayName}' is too large to attach, even after compression.`;
    case "unreadable":
      return `'${displayName}' could not be read as an image.`;
    case "unsupported":
      return `This browser cannot prepare '${displayName}' for attachment.`;
  }
}

export const compressImageForComposer: ComposerImageProcessor = async (file, options) => {
  if (options?.signal?.aborted) return { ok: false, reason: "cancelled" };
  if (typeof Worker !== "function") return { ok: false, reason: "unsupported" };

  let worker: Worker;
  try {
    worker = new Worker(new URL("./imageCompression.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return { ok: false, reason: "unsupported" };
  }

  const requestId = randomUUID();
  return new Promise<CompressComposerImageResult>((resolve) => {
    let settled = false;
    const finish = (result: CompressComposerImageResult) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: "cancelled" });

    options?.signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("error", () => finish({ ok: false, reason: "unreadable" }), {
      once: true,
    });
    worker.addEventListener("message", (event: MessageEvent) => {
      const payload = event.data as
        | { readonly id?: unknown; readonly result?: ImageCompressionWorkerResult }
        | undefined;
      if (!payload || payload.id !== requestId || !payload.result) return;
      const result = payload.result;
      if (!result.ok) {
        finish(result);
        return;
      }
      if (result.useOriginal) {
        finish({
          ok: true,
          file,
          recompressed: false,
          originalSizeBytes: file.size,
          finalSizeBytes: file.size,
        });
        return;
      }
      const outputFile = new File([result.blob], fileNameForMimeType(file.name, result.mimeType), {
        type: result.mimeType,
        lastModified: file.lastModified,
      });
      finish({
        ok: true,
        file: outputFile,
        recompressed: true,
        originalSizeBytes: file.size,
        finalSizeBytes: outputFile.size,
      });
    });

    if (options?.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage({
        id: requestId,
        file,
        mimeType: file.type,
        maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        maxDataUrlChars: PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS,
      });
    } catch {
      finish({ ok: false, reason: "unreadable" });
    }
  });
};
