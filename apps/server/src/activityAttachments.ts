import { acquireAttachmentOwner, requireAttachmentOwner } from "./attachmentOwnership.ts";
import { createHash } from "node:crypto";
import type { ChatAttachment } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { writeFileBytesAtomically } from "./atomicWrite.ts";
import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "./attachmentStore.ts";

/** Shared budget for generated pages, app resources and tool screenshots. */
export const MAX_THREAD_ACTIVITY_ATTACHMENTS = 200;
export const MAX_THREAD_ACTIVITY_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export interface ActivityAttachmentRef {
  readonly attachmentId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/**
 * Attachment ids derive from the thread, tool item and content, so replayed or repeated
 * lifecycle events resolve to the same attachment instead of writing duplicates.
 */
export function activityAttachmentId(input: {
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
 * Stores one generated attachment in the attachment registry, owned by its activity, so it
 * is served like chat images and reclaimed with the thread. Bytes are staged and the row
 * is registered before the file is promoted, matching chat attachment ingress, so startup
 * recovery finishes or discards an interrupted write. Returns null when the attachment is
 * dropped (thread cap reached or registration failed).
 */
export const ingestActivityAttachment = Effect.fnUntraced(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  /** Provider tool item id (or event id); stable across the item's lifecycle events. */
  readonly itemKey: string;
  readonly activityId: string;
  readonly file: {
    readonly type: "image" | "file";
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  };
}) {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contentHash = createHash("sha256").update(input.file.bytes).digest("hex");
  const attachmentId = activityAttachmentId({
    threadId: input.threadId,
    itemKey: input.itemKey,
    contentHash,
  });
  if (!attachmentId) return null;
  const attachment: ChatAttachment = {
    type: input.file.type,
    id: attachmentId,
    name: input.file.name.slice(0, 255),
    mimeType: input.file.mimeType,
    sizeBytes: input.file.bytes.length,
  };
  const ref = {
    attachmentId: attachment.id,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  } satisfies ActivityAttachmentRef;
  const finalPath = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
  if (!finalPath) return null;
  const createdAt = new Date().toISOString();

  const markReady = sql`
    UPDATE attachments SET lifecycle = 'ready', staging_path = NULL,
      updated_at = ${new Date().toISOString()}
    WHERE attachment_id = ${attachment.id} AND lifecycle = 'staged'
  `;
  const existing = yield* sql<{ readonly lifecycle: string; readonly stagingPath: string | null }>`
    SELECT lifecycle, staging_path AS "stagingPath" FROM attachments
    WHERE attachment_id = ${attachment.id}
  `;
  const existingRow = existing[0];
  if (existingRow?.lifecycle === "deleting") return null;
  if (existingRow) {
    if (
      !(yield* acquireAttachmentOwner(sql, attachment.id, "activity", input.activityId, createdAt))
    )
      return null;
    if (existingRow.lifecycle === "staged") {
      // An earlier promotion failed. The id is content-addressed, so these bytes are the
      // staged ones: finish promotion now instead of returning a ref to a missing file.
      yield* writeFileBytesAtomically({ filePath: finalPath, contents: input.file.bytes });
      yield* markReady;
      if (existingRow.stagingPath) {
        yield* fileSystem
          .remove(path.dirname(existingRow.stagingPath), { recursive: true, force: true })
          .pipe(Effect.ignore);
      }
    }
    return ref;
  }

  const stored = yield* sql<{ readonly count: number; readonly bytes: number }>`
    SELECT COUNT(*) AS count, COALESCE(SUM(attachment.size_bytes), 0) AS bytes
    FROM attachments AS attachment
    WHERE attachment.thread_id = ${input.threadId}
      AND EXISTS (SELECT 1 FROM attachment_owners AS owner
        WHERE owner.attachment_id = attachment.attachment_id AND owner.owner_kind = 'activity')
  `;
  if (
    (stored[0]?.count ?? 0) >= MAX_THREAD_ACTIVITY_ATTACHMENTS ||
    (stored[0]?.bytes ?? 0) + input.file.bytes.length > MAX_THREAD_ACTIVITY_ATTACHMENT_BYTES
  )
    return null;

  const stagingPath = path.join(
    input.attachmentsDir,
    ".staging",
    createHash("sha256").update(`activity:${input.activityId}`).digest("hex"),
    path.basename(finalPath),
  );
  const discardStaging = fileSystem
    .remove(path.dirname(stagingPath), { recursive: true, force: true })
    .pipe(Effect.ignore);
  yield* writeFileBytesAtomically({ filePath: stagingPath, contents: input.file.bytes }).pipe(
    Effect.tapError(() => discardStaging),
  );
  const registered = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        // Recheck inside the write transaction: concurrent tool completions share this budget.
        const budget = yield* sql<{ readonly count: number; readonly bytes: number }>`
          SELECT COUNT(*) AS count, COALESCE(SUM(attachment.size_bytes), 0) AS bytes
          FROM attachments AS attachment WHERE attachment.thread_id = ${input.threadId}
          AND EXISTS (SELECT 1 FROM attachment_owners AS owner
            WHERE owner.attachment_id = attachment.attachment_id AND owner.owner_kind = 'activity')
        `;
        if (
          (budget[0]?.count ?? 0) >= MAX_THREAD_ACTIVITY_ATTACHMENTS ||
          (budget[0]?.bytes ?? 0) + input.file.bytes.length > MAX_THREAD_ACTIVITY_ATTACHMENT_BYTES
        )
          return false;
        yield* sql`
          INSERT INTO attachments (
            attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
            staging_path, final_path, lifecycle, created_at, updated_at
          ) VALUES (
            ${attachment.id}, ${input.threadId}, ${attachment.type}, ${attachment.name},
            ${attachment.mimeType}, ${attachment.sizeBytes}, ${contentHash}, ${stagingPath},
            ${finalPath}, 'staged', ${createdAt}, ${createdAt}
          )
        `;
        yield* requireAttachmentOwner(sql, attachment.id, "activity", input.activityId, createdAt);
        return true;
      }),
    )
    .pipe(Effect.catchCause(() => discardStaging.pipe(Effect.as(false))));
  if (!registered) {
    yield* discardStaging;
    return null;
  }
  // A failure past this point leaves a staged row; a replay or startup recovery promotes it.
  yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
  yield* fileSystem.rename(stagingPath, finalPath);
  yield* markReady;
  yield* discardStaging;
  return ref;
});
