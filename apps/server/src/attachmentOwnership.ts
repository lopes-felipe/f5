import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";

export type AttachmentOwnerKind =
  | "ingress"
  | "queue_item"
  | "message"
  | "user_input"
  | "rewind_draft"
  | "activity";
/** The INSERT and lifecycle predicate share a statement; the trigger covers all other writers. */
export const acquireAttachmentOwner = (
  sql: SqlClient.SqlClient,
  attachmentId: string,
  kind: AttachmentOwnerKind,
  ownerId: string,
  at: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ attachmentId: string }>`
    INSERT INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
    SELECT attachment_id, ${kind}, ${ownerId}, ${at} FROM attachments
    WHERE attachment_id = ${attachmentId} AND lifecycle <> 'deleting'
    ON CONFLICT(attachment_id, owner_kind, owner_id) DO UPDATE SET created_at = attachment_owners.created_at
    RETURNING attachment_id AS "attachmentId"
  `;
    return rows.length > 0;
  });
export const requireAttachmentOwner = (
  sql: SqlClient.SqlClient,
  attachmentId: string,
  kind: AttachmentOwnerKind,
  ownerId: string,
  at: string,
) =>
  Effect.gen(function* () {
    if (!(yield* acquireAttachmentOwner(sql, attachmentId, kind, ownerId, at)))
      return yield* new SqlError({
        message: "Attachment is unavailable: missing or deletion in progress",
        cause: new Error("attachment_unavailable"),
      });
  });
