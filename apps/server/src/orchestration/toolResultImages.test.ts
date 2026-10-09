import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ensureAttachmentSchema } from "../persistence/Migrations/AttachmentSchema.ts";
import ownerKindsMigration from "../persistence/Migrations/095_AttachmentOwnerKinds.ts";
import activityOwnerMigration from "../persistence/Migrations/109_AttachmentOwnerActivity.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { scrubInlineImagesReplacer } from "../provider/Layers/EventNdjsonLogger.ts";
import {
  MAX_THREAD_TOOL_RESULT_IMAGES,
  MAX_THREAD_TOOL_RESULT_IMAGE_BYTES,
  MAX_TOOL_RESULT_IMAGES,
  extractToolResultImages,
  ingestToolResultImage,
} from "./toolResultImages.ts";

type NodeServicesR = Layer.Success<typeof NodeServices.layer>;

/** Files left under the staging area; empty directories are removed by startup recovery. */
function stagedEntries(attachmentsDir: string): string[] {
  const staging = path.join(attachmentsDir, ".staging");
  if (!fs.existsSync(staging)) return [];
  return fs
    .readdirSync(staging, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("extractToolResultImages", () => {
  it("extracts Claude and MCP image blocks and removes their base64", () => {
    const result = {
      result: {
        type: "tool_result",
        content: [
          { type: "text", text: "snapshot" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      },
      mcp: [{ type: "image", mimeType: "image/jpeg", data: PNG_BASE64 }],
    };
    const extraction = extractToolResultImages(result);
    // One screenshot per tool item; the second block is counted as omitted.
    expect(extraction.images.map((image) => image.mimeType)).toEqual(["image/png"]);
    expect(extraction.omitted).toBe(1);
    expect(JSON.stringify(extraction.scrubbed)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(extraction.scrubbed)).toContain('"text":"snapshot"');
  });

  it("counts images past the limit, unsupported formats, and corrupt data as omitted", () => {
    const blocks = [
      ...Array.from({ length: MAX_TOOL_RESULT_IMAGES + 1 }, () => ({
        type: "image",
        mimeType: "image/png",
        data: PNG_BASE64,
      })),
      { type: "image", mimeType: "image/svg+xml", data: PNG_BASE64 },
      { type: "image", mimeType: "image/png", data: "not base64!" },
    ];
    const extraction = extractToolResultImages({ content: blocks });
    expect(extraction.images).toHaveLength(MAX_TOOL_RESULT_IMAGES);
    expect(extraction.omitted).toBe(3);
    expect(JSON.stringify(extraction.scrubbed)).not.toContain(PNG_BASE64);
  });

  it("returns the original value when there are no images", () => {
    const value = { result: { content: [{ type: "text", text: "ok" }] } };
    const extraction = extractToolResultImages(value);
    expect(extraction.scrubbed).toBe(value);
    expect(extraction.images).toEqual([]);
  });

  it("keeps base64 out of provider event logs", () => {
    const serialized = JSON.stringify(
      {
        raw: {
          content: [{ type: "image", source: { media_type: "image/png", data: PNG_BASE64 } }],
        },
      },
      scrubInlineImagesReplacer,
    );
    expect(serialized).not.toContain(PNG_BASE64);
    expect(serialized).toContain('"omitted":true');
  });
});

describe("ingestToolResultImage", () => {
  const [image] = extractToolResultImages({
    type: "image",
    mimeType: "image/png",
    data: PNG_BASE64,
  }).images;

  function run<A, E>(
    body: (attachmentsDir: string) => Effect.Effect<A, E, SqlClient.SqlClient | NodeServicesR>,
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-tool-images-"));
    tempDirectories.push(root);
    const attachmentsDir = path.join(root, "attachments");
    return Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT INTO projection_threads VALUES ('thread-1')`;
        yield* ensureAttachmentSchema;
        yield* ownerKindsMigration;
        yield* activityOwnerMigration;
        return { attachmentsDir, value: yield* body(attachmentsDir) };
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory()))),
    );
  }

  it("stores the image as a served attachment owned by its activity", async () => {
    const result = await run((attachmentsDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ref = yield* ingestToolResultImage({
          attachmentsDir,
          threadId: "thread-1",
          itemKey: "item-1",
          activityId: "activity-1",
          image: image!,
        });
        const owners = yield* sql<{ ownerKind: string; ownerId: string }>`
          SELECT owner_kind AS "ownerKind", owner_id AS "ownerId" FROM attachment_owners
        `;
        const rows = yield* sql<{ lifecycle: string; stagingPath: string | null }>`
          SELECT lifecycle, staging_path AS "stagingPath" FROM attachments
        `;
        return { ref, owners, rows };
      }),
    );
    const { ref, owners, rows } = result.value;
    expect(ref).toMatchObject({ mimeType: "image/png", sizeBytes: image!.bytes.length });
    expect(owners).toEqual([{ ownerKind: "activity", ownerId: "activity-1" }]);
    expect(rows).toEqual([{ lifecycle: "ready", stagingPath: null }]);
    const servedPath = resolveAttachmentPathById({
      attachmentsDir: result.attachmentsDir,
      attachmentId: ref!.attachmentId,
    });
    expect(servedPath && fs.readFileSync(servedPath).equals(Buffer.from(image!.bytes))).toBe(true);
    expect(stagedEntries(result.attachmentsDir)).toEqual([]);
  });

  it("reuses the attachment when the same item is replayed or updated", async () => {
    const result = await run((attachmentsDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ingest = (activityId: string) =>
          ingestToolResultImage({
            attachmentsDir,
            threadId: "thread-1",
            itemKey: "item-1",
            activityId,
            image: image!,
          });
        const first = yield* ingest("evt-updated");
        const replay = yield* ingest("evt-updated");
        const completed = yield* ingest("evt-completed");
        const attachments = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM attachments`;
        const owners = yield* sql<{ ownerId: string }>`
          SELECT owner_id AS "ownerId" FROM attachment_owners ORDER BY owner_id
        `;
        return { first, replay, completed, attachments, owners };
      }),
    );
    const { first, replay, completed, attachments, owners } = result.value;
    expect(replay?.attachmentId).toBe(first?.attachmentId);
    expect(completed?.attachmentId).toBe(first?.attachmentId);
    expect(attachments[0]?.count).toBe(1);
    expect(owners.map((owner) => owner.ownerId)).toEqual(["evt-completed", "evt-updated"]);
  });

  it("finishes an interrupted promotion when the item is replayed", async () => {
    const result = await run((attachmentsDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ingest = () =>
          ingestToolResultImage({
            attachmentsDir,
            threadId: "thread-1",
            itemKey: "item-1",
            activityId: "activity-1",
            image: image!,
          });
        const first = yield* ingest();
        // Simulate a promotion that failed after registration: row staged, no final file.
        const finalPath = resolveAttachmentPathById({
          attachmentsDir,
          attachmentId: first!.attachmentId,
        })!;
        fs.rmSync(finalPath);
        yield* sql`UPDATE attachments SET lifecycle = 'staged', staging_path = '/tmp/gone/x.png'`;
        const replay = yield* ingest();
        const rows = yield* sql<{ lifecycle: string; stagingPath: string | null }>`
          SELECT lifecycle, staging_path AS "stagingPath" FROM attachments
        `;
        return { first, replay, rows, finalPath };
      }),
    );
    const { first, replay, rows, finalPath } = result.value;
    expect(replay?.attachmentId).toBe(first?.attachmentId);
    expect(rows).toEqual([{ lifecycle: "ready", stagingPath: null }]);
    expect(fs.readFileSync(finalPath).equals(Buffer.from(image!.bytes))).toBe(true);
  });

  it("drops images past the per-thread cap", async () => {
    const result = await run((attachmentsDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        for (let index = 0; index < MAX_THREAD_TOOL_RESULT_IMAGES; index += 1) {
          const id = `thread-1-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
          yield* sql`
            INSERT INTO attachments (attachment_id, thread_id, type, name, mime_type, size_bytes,
              content_hash, staging_path, final_path, lifecycle, created_at, updated_at)
            VALUES (${id}, 'thread-1', 'image', 'x', 'image/png', 1, 'h', NULL, ${`/tmp/${id}`},
              'ready', ${now}, ${now})
          `;
          yield* sql`
            INSERT INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
            VALUES (${id}, 'activity', ${`activity-${index}`}, ${now})
          `;
        }
        return yield* ingestToolResultImage({
          attachmentsDir,
          threadId: "thread-1",
          itemKey: "item-over-cap",
          activityId: "activity-over-cap",
          image: image!,
        });
      }),
    );
    expect(result.value).toBeNull();
    expect(stagedEntries(result.attachmentsDir)).toEqual([]);
  });
  it("counts unique attachment bytes and atomically enforces the shared budget", async () => {
    const result = await run((attachmentsDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const id = "thread-1-00000000-0000-4000-8000-000000000001";
        yield* sql`INSERT INTO attachments (attachment_id, thread_id, type, name, mime_type, size_bytes,
        content_hash, staging_path, final_path, lifecycle, created_at, updated_at)
        VALUES (${id}, 'thread-1', 'image', 'existing', 'image/png', ${MAX_THREAD_TOOL_RESULT_IMAGE_BYTES - image!.bytes.length}, 'hash', NULL, '/tmp/existing', 'ready', ${now}, ${now})`;
        for (const owner of ["started", "completed"])
          yield* sql`INSERT INTO attachment_owners
        (attachment_id, owner_kind, owner_id, created_at) VALUES (${id}, 'activity', ${owner}, ${now})`;
        const refs = yield* Effect.all(
          ["a", "b"].map((key) =>
            ingestToolResultImage({
              attachmentsDir,
              threadId: "thread-1",
              itemKey: key,
              activityId: key,
              image: image!,
            }),
          ),
          { concurrency: "unbounded" },
        );
        const rows = yield* sql<{
          bytes: number;
        }>`SELECT SUM(size_bytes) AS bytes FROM attachments`;
        return { refs, bytes: rows[0]?.bytes };
      }),
    );
    expect(result.value.refs.filter(Boolean)).toHaveLength(1);
    expect(result.value.bytes).toBe(MAX_THREAD_TOOL_RESULT_IMAGE_BYTES);
    expect(stagedEntries(result.attachmentsDir)).toEqual([]);
  });

  it("discards the staged file when registration fails", async () => {
    const result = await run((attachmentsDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Without the 'activity' owner kind the owner insert violates its CHECK constraint.
        yield* sql`DROP TABLE attachment_owners`;
        yield* sql`CREATE TABLE attachment_owners (
          attachment_id TEXT NOT NULL, owner_kind TEXT NOT NULL CHECK (owner_kind IN ('message')),
          owner_id TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (attachment_id, owner_kind, owner_id))`;
        const ref = yield* ingestToolResultImage({
          attachmentsDir,
          threadId: "thread-1",
          itemKey: "item-1",
          activityId: "activity-1",
          image: image!,
        });
        const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM attachments`;
        return { ref, count: rows[0]?.count };
      }),
    );
    expect(result.value).toEqual({ ref: null, count: 0 });
    const leftovers = fs.existsSync(result.attachmentsDir)
      ? fs.readdirSync(result.attachmentsDir, { recursive: true })
      : [];
    expect(leftovers.filter((entry) => String(entry).endsWith(".png"))).toEqual([]);
  });
});
