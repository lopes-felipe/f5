import { readBoundedPreview } from "./readBoundedPreview";
import { BINARY_PREVIEW_MAX_BYTES } from "./binaryPreviewProtocol";

export async function readBinaryPreview(src: string, signal: AbortSignal) {
  return readBoundedPreview(src, signal, BINARY_PREVIEW_MAX_BYTES);
}
