import {
  IMAGE_ATTACHMENT_MAX_EDGE,
  MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES,
} from "./imageCompression.core";
import { type ComposerImageProcessor } from "./imageCompression";

export const MAX_HEIC_DECODE_PIXELS = 64_000_000;

/** Check HEIF spatial extents before handing compressed bytes to the decoder.
 * Unknown/compact layouts are refused rather than decoded without a pixel budget. */
export function validateHeicDimensions(bytes: ArrayBuffer): void {
  const data = new DataView(bytes);
  let boxes = 0;
  let found = false;
  const walk = (start: number, end: number, depth: number) => {
    if (depth > 8) throw new Error("HEIC metadata is too deeply nested.");
    let offset = start;
    while (offset < end) {
      if (++boxes > 4096 || offset + 8 > end) throw new Error("Invalid HEIC metadata.");
      const shortSize = data.getUint32(offset);
      const type = String.fromCharCode(...new Uint8Array(bytes, offset + 4, 4));
      let header = 8;
      let size = shortSize || end - offset;
      if (shortSize === 1) {
        if (offset + 16 > end) throw new Error("Invalid HEIC box.");
        size = Number(data.getBigUint64(offset + 8));
        header = 16;
      }
      if (!Number.isSafeInteger(size) || size < header || offset + size > end)
        throw new Error("Invalid HEIC box.");
      const body = offset + header;
      if (type === "ispe") {
        if (size < header + 12) throw new Error("Invalid HEIC dimensions.");
        const width = data.getUint32(body + 4);
        const height = data.getUint32(body + 8);
        if (!width || !height || width * height > MAX_HEIC_DECODE_PIXELS)
          throw new Error("HEIC image exceeds the pixel limit.");
        found = true;
      } else if (type === "meta" || type === "iprp" || type === "ipco") {
        walk(body + (type === "meta" ? 4 : 0), offset + size, depth + 1);
      }
      offset += size;
    }
  };
  walk(0, bytes.byteLength, 0);
  if (!found) throw new Error("HEIC dimensions could not be verified.");
}

let decoder: Promise<typeof import("heic-to/csp")> | undefined;
let activeHeicDecodes = 0;
const decodeHeic: ComposerImageProcessor = async (file, options) => {
  if (file.size > MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES) return { ok: false, reason: "too-large" };
  // A deadline can free the shared composer slot before libheif returns.
  // Keep a separate bound on those non-interruptible decodes until their bitmaps are released.
  if (activeHeicDecodes >= 2) return { ok: false, reason: "busy" };
  activeHeicDecodes++;
  try {
    validateHeicDimensions(await file.arrayBuffer());
    if (options?.signal?.aborted) return { ok: false, reason: "cancelled" };
    const { heicTo } = await (decoder ??= import("heic-to/csp").catch((error) => {
      decoder = undefined;
      throw error;
    }));
    if (options?.signal?.aborted) return { ok: false, reason: "cancelled" };
    const bitmap = await heicTo({ blob: file, type: "bitmap" });
    try {
      if (options?.signal?.aborted) return { ok: false, reason: "cancelled" };
      if (
        !bitmap.width ||
        !bitmap.height ||
        bitmap.width * bitmap.height > MAX_HEIC_DECODE_PIXELS
      ) {
        return { ok: false, reason: "too-large" };
      }
      const scale = Math.min(1, IMAGE_ATTACHMENT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, reason: "unsupported" };
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) return { ok: false, reason: "unreadable" };
      const output = new File([blob], file.name, { type: blob.type });
      return {
        ok: true,
        file: output,
        recompressed: true,
        originalSizeBytes: file.size,
        finalSizeBytes: output.size,
      };
    } finally {
      bitmap.close();
    }
  } finally {
    activeHeicDecodes--;
  }
};

/** Call inside processComposerImageTaskBounded so fetching and decoding share one slot. */
export function decodeHeicPreview(blob: Blob, name: string, signal: AbortSignal) {
  return decodeHeic(new File([blob], name, { type: "image/heic" }), { signal });
}
