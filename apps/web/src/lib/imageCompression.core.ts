export const MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_COMPRESSIBLE_IMAGE_PIXELS = 25_000_000;
export const IMAGE_COMPRESSION_DIMENSION_STEPS = [2048, 1536, 1024] as const;
export const IMAGE_COMPRESSION_QUALITY_STEPS = [0.92, 0.86, 0.8, 0.72, 0.64] as const;
export const COMPOSER_IMAGE_OUTPUT_MIME_TYPE = "image/webp";

const PROVIDER_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ImageCompressionFailureReason =
  | "animated"
  | "cancelled"
  | "timed-out"
  | "too-large"
  | "unreadable"
  | "unsupported";

export type ImageCompressionWorkerResult =
  | { readonly ok: true; readonly useOriginal: true; readonly mimeType: string }
  | {
      readonly ok: true;
      readonly useOriginal: false;
      readonly blob: Blob;
      readonly mimeType: typeof COMPOSER_IMAGE_OUTPUT_MIME_TYPE;
    }
  | { readonly ok: false; readonly reason: Exclude<ImageCompressionFailureReason, "cancelled"> };

function normalizedMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

export function imageDataUrlCharLength(sizeBytes: number, mimeType: string): number {
  const prefixLength = `data:${normalizedMimeType(mimeType)};base64,`.length;
  return prefixLength + 4 * Math.ceil(Math.max(0, sizeBytes) / 3);
}

export function isProviderSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType(mimeType));
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

export function readImagePixelDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { readonly width: number; readonly height: number } | null {
  switch (normalizedMimeType(mimeType)) {
    case "image/png":
      return bytes.length >= 24 && asciiAt(bytes, 1, "PNG\r\n\u001a\n")
        ? { width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) }
        : null;
    case "image/gif":
      return bytes.length >= 10 && (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a"))
        ? { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) }
        : null;
    case "image/webp": {
      if (bytes.length < 30 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) {
        return null;
      }
      if (asciiAt(bytes, 12, "VP8X")) {
        return {
          width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
          height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
        };
      }
      if (asciiAt(bytes, 12, "VP8 ") && asciiAt(bytes, 23, "\u009d\u0001*")) {
        return {
          width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
          height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
        };
      }
      if (asciiAt(bytes, 12, "VP8L") && bytes[20] === 0x2f) {
        return {
          width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
          height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
        };
      }
      return null;
    }
    case "image/jpeg": {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: readUint16Be(bytes, offset + 7),
            height: readUint16Be(bytes, offset + 5),
          };
        }
        const segmentLength = readUint16Be(bytes, offset + 2);
        if (segmentLength < 2) return null;
        offset += 2 + segmentLength;
      }
      return null;
    }
    default:
      return null;
  }
}

function skipGifSubBlocks(bytes: Uint8Array, initialOffset: number): number | null {
  let offset = initialOffset;
  while (offset < bytes.length) {
    const blockSize = bytes[offset]!;
    offset += 1;
    if (blockSize === 0) return offset;
    if (offset + blockSize > bytes.length) return null;
    offset += blockSize;
  }
  return null;
}

export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || (!asciiAt(bytes, 0, "GIF87a") && !asciiAt(bytes, 0, "GIF89a"))) {
    return false;
  }

  const packedFields = bytes[10]!;
  const globalColorTableBytes =
    (packedFields & 0x80) === 0 ? 0 : 3 * 2 ** ((packedFields & 0x07) + 1);
  let offset = 13 + globalColorTableBytes;
  let frameCount = 0;

  while (offset < bytes.length) {
    const marker = bytes[offset]!;
    if (marker === 0x3b) return frameCount > 1;
    if (marker === 0x21) {
      if (offset + 2 > bytes.length) return false;
      const nextOffset = skipGifSubBlocks(bytes, offset + 2);
      if (nextOffset === null) return false;
      offset = nextOffset;
      continue;
    }
    if (marker !== 0x2c || offset + 10 > bytes.length) return false;

    frameCount += 1;
    if (frameCount > 1) return true;
    const imagePackedFields = bytes[offset + 9]!;
    const localColorTableBytes =
      (imagePackedFields & 0x80) === 0 ? 0 : 3 * 2 ** ((imagePackedFields & 0x07) + 1);
    offset += 10 + localColorTableBytes;
    if (offset >= bytes.length) return false;
    offset += 1; // LZW minimum code size.
    const nextOffset = skipGifSubBlocks(bytes, offset);
    if (nextOffset === null) return false;
    offset = nextOffset;
  }

  return false;
}

export function isAnimatedWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkSize = readUint32Le(bytes, offset + 4);
    const payloadOffset = offset + 8;
    if (asciiAt(bytes, offset, "ANIM") || asciiAt(bytes, offset, "ANMF")) return true;
    if (
      asciiAt(bytes, offset, "VP8X") &&
      chunkSize > 0 &&
      payloadOffset < bytes.length &&
      (bytes[payloadOffset]! & 0x02) !== 0
    ) {
      return true;
    }
    const nextOffset = payloadOffset + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset || nextOffset > bytes.length) return false;
    offset = nextOffset;
  }
  return false;
}

export function isAnimatedImage(bytes: Uint8Array, mimeType: string): boolean {
  switch (normalizedMimeType(mimeType)) {
    case "image/gif":
      return isAnimatedGif(bytes);
    case "image/webp":
      return isAnimatedWebP(bytes);
    default:
      return false;
  }
}

function uniqueTargetDimensions(width: number, height: number): number[] {
  const sourceDimension = Math.max(width, height);
  return Array.from(
    new Set(
      IMAGE_COMPRESSION_DIMENSION_STEPS.map((dimension) =>
        Math.max(1, Math.min(sourceDimension, dimension)),
      ),
    ),
  );
}

async function encodeAtDimension(
  bitmap: ImageBitmap,
  maxDimension: number,
  maxBytes: number,
  maxDataUrlChars: number,
): Promise<Blob | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of IMAGE_COMPRESSION_QUALITY_STEPS) {
    const blob = await canvas.convertToBlob({
      type: COMPOSER_IMAGE_OUTPUT_MIME_TYPE,
      quality,
    });
    if (normalizedMimeType(blob.type) !== COMPOSER_IMAGE_OUTPUT_MIME_TYPE) {
      return null;
    }
    if (
      blob.size > 0 &&
      blob.size <= maxBytes &&
      imageDataUrlCharLength(blob.size, blob.type) <= maxDataUrlChars
    ) {
      return blob;
    }
  }
  return null;
}

export async function processImageForComposerInWorker(input: {
  readonly file: Blob;
  readonly mimeType: string;
  readonly maxBytes: number;
  readonly maxDataUrlChars: number;
}): Promise<ImageCompressionWorkerResult> {
  const mimeType = normalizedMimeType(input.mimeType);
  if (input.file.size <= 0) return { ok: false, reason: "unreadable" };
  if (input.file.size > MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let headerBytes: Uint8Array;
  try {
    headerBytes = new Uint8Array(await input.file.slice(0, 64 * 1024).arrayBuffer());
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const dimensions = readImagePixelDimensions(headerBytes, mimeType);
  if (
    dimensions !== null &&
    (dimensions.width <= 0 ||
      dimensions.height <= 0 ||
      dimensions.width * dimensions.height > MAX_COMPRESSIBLE_IMAGE_PIXELS)
  ) {
    return { ok: false, reason: "too-large" };
  }

  if (mimeType === "image/gif" || mimeType === "image/webp") {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await input.file.arrayBuffer());
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (isAnimatedImage(bytes, mimeType)) return { ok: false, reason: "animated" };
  }

  if (
    isProviderSupportedImageMimeType(mimeType) &&
    input.file.size <= input.maxBytes &&
    imageDataUrlCharLength(input.file.size, mimeType) <= input.maxDataUrlChars
  ) {
    return { ok: true, useOriginal: true, mimeType };
  }

  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return { ok: false, reason: "unsupported" };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input.file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      return { ok: false, reason: "unreadable" };
    }
    for (const dimension of uniqueTargetDimensions(bitmap.width, bitmap.height)) {
      try {
        const blob = await encodeAtDimension(
          bitmap,
          dimension,
          input.maxBytes,
          input.maxDataUrlChars,
        );
        if (blob) {
          return {
            ok: true,
            useOriginal: false,
            blob,
            mimeType: COMPOSER_IMAGE_OUTPUT_MIME_TYPE,
          };
        }
      } catch {
        // A smaller canvas can still succeed after an allocation or encoder failure.
      }
    }
    return { ok: false, reason: "too-large" };
  } finally {
    bitmap.close();
  }
}
