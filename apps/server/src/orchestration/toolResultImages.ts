import { ingestActivityAttachment } from "../activityAttachments.ts";

/** Screenshots kept per tool item; extras are counted in `mcpImagesOmitted`. */
export const MAX_TOOL_RESULT_IMAGES = 1;
export const MAX_TOOL_RESULT_IMAGE_BYTES = 8 * 1024 * 1024;
/** Activity-owned screenshots retained per thread; later ones are counted as omitted. */
export { MAX_THREAD_ACTIVITY_ATTACHMENTS as MAX_THREAD_TOOL_RESULT_IMAGES } from "../activityAttachments.ts";
export { MAX_THREAD_ACTIVITY_ATTACHMENT_BYTES as MAX_THREAD_TOOL_RESULT_IMAGE_BYTES } from "../activityAttachments.ts";
const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
// Matches the retained JSON depth bound; deeper output is omitted by its projector.
const MAX_SCAN_DEPTH = 32;

export interface ExtractedToolResultImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ToolResultImageExtraction {
  /** The input with every inline image's base64 payload removed. */
  readonly scrubbed: unknown;
  readonly images: ReadonlyArray<ExtractedToolResultImage>;
  /** Images dropped for count, size, or format limits. */
  readonly omitted: number;
}

export interface ToolResultImageRef {
  readonly attachmentId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Recognizes the Claude (`source.base64`) and MCP (`data` + `mimeType`) image block shapes. */
function readInlineImage(
  record: Record<string, unknown>,
): { mimeType: string; data: string } | null {
  if (record.type !== "image") return null;
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;
  if (source?.type === "base64" && typeof source.data === "string") {
    return { mimeType: String(source.media_type ?? ""), data: source.data };
  }
  if (typeof record.data === "string") {
    return { mimeType: String(record.mimeType ?? record.mime_type ?? ""), data: record.data };
  }
  return null;
}

function decodeImage(image: { mimeType: string; data: string }): Uint8Array | null {
  const mimeType = image.mimeType.toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return null;
  // Base64 inflates by 4/3; reject oversized payloads before decoding them.
  if (image.data.length > Math.ceil((MAX_TOOL_RESULT_IMAGE_BYTES * 4) / 3) + 4) return null;
  if (!BASE64_PATTERN.test(image.data)) return null;
  const bytes = Buffer.from(image.data, "base64");
  return bytes.length > 0 && bytes.length <= MAX_TOOL_RESULT_IMAGE_BYTES ? bytes : null;
}

export function extractToolResultImages(value: unknown): ToolResultImageExtraction {
  const images: ExtractedToolResultImage[] = [];
  let omitted = 0;
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      const visited = node.map((entry) => visit(entry, depth + 1));
      return visited.some((entry, index) => entry !== node[index]) ? visited : node;
    }
    const record = node as Record<string, unknown>;
    const inline = readInlineImage(record);
    if (inline) {
      const bytes = images.length < MAX_TOOL_RESULT_IMAGES ? decodeImage(inline) : null;
      if (bytes) images.push({ mimeType: inline.mimeType.toLowerCase(), bytes });
      else omitted += 1;
      return { type: "image", mimeType: inline.mimeType, omitted: true };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const visited = visit(entry, depth + 1);
      if (visited !== entry) changed = true;
      next[key] = visited;
    }
    return changed ? next : record;
  };
  const scrubbed = visit(value, 0);
  return { scrubbed, images, omitted };
}

/** True when a value still carries an inline base64 image anywhere a scan would find it. */
export function containsInlineToolResultImage(value: unknown): boolean {
  const extraction = extractToolResultImages(value);
  return extraction.images.length > 0 || extraction.omitted > 0;
}

export { activityAttachmentId as toolResultImageAttachmentId } from "../activityAttachments.ts";
export const ingestToolResultImage = (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly itemKey: string;
  readonly activityId: string;
  readonly image: ExtractedToolResultImage;
}) =>
  ingestActivityAttachment({
    ...input,
    file: { ...input.image, type: "image", name: `screenshot-${input.itemKey}` },
  });
