import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it } from "vitest";
import * as SqliteClient from "./persistence/NodeSqliteClient";
import migration from "./persistence/Migrations/093_AttachmentUploads";
import { makeAttachmentUploads, sanitizeUploadName, sniffUploadImage } from "./attachmentUploads";
import { ensureAttachmentSchema } from "./persistence/Migrations/AttachmentSchema";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const threadId = ThreadId.makeUnsafe("draft-one");
function request(data: Buffer, name = "file.pdf", mime = "application/pdf") {
  return Object.assign(Readable.from([data]), {
    headers: {
      "content-length": String(data.length),
      "content-type": mime,
      "x-f5-file-name": encodeURIComponent(name),
    },
  });
}
async function run<A, E>(
  test: (
    store: Effect.Success<ReturnType<typeof makeAttachmentUploads>>,
    dir: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "f5-upload-test-"));
  dirs.push(dir);
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY)`;
      yield* ensureAttachmentSchema;
      yield* migration;
      return yield* test(yield* makeAttachmentUploads(dir), dir);
    }).pipe(Effect.provide(SqliteClient.layerMemory())),
  );
}
it("sniffs image content and sanitizes UTF-8 filenames", () => {
  expect(sanitizeUploadName(encodeURIComponent("héllo/\\\u0000世界.pdf"))).toBe("héllo世界.pdf");
  expect(sniffUploadImage(Buffer.from("not an image"))).toBeNull();
  expect(sniffUploadImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
});
it("keeps accepted names and MIME types within the attachment schema limits", async () => {
  // 200 emoji are 200 code points but 400 UTF-16 units; the schema counts the latter.
  const emojiName = sanitizeUploadName(encodeURIComponent(`${"😀".repeat(200)}.txt`));
  expect(emojiName.length).toBeLessThanOrEqual(255);
  expect(emojiName).toBe("😀".repeat(127));
  expect(sanitizeUploadName(encodeURIComponent(`${"a".repeat(254)}😀`))).toBe("a".repeat(254));
  await run((store) =>
    Effect.gen(function* () {
      const longMime = `application/${"x".repeat(120)}`;
      const result = yield* store.upload({
        req: request(Buffer.from("data"), "data.bin", longMime),
        threadId,
        clientId: "client",
      });
      expect(result.mimeType).toBe("application/octet-stream");
    }),
  );
});
it("finalizes, renews and expires uploads", async () => {
  await run((store) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* store.upload({
        req: request(Buffer.from("%PDF-test"), "世界.pdf"),
        threadId,
        clientId: "client",
      });
      expect(result.kind).toBe("file");
      expect(result.name).toBe("世界.pdf");
      const renewed = yield* store.getUploads(threadId, [result.uploadId]);
      expect(Date.parse(renewed[0]!.expiresAt) - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
      yield* store.releaseUploads(threadId, [result.uploadId]);
      yield* store.sweep;
      expect(yield* sql`SELECT * FROM attachment_uploads`).toEqual([]);
    }),
  );
});
it("copies one upload independently and retains concurrent claims during cleanup", async () => {
  await run((store, dir) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* store.upload({
        req: request(Buffer.from("original")),
        threadId,
        clientId: "client",
      });
      const copies = ["a", "b", "c"].map((name) => path.join(dir, name, "copy"));
      for (const dest of copies) yield* store.claim(result.uploadId, dest);
      yield* Effect.promise(() => writeFile(copies[0]!, "modified"));
      expect(yield* Effect.promise(() => readFile(copies[1]!, "utf8"))).toBe("original");
      expect(yield* Effect.promise(() => readFile(copies[2]!, "utf8"))).toBe("original");
      yield* store.releaseUploads(threadId, [result.uploadId]);
      yield* store.finishClaim(result.uploadId, copies[0]!);
      yield* store.sweep;
      expect((yield* sql`SELECT * FROM attachment_uploads`).length).toBe(1);
      yield* store.finishClaim(result.uploadId, copies[1]!);
      yield* store.finishClaim(result.uploadId, copies[2]!);
      yield* store.sweep;
      expect(yield* sql`SELECT * FROM attachment_uploads`).toEqual([]);
    }),
  );
});
it("rejects released uploads before claiming", async () => {
  await run((store, dir) =>
    Effect.gen(function* () {
      const result = yield* store.upload({
        req: request(Buffer.from("file")),
        threadId,
        clientId: "client",
      });
      yield* store.releaseUploads(threadId, [result.uploadId]);
      expect(
        (yield* Effect.exit(store.claim(result.uploadId, path.join(dir, "unused"))))._tag,
      ).toBe("Failure");
    }),
  );
});

it("reserves quota transactionally before consuming competing request bodies", async () => {
  await run((store, dir) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO attachment_uploads(upload_id,draft_thread_id,kind,name,mime_type,size_bytes,content_hash,path,created_at,expires_at) VALUES('quota-reservation',${threadId},'file','held','application/octet-stream',${1024 * 1024 * 1024 - 1},'',${path.join(dir, "reserved")},'2026-01-01','2099-01-01')`;
      const outcomes = yield* Effect.all(
        ["a", "b"].map((clientId) =>
          Effect.exit(store.upload({ req: request(Buffer.from("x")), threadId, clientId })),
        ),
        { concurrency: 2 },
      );
      expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(outcomes.filter((result) => result._tag === "Failure")).toHaveLength(1);
      const total = yield* sql<{
        total: number;
      }>`SELECT SUM(size_bytes) AS total FROM attachment_uploads`;
      expect(total[0]?.total).toBe(1024 * 1024 * 1024);
    }),
  );
});

it("rejects excess client and server uploads without reading their bodies", async () => {
  await run((store) =>
    Effect.promise(async () => {
      const releases: Array<() => void> = [];
      const started: Promise<void>[] = [];
      const jobs = ["same", "same", "other", "third"].map((clientId) => {
        let signalStarted!: () => void;
        started.push(
          new Promise<void>((resolve) => {
            signalStarted = resolve;
          }),
        );
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        releases.push(release);
        const req = {
          headers: { "content-length": "1", "x-f5-file-name": "held.txt" },
          async *[Symbol.asyncIterator]() {
            signalStarted();
            await wait;
            yield Buffer.from("x");
          },
        };
        return Effect.runPromise(store.upload({ req, threadId, clientId }));
      });
      try {
        await Promise.all(started);
        let consumed = false;
        const extra = {
          headers: { "content-length": "1", "x-f5-file-name": "extra.txt" },
          async *[Symbol.asyncIterator]() {
            consumed = true;
            yield Buffer.from("x");
          },
        };
        await expect(
          Effect.runPromise(store.upload({ req: extra, threadId, clientId: "same" })),
        ).rejects.toMatchObject({ status: 429 });
        await expect(
          Effect.runPromise(store.upload({ req: extra, threadId, clientId: "fourth" })),
        ).rejects.toMatchObject({ status: 429 });
        expect(consumed).toBe(false);
      } finally {
        releases.forEach((release) => release());
        await Promise.all(jobs);
      }
    }),
  );
});

it("clones an upload into another draft without sharing mutable files or renewal ownership", async () => {
  await run((store) =>
    Effect.gen(function* () {
      const original = yield* store.upload({
        req: request(Buffer.from("stash")),
        threadId,
        clientId: "client",
      });
      const other = ThreadId.makeUnsafe("other-draft");
      const copy = yield* store.cloneToUpload(other, { uploadId: original.uploadId });
      expect(copy.uploadId).not.toBe(original.uploadId);
      expect(copy.contentHash).toBe(original.contentHash);
      expect(yield* store.getUploads(threadId, [copy.uploadId])).toEqual([null]);
      yield* store.releaseUploads(threadId, [original.uploadId]);
      yield* store.sweep;
      const opened = yield* store.openUpload(copy.uploadId);
      expect(yield* Effect.promise(() => opened.file.readFile("utf8"))).toBe("stash");
      yield* Effect.promise(() => opened.file.close());
    }),
  );
});
it("does not retain a reservation or partial file after the body disconnects", async () => {
  await run((store) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const req = {
        headers: { "content-length": "10", "x-f5-file-name": "broken.txt" },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("half");
          throw new Error("Disconnected");
        },
      };
      expect((yield* Effect.exit(store.upload({ req, threadId, clientId: "client" })))._tag).toBe(
        "Failure",
      );
      expect(yield* sql`SELECT * FROM attachment_uploads`).toEqual([]);
    }),
  );
});

it("rejects aggregate overflow before copying or retaining a claim lease", async () => {
  await run((store, dir) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* store.upload({
        req: request(Buffer.from("too large")),
        threadId,
        clientId: "budget",
      });
      const destination = path.join(dir, "rejected-copy");
      expect(
        (yield* Effect.exit(store.claim(result.uploadId, destination, { total: 1, images: 1 })))
          ._tag,
      ).toBe("Failure");
      expect(yield* sql`SELECT * FROM attachment_upload_claims`).toEqual([]);
      expect(
        (yield* sql<{
          claim_lease_until: string | null;
        }>`SELECT claim_lease_until FROM attachment_uploads`)[0]?.claim_lease_until,
      ).toBeNull();
      yield* Effect.promise(() =>
        expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" }),
      );
    }),
  );
});
