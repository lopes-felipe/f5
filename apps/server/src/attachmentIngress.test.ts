import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ChatAttachment,
  CommandId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import * as SqliteClient from "./persistence/NodeSqliteClient.ts";
import { ensureAttachmentSchema } from "./persistence/Migrations/AttachmentSchema.ts";
import {
  discardAttachmentIngress,
  persistPreparedAttachmentIngress,
  prepareAttachmentIngress,
} from "./attachmentIngress.ts";

const tempDirectories: string[] = [];
const testLayer = Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory());

const makeTempAttachmentsDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-attachment-ingress-"));
  tempDirectories.push(directory);
  return path.join(directory, "attachments");
};

const validUpload = (overrides: Partial<UploadChatAttachment> = {}): UploadChatAttachment => ({
  type: "image",
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 5,
  dataUrl: "data:image/png;base64,aGVsbG8=",
  ...overrides,
});

const prepare = (attachments: ReadonlyArray<UploadChatAttachment>, attachmentsDir: string) =>
  prepareAttachmentIngress({
    attachments,
    attachmentsDir,
    commandId: CommandId.makeUnsafe(`command-${crypto.randomUUID()}`),
    threadId: ThreadId.makeUnsafe("thread-1"),
  });

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("attachment ingress", () => {
  it("rejects too many uploads", async () => {
    await expect(
      Effect.runPromise(
        prepare(
          Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => validUpload()),
          makeTempAttachmentsDir(),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AttachmentIngressError",
      message: expect.stringContaining("at most"),
    });
  });

  it("rejects a non-image data URL", async () => {
    await expect(
      Effect.runPromise(
        prepare(
          [validUpload({ dataUrl: "data:text/plain;base64,aGVsbG8=" })],
          makeTempAttachmentsDir(),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AttachmentIngressError",
      message: expect.stringContaining("Invalid image attachment payload"),
    });
  });

  it("rejects an empty image payload", async () => {
    await expect(
      Effect.runPromise(
        prepare(
          [validUpload({ sizeBytes: 0, dataUrl: "data:image/png;base64," })],
          makeTempAttachmentsDir(),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AttachmentIngressError",
      message: expect.stringMatching(/Invalid image attachment payload|empty or too large/),
    });
  });

  it("rejects an oversized decoded image payload", async () => {
    const bytes = Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
    await expect(
      Effect.runPromise(
        prepare(
          [
            validUpload({
              sizeBytes: bytes.byteLength,
              dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
            }),
          ],
          makeTempAttachmentsDir(),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AttachmentIngressError",
      message: expect.stringContaining("empty or too large"),
    });
  });

  it("enforces the thread foreign key and persists after the parent exists", async () => {
    const attachmentsDir = makeTempAttachmentsDir();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
        yield* ensureAttachmentSchema;

        const beforeParent = yield* prepare([validUpload()], attachmentsDir);
        const failure = yield* Effect.flip(persistPreparedAttachmentIngress(beforeParent));
        expect(failure).toMatchObject({ _tag: "AttachmentIngressError" });
        expect(
          (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM attachments`)[0],
        ).toEqual({ count: 0 });

        yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;
        const afterParent = yield* prepare([validUpload()], attachmentsDir);
        const attachments = yield* persistPreparedAttachmentIngress(afterParent);
        const attachment = attachments[0];
        expect(attachment).toBeDefined();
        if (!attachment) return;

        expect(
          (yield* sql<{ readonly lifecycle: string }>`
              SELECT lifecycle FROM attachments WHERE attachment_id = ${attachment.id}
            `)[0],
        ).toEqual({ lifecycle: "ready" });
        expect(
          (yield* sql<{ readonly ownerKind: string; readonly ownerId: string }>`
              SELECT owner_kind AS ownerKind, owner_id AS ownerId
              FROM attachment_owners WHERE attachment_id = ${attachment.id}
            `)[0],
        ).toEqual({ ownerKind: "ingress", ownerId: afterParent.commandId });
        expect(fs.existsSync(path.join(attachmentsDir, `${attachment.id}.png`))).toBe(true);
      }).pipe(Effect.provide(testLayer)),
    );
  });

  it("removes registry rows even when the attachment path is invalid", async () => {
    const attachmentsDir = makeTempAttachmentsDir();
    const commandId = CommandId.makeUnsafe("command-invalid-path");
    const attachment = {
      type: "image",
      id: "../invalid",
      name: "invalid.png",
      mimeType: "image/png",
      sizeBytes: 5,
    } as unknown as ChatAttachment;

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
        yield* ensureAttachmentSchema;
        yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;
        const createdAt = new Date().toISOString();
        yield* sql`
          INSERT INTO attachments (
            attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
            staging_path, final_path, lifecycle, created_at, updated_at
          ) VALUES (
            ${attachment.id}, 'thread-1', 'image', ${attachment.name}, ${attachment.mimeType},
            ${attachment.sizeBytes}, 'hash', NULL, '/not/a/resolvable/path', 'ready',
            ${createdAt}, ${createdAt}
          )
        `;
        yield* sql`
          INSERT INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
          VALUES (${attachment.id}, 'ingress', ${commandId}, ${createdAt})
        `;

        yield* discardAttachmentIngress({ attachments: [attachment], attachmentsDir, commandId });

        expect(
          (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM attachments`)[0],
        ).toEqual({ count: 0 });
        expect(
          (yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM attachment_owners`)[0],
        ).toEqual({ count: 0 });
      }).pipe(Effect.provide(testLayer)),
    );
  });
});
