import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { savedAttachmentFilename } from "@t3tools/shared/savedAttachmentPath";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import { MAX_THREAD_ACTIVITY_ATTACHMENT_BYTES } from "../activityAttachments.ts";
import { ensureAttachmentSchema } from "../persistence/Migrations/AttachmentSchema.ts";
import ownerKindsMigration from "../persistence/Migrations/095_AttachmentOwnerKinds.ts";
import activityOwnerMigration from "../persistence/Migrations/109_AttachmentOwnerActivity.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeThreadImagePublisher } from "./publishThreadImage";
import type { ThreadToolError } from "./threadMcpTools.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const markdownUrl = (markdown: string) => /\(<(file:[^>]+)>\)/u.exec(markdown)![1]!;
const storedPath = (markdown: string) => fileURLToPath(markdownUrl(markdown));

it("publishes temporary screenshots durably and rejects invalid inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-publish-image-"));
  try {
    // `scratch` plays the canonical temp directory (macOS /private/tmp) and `alias` the
    // symlinked spelling the server is configured with (/tmp).
    const scratch = path.join(root, "private-tmp");
    const alias = path.join(root, "tmp");
    await mkdir(path.join(scratch, "nested"), { recursive: true });
    await symlink(scratch, alias);
    const source = path.join(scratch, "capture.png");
    const attachmentsDir = path.join(scratch, "attachments");
    await mkdir(attachmentsDir);
    await writeFile(source, PNG);
    await writeFile(path.join(scratch, "other.png"), Buffer.concat([PNG, Buffer.from([0])]));
    await writeFile(path.join(attachmentsDir, "other-thread.png"), PNG);
    await writeFile(path.join(root, "outside.png"), PNG);
    await writeFile(path.join(scratch, "not-image.png"), "not an image");
    await symlink(source, path.join(scratch, "link.png"));
    await symlink(root, path.join(scratch, "escape"));
    await writeFile(path.join(scratch, "refused.png"), Buffer.concat([PNG, Buffer.from([1])]));
    // On POSIX `nested\capture.png` is one file name; it must not open `nested/capture.png`.
    const backslashName = path.join(scratch, "nested\\capture.png");
    if (path.sep === "/") {
      await writeFile(path.join(scratch, "nested", "capture.png"), PNG);
      await writeFile(backslashName, PNG);
    }
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activities: unknown[] = [];
    let dispatchFailure: { readonly _tag: string } | null = null;
    const engine = {
      getReadModel: () =>
        Effect.succeed({
          threads: [
            {
              id: threadId,
              projectId: "project",
              deletedAt: null,
              archivedAt: null,
              worktreePath: null,
              latestTurn: null,
            },
          ],
          projects: [
            { id: "project", kind: "standard", workspaceRoot: "/workspace", deletedAt: null },
          ],
        } as never),
      dispatch: (value: unknown) =>
        dispatchFailure
          ? Effect.fail(dispatchFailure as never)
          : Effect.sync(() => {
              activities.push(value);
              return { sequence: 1 } as never;
            }),
    };
    const failureMessage = <A, R>(effect: Effect.Effect<A, ThreadToolError, R>) =>
      Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => null });
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)");
        yield* sql.unsafe("INSERT INTO projection_threads VALUES ('thread-1')");
        yield* ensureAttachmentSchema;
        yield* ownerKindsMigration;
        yield* activityOwnerMigration;
        const options = { engine, attachmentsDir, temporaryDirectories: [alias] };
        const publish = yield* makeThreadImagePublisher(options);
        // Canonical spelling against a symlinked allowed root.
        const first = yield* publish(threadId, source);
        expect(first.markdown).toContain("file://");
        expect(first.markdown).not.toContain("capture.png");
        expect(first).not.toHaveProperty("path");
        // Symlinked spelling, and `..` segments that still resolve inside the root.
        const second = yield* publish(threadId, path.join(alias, "capture.png"));
        expect(second.attachmentId).toBe(first.attachmentId);
        const dotted = yield* publish(threadId, `${scratch}/nested/../capture.png`);
        expect(dotted.attachmentId).toBe(first.attachmentId);
        expect(yield* sql.unsafe("SELECT lifecycle FROM attachments")).toEqual([
          { lifecycle: "ready" },
        ]);
        expect(activities).toHaveLength(3);
        for (const invalid of [
          "/etc/hosts",
          "relative.png",
          path.join(root, "outside.png"),
          `${scratch}/../outside.png`,
          path.join(scratch, "escape", "outside.png"),
          path.join(scratch, "not-image.png"),
          path.join(scratch, "link.png"),
          path.join(attachmentsDir, "other-thread.png"),
          path.join(alias, "attachments", "other-thread.png"),
          ...(path.sep === "/" ? [backslashName] : []),
        ]) {
          expect((yield* Effect.exit(publish(threadId, invalid)))._tag).toBe("Failure");
        }
        // A refused command releases its attachment claim; a failure that may follow the
        // commit keeps it, so a stored activity never loses its image.
        const refused = path.join(scratch, "refused.png");
        const activityOwners = () =>
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM attachment_owners
            WHERE owner_kind = 'activity' AND attachment_id <> ${first.attachmentId}
          `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
        dispatchFailure = { _tag: "OrchestrationOverloadError" };
        expect((yield* Effect.exit(publish(threadId, refused)))._tag).toBe("Failure");
        expect(yield* activityOwners()).toBe(0);
        dispatchFailure = { _tag: "OrchestrationListenerCallbackError" };
        expect((yield* Effect.exit(publish(threadId, refused)))._tag).toBe("Failure");
        expect(yield* activityOwners()).toBe(1);
        dispatchFailure = null;
        expect(activities).toHaveLength(3);
        const reopened = yield* makeThreadImagePublisher(options);
        const imagePath = storedPath((yield* reopened(threadId, source)).markdown);
        expect(imagePath).toBe(storedPath(first.markdown));
        // The chat resolves this Markdown to the attachment capability with the same matcher,
        // applied to the URL's decoded `/`-separated pathname (also on Windows).
        const urlPath = decodeURIComponent(new URL(markdownUrl(first.markdown)).pathname);
        expect(savedAttachmentFilename(urlPath)).toBe(path.basename(imagePath));
        yield* Effect.promise(async () => {
          await rm(source);
          expect(await readFile(imagePath)).toEqual(PNG);
        });
        // A full per-thread budget rejects new images with an explicit message.
        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO attachments (attachment_id, thread_id, type, name, mime_type, size_bytes,
            content_hash, staging_path, final_path, lifecycle, created_at, updated_at)
          VALUES ('budget', 'thread-1', 'image', 'budget.png', 'image/png',
            ${MAX_THREAD_ACTIVITY_ATTACHMENT_BYTES}, 'hash', NULL, '/unused', 'ready', ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO attachment_owners VALUES ('budget', 'activity', 'budget-owner', ${now})
        `;
        expect(yield* failureMessage(publish(threadId, path.join(scratch, "other.png")))).toBe(
          "The conversation attachment budget is full.",
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory()))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
