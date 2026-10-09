import { createHash } from "node:crypto";

import type { ChatAttachment } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileBytesAtomically } from "../atomicWrite.ts";
import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

/** Screenshots kept per tool item; extras are counted in `mcpImagesOmitted`. */
export const MAX_TOOL_RESULT_IMAGES = 1;
export const MAX_TOOL_RESULT_IMAGE_BYTES = 8 * 1024 * 1024;
/** Activity-owned screenshots retained per thread; later ones are counted as omitted. */
export const MAX_THREAD_TOOL_RESULT_IMAGES = 200;
const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SCAN_DEPTH = 8;

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

/**
 * Attachment ids derive from the thread, tool item and content, so replayed or repeated
 * lifecycle events resolve to the same attachment instead of writing duplicates.
 */
export function toolResultImageAttachmentId(input: {
  readonly threadId: string;
  readonly itemKey: string;
  readonly contentHash: string;
}): string | null {
  const segment = toSafeThreadAttachmentSegment(input.threadId);
  if (!segment) return null;
  const hex = createHash("sha256")
    .update(`${input.threadId}\0${input.itemKey}\0${input.contentHash}`)
    .digest("hex");
  return `${segment}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Stores one tool-result image in the attachment registry, owned by its activity, so it
 * is served like chat images and reclaimed with the thread. Bytes are staged and the row
 * is registered before the file is promoted, matching chat attachment ingress, so startup
 * recovery finishes or discards an interrupted write. Returns null when the image is
 * dropped (thread cap reached or registration failed).
 */
export const ingestToolResultImage = Effect.fnUntraced(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  /** Provider tool item id (or event id); stable across the item's lifecycle events. */
  readonly itemKey: string;
  readonly activityId: string;
  readonly image: ExtractedToolResultImage;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contentHash = createHash("sha256").update(input.image.bytes).digest("hex");
  const attachmentId = toolResultImageAttachmentId({
    threadId: input.threadId,
    itemKey: input.itemKey,
    contentHash,
  });
  if (!attachmentId) return null;
  const attachment: ChatAttachment = {
    type: "image",
    id: attachmentId,
    name: `screenshot-${input.itemKey}`.slice(0, 255),
    mimeType: input.image.mimeType,
    sizeBytes: input.image.bytes.length,
  };
  const ref = {
    attachmentId: attachment.id,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  } satisfies ToolResultImageRef;
  const finalPath = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
  if (!finalPath) return null;
  const createdAt = new Date().toISOString();

  const existing = yield* sql<{ readonly lifecycle: string }>`
    SELECT lifecycle FROM attachments WHERE attachment_id = ${attachment.id}
  `;
  if (existing.length > 0) {
    yield* sql`
      INSERT OR IGNORE INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
      VALUES (${attachment.id}, 'activity', ${input.activityId}, ${createdAt})
    `;
    return ref;
  }

  const stored = yield* sql<{ readonly count: number }>`
    SELECT COUNT(DISTINCT attachment.attachment_id) AS count
    FROM attachments AS attachment
    JOIN attachment_owners AS owner
      ON owner.attachment_id = attachment.attachment_id AND owner.owner_kind = 'activity'
    WHERE attachment.thread_id = ${input.threadId}
  `;
  if ((stored[0]?.count ?? 0) >= MAX_THREAD_TOOL_RESULT_IMAGES) return null;

  const stagingPath = path.join(
    input.attachmentsDir,
    ".staging",
    createHash("sha256").update(`activity:${input.activityId}`).digest("hex"),
    path.basename(finalPath),
  );
  const discardStaging = fileSystem
    .remove(path.dirname(stagingPath), { recursive: true, force: true })
    .pipe(Effect.ignore);
  yield* writeFileBytesAtomically({ filePath: stagingPath, contents: input.image.bytes }).pipe(
    Effect.tapError(() => discardStaging),
  );
  const registered = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO attachments (
            attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
            staging_path, final_path, lifecycle, created_at, updated_at
          ) VALUES (
            ${attachment.id}, ${input.threadId}, 'image', ${attachment.name},
            ${attachment.mimeType}, ${attachment.sizeBytes}, ${contentHash}, ${stagingPath},
            ${finalPath}, 'staged', ${createdAt}, ${createdAt}
          )
        `;
        yield* sql`
          INSERT INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
          VALUES (${attachment.id}, 'activity', ${input.activityId}, ${createdAt})
        `;
      }),
    )
    .pipe(
      Effect.as(true),
      Effect.catchCause(() => discardStaging.pipe(Effect.as(false))),
    );
  if (!registered) return null;
  // A failure past this point leaves a staged row that startup recovery promotes.
  yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
  yield* fileSystem.rename(stagingPath, finalPath);
  yield* sql`
    UPDATE attachments SET lifecycle = 'ready', staging_path = NULL,
      updated_at = ${new Date().toISOString()}
    WHERE attachment_id = ${attachment.id} AND lifecycle = 'staged'
  `;
  yield* discardStaging;
  return ref;
});
