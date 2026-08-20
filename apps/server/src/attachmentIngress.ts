import { createHash } from "node:crypto";
import path from "node:path";

import {
  type ChatAttachment,
  type CommandId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { Effect, FileSystem, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileBytesAtomically } from "./atomicWrite.ts";
import { createAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

export class AttachmentIngressError extends Schema.TaggedErrorClass<AttachmentIngressError>()(
  "AttachmentIngressError",
  {
    message: Schema.String,
  },
) {}

interface AttachmentIngressPaths {
  readonly attachment: ChatAttachment;
  readonly finalPath: string | null;
  readonly stagingPath: string | null;
}

interface PreparedAttachmentIngressEntry extends AttachmentIngressPaths {
  bytes: Buffer | undefined;
  readonly finalPath: string;
  readonly stagingPath: string;
  readonly contentHash: string;
}

export interface PreparedAttachmentIngress {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly commandId: CommandId;
  readonly entries: ReadonlyArray<PreparedAttachmentIngressEntry>;
  readonly threadId: ThreadId;
}

export const prepareAttachmentIngress = Effect.fnUntraced(function* (input: {
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly attachmentsDir: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}) {
  if (input.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return yield* new AttachmentIngressError({
      message: `A turn can include at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
    });
  }

  const stagingDirectory = path.join(
    input.attachmentsDir,
    ".staging",
    createHash("sha256").update(input.commandId).digest("hex"),
  );
  const entries = yield* Effect.forEach(
    input.attachments,
    (upload) =>
      Effect.gen(function* () {
        const parsed = parseBase64DataUrl(upload.dataUrl);
        if (!parsed || !parsed.mimeType.startsWith("image/")) {
          return yield* new AttachmentIngressError({
            message: `Invalid image attachment payload for '${upload.name}'.`,
          });
        }

        const bytes = Buffer.from(parsed.base64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return yield* new AttachmentIngressError({
            message: `Image attachment '${upload.name}' is empty or too large.`,
          });
        }

        const attachmentId = createAttachmentId(input.threadId);
        if (!attachmentId) {
          return yield* new AttachmentIngressError({
            message: "Failed to create a safe attachment id.",
          });
        }

        const attachment: ChatAttachment = {
          type: "image",
          id: attachmentId,
          name: upload.name,
          mimeType: parsed.mimeType.toLowerCase(),
          sizeBytes: bytes.byteLength,
        };
        const finalPath = resolveAttachmentPath({
          attachmentsDir: input.attachmentsDir,
          attachment,
        });
        if (!finalPath) {
          return yield* new AttachmentIngressError({
            message: `Failed to resolve persisted path for '${upload.name}'.`,
          });
        }

        return {
          attachment,
          bytes,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          finalPath,
          stagingPath: path.join(stagingDirectory, path.basename(finalPath)),
        } satisfies PreparedAttachmentIngressEntry;
      }),
    { concurrency: 1 },
  );

  return {
    attachments: entries.map((entry) => entry.attachment),
    commandId: input.commandId,
    entries,
    threadId: input.threadId,
  } satisfies PreparedAttachmentIngress;
});

const discardAttachmentEntries = Effect.fnUntraced(function* (input: {
  readonly commandId: CommandId;
  readonly entries: ReadonlyArray<AttachmentIngressPaths>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;

  yield* Effect.forEach(
    input.entries,
    (entry) =>
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM attachment_owners
          WHERE attachment_id = ${entry.attachment.id}
            AND owner_kind = 'ingress'
            AND owner_id = ${input.commandId}
        `.pipe(Effect.ignore);
        const owners = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM attachment_owners
          WHERE attachment_id = ${entry.attachment.id}
        `.pipe(Effect.catch(() => Effect.succeed([{ count: 0 }])));
        if ((owners[0]?.count ?? 0) > 0) return;

        yield* Effect.all(
          [entry.stagingPath, entry.finalPath].flatMap((filePath) =>
            filePath ? [fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)] : [],
          ),
          { discard: true },
        );
        yield* sql`
          DELETE FROM attachments
          WHERE attachment_id = ${entry.attachment.id}
            AND NOT EXISTS (
              SELECT 1 FROM attachment_owners
              WHERE attachment_id = ${entry.attachment.id}
            )
        `.pipe(Effect.ignore);
      }),
    { concurrency: 1, discard: true },
  );
});

export const discardPreparedAttachmentIngress = Effect.fnUntraced(function* (
  prepared: PreparedAttachmentIngress,
) {
  yield* discardAttachmentEntries({
    commandId: prepared.commandId,
    entries: prepared.entries,
  });
});

export const discardAttachmentIngress = Effect.fnUntraced(function* (input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir: string;
  readonly commandId: CommandId;
}) {
  const stagingDirectory = path.join(
    input.attachmentsDir,
    ".staging",
    createHash("sha256").update(input.commandId).digest("hex"),
  );
  const entries = input.attachments.map((attachment): AttachmentIngressPaths => {
    const finalPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    return {
      attachment,
      finalPath,
      stagingPath: finalPath ? path.join(stagingDirectory, path.basename(finalPath)) : null,
    };
  });
  yield* discardAttachmentEntries({
    commandId: input.commandId,
    entries,
  });
});

export const persistPreparedAttachmentIngress = Effect.fnUntraced(function* (
  prepared: PreparedAttachmentIngress,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const entriesWithBytes = yield* Effect.forEach(prepared.entries, (entry) => {
    const bytes = entry.bytes;
    return bytes
      ? Effect.succeed({ ...entry, bytes })
      : Effect.fail(
          new AttachmentIngressError({
            message: `Attachment '${entry.attachment.name}' has already been persisted.`,
          }),
        );
  });

  return yield* Effect.gen(function* () {
    yield* Effect.forEach(
      entriesWithBytes,
      (entry) =>
        writeFileBytesAtomically({ filePath: entry.stagingPath, contents: entry.bytes }).pipe(
          Effect.mapError(
            () =>
              new AttachmentIngressError({
                message: `Failed to persist attachment '${entry.attachment.name}'.`,
              }),
          ),
        ),
      { concurrency: 1, discard: true },
    );

    yield* sql
      .withTransaction(
        Effect.forEach(
          prepared.entries,
          (entry) => {
            const createdAt = new Date().toISOString();
            return Effect.gen(function* () {
              yield* sql`
                INSERT INTO attachments (
                  attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
                  staging_path, final_path, lifecycle, created_at, updated_at
                ) VALUES (
                  ${entry.attachment.id}, ${prepared.threadId}, ${entry.attachment.type},
                  ${entry.attachment.name}, ${entry.attachment.mimeType},
                  ${entry.attachment.sizeBytes}, ${entry.contentHash}, ${entry.stagingPath},
                  ${entry.finalPath}, 'staged', ${createdAt}, ${createdAt}
                )
              `;
              yield* sql`
                INSERT INTO attachment_owners (
                  attachment_id, owner_kind, owner_id, created_at
                ) VALUES (
                  ${entry.attachment.id}, 'ingress', ${prepared.commandId}, ${createdAt}
                )
              `;
            });
          },
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(
        Effect.mapError(
          () =>
            new AttachmentIngressError({
              message: `Failed to record attachment '${prepared.entries[0]?.attachment.name ?? "upload"}'.`,
            }),
        ),
      );

    yield* Effect.forEach(
      prepared.entries,
      (entry) =>
        Effect.gen(function* () {
          yield* fileSystem.rename(entry.stagingPath, entry.finalPath);
          yield* sql`
            UPDATE attachments SET lifecycle = 'ready', staging_path = NULL,
              updated_at = ${new Date().toISOString()}
            WHERE attachment_id = ${entry.attachment.id} AND lifecycle = 'staged'
          `;
        }).pipe(
          Effect.mapError(
            () =>
              new AttachmentIngressError({
                message: `Failed to persist attachment '${entry.attachment.name}'.`,
              }),
          ),
        ),
      { concurrency: 1, discard: true },
    );

    return prepared.attachments;
  }).pipe(
    Effect.tapError(() => discardPreparedAttachmentIngress(prepared)),
    Effect.ensuring(
      Effect.sync(() => {
        for (const entry of prepared.entries) {
          entry.bytes = undefined;
        }
      }),
    ),
  );
});
