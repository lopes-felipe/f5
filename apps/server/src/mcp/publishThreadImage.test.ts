import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import { ensureAttachmentSchema } from "../persistence/Migrations/AttachmentSchema.ts";
import ownerKindsMigration from "../persistence/Migrations/095_AttachmentOwnerKinds.ts";
import activityOwnerMigration from "../persistence/Migrations/109_AttachmentOwnerActivity.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeThreadImagePublisher } from "./publishThreadImage";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

it("publishes temporary screenshots durably and rejects invalid inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-publish-image-"));
  try {
    const source = path.join(root, "capture.png");
    const attachmentsDir = path.join(root, "attachments");
    await mkdir(attachmentsDir);
    await writeFile(source, PNG);
    await writeFile(path.join(root, "not-image.png"), "not an image");
    await symlink(source, path.join(root, "link.png"));
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activities: unknown[] = [];
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
        Effect.sync(() => {
          activities.push(value);
          return { sequence: 1 } as never;
        }),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)");
        yield* sql.unsafe("INSERT INTO projection_threads VALUES ('thread-1')");
        yield* ensureAttachmentSchema;
        yield* ownerKindsMigration;
        yield* activityOwnerMigration;
        const publish = yield* makeThreadImagePublisher({ engine, attachmentsDir });
        const first = yield* publish(threadId, source);
        expect(first.markdown).toContain("file://");
        expect(first.markdown).not.toContain("capture.png");
        const second = yield* publish(threadId, source);
        expect(second.attachmentId).toBe(first.attachmentId);
        expect(yield* sql.unsafe("SELECT lifecycle FROM attachments")).toEqual([
          { lifecycle: "ready" },
        ]);
        expect(activities).toHaveLength(2);
        for (const invalid of [
          "/etc/hosts",
          "relative.png",
          path.join(root, "not-image.png"),
          path.join(root, "link.png"),
        ]) {
          expect((yield* Effect.exit(publish(threadId, invalid)))._tag).toBe("Failure");
        }
        const reopened = yield* makeThreadImagePublisher({ engine, attachmentsDir });
        expect((yield* reopened(threadId, source)).path).toBe(first.path);
        yield* Effect.promise(async () => {
          await rm(source);
          expect(await readFile(first.path)).toEqual(PNG);
        });
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory()))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
