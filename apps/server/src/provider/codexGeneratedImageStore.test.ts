import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import { ServerConfig } from "../config";
import { ensureAttachmentSchema } from "../persistence/Migrations/AttachmentSchema";
import ownerKinds from "../persistence/Migrations/095_AttachmentOwnerKinds";
import activityOwner from "../persistence/Migrations/109_AttachmentOwnerActivity";
import * as SqliteClient from "../persistence/NodeSqliteClient";
import { makeCodexGeneratedImageStore } from "./codexGeneratedImageStore";

it("imports a real CODEX_HOME image outside the workspace into a served, owned attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-generated-image-"));
  try {
    const source = join(root, ".codex", "generated_images", "output.png");
    await mkdir(join(root, ".codex", "generated_images"), { recursive: true });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(source, bytes);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig;
        yield* sql.unsafe("CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)");
        yield* sql.unsafe("INSERT INTO projection_threads VALUES ('thread-1')");
        yield* ensureAttachmentSchema;
        yield* ownerKinds;
        yield* activityOwner;
        const store = yield* makeCodexGeneratedImageStore;
        const event: ProviderEvent = {
          id: EventId.makeUnsafe("image-event"),
          provider: "codex",
          kind: "notification",
          threadId: ThreadId.make("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/completed",
          payload: {
            item: { type: "imageGeneration", id: "image", status: "completed", savedPath: source },
          },
        };
        const result = yield* store(event);
        const saved = (result.payload as { item: { f5ImagePath: string } }).item.f5ImagePath;
        expect(saved.startsWith(config.attachmentsDir)).toBe(true);
        expect(saved).toMatch(/thread-1-[0-9a-f-]{36}\.png$/);
        expect(yield* Effect.promise(() => readFile(saved))).toEqual(bytes);
        expect(
          (yield* sql.unsafe<{ lifecycle: string }>("SELECT lifecycle FROM attachments"))[0]
            ?.lifecycle,
        ).toBe("ready");
        expect(
          (yield* sql.unsafe<{ owner_kind: string }>("SELECT owner_kind FROM attachment_owners"))[0]
            ?.owner_kind,
        ).toBe("activity");
        yield* Effect.promise(() => writeFile(source, "not an image"));
        const invalid = yield* store({ ...event, id: EventId.makeUnsafe("invalid") });
        expect((invalid.payload as { item: { f5ImagePath: unknown } }).item.f5ImagePath).toBeNull();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            SqliteClient.layerMemory(),
            ServerConfig.layerTest(root, { prefix: "generated-image-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
