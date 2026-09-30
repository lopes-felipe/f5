import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { openContainedFile } from "./assetHttp";
import { Effect, Exit, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_DRAFT_QUOTA_BYTES,
  ATTACHMENT_PROFILE_QUOTA_BYTES,
  ATTACHMENT_SERVER_UPLOAD_CONCURRENCY,
  ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY,
  type AttachmentUpload,
  type ThreadId,
} from "@t3tools/contracts";

export class AttachmentUploadError extends Schema.TaggedErrorClass<AttachmentUploadError>()(
  "AttachmentUploadError",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}
interface UploadRow {
  upload_id: string;
  draft_thread_id: string;
  kind: "image" | "file";
  name: string;
  mime_type: string;
  size_bytes: number;
  content_hash: string;
  path: string;
  created_at: string;
  expires_at: string;
  last_draft_touch_at: string | null;
  claim_lease_until: string | null;
  source: "pasted-text" | "snapshot" | null;
}
const HOUR = 60 * 60 * 1000;
/** Both mirror the attachment schema so an accepted upload cannot fail validation at send. */
const UPLOAD_NAME_MAX_LENGTH = 255;
const UPLOAD_MIME_MAX_LENGTH = 100;
export function sanitizeUploadName(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Invalid file name encoding");
  }
  // The attachment schema caps names at 255 UTF-16 units, so measure in those
  // units (an emoji is two) while never splitting a surrogate pair.
  let name = "";
  for (const character of decoded) {
    if (
      character.codePointAt(0)! < 32 ||
      character === "\u007f" ||
      character === "/" ||
      character === "\\"
    )
      continue;
    if (name.length + character.length > UPLOAD_NAME_MAX_LENGTH) break;
    name += character;
  }
  return name.trim() || "attachment.bin";
}
export function sniffUploadImage(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}
const dto = (row: UploadRow): AttachmentUpload => ({
  uploadId: row.upload_id,
  draftThreadId: row.draft_thread_id as ThreadId,
  kind: row.kind,
  name: row.name,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  contentHash: row.content_hash,
  expiresAt: row.expires_at,
  ...(row.source ? { source: row.source } : {}),
});

/** Reservations and leases share SQLite transactions with ownership checks. Bytes never enter WS. */
export type AttachmentUploads = Effect.Success<ReturnType<typeof makeAttachmentUploads>>;

/**
 * Create once per server: upload concurrency counters are per instance.
 * Authorization: one authenticated operator owns every draft, and upload ids are
 * random UUIDs, so `claim` and `cloneToUpload` do not check which draft owns an
 * upload. A multi-user mode must add an owner check there.
 */
export const makeAttachmentUploads = Effect.fnUntraced(function* (attachmentsDir: string) {
  const sql = yield* SqlClient.SqlClient;
  const directory = path.join(attachmentsDir, ".uploads");
  let active = 0;
  const clients = new Map<string, number>();
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        new AttachmentUploadError({ status: 500, message: "Attachment storage operation failed." }),
    });
  const now = () => new Date().toISOString();

  const upload = Effect.fnUntraced(function* (input: {
    req: Pick<IncomingMessage, "headers"> & AsyncIterable<Uint8Array>;
    threadId: ThreadId;
    clientId: string;
    source?: "pasted-text" | "snapshot";
  }) {
    const size = Number(input.req.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size <= 0 || size > ATTACHMENT_MAX_FILE_BYTES) {
      return yield* new AttachmentUploadError({
        status: input.req.headers["content-length"] === undefined ? 411 : 413,
        message: "A Content-Length between 1 and 50 MiB is required.",
      });
    }
    const rawName = input.req.headers["x-f5-file-name"];
    if (typeof rawName !== "string")
      return yield* new AttachmentUploadError({
        status: 400,
        message: "X-F5-File-Name is required.",
      });
    const name = yield* Effect.try({
      try: () => sanitizeUploadName(rawName),
      catch: () =>
        new AttachmentUploadError({ status: 400, message: "Invalid file name encoding." }),
    });
    if (
      active >= ATTACHMENT_SERVER_UPLOAD_CONCURRENCY ||
      (clients.get(input.clientId) ?? 0) >= ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY
    ) {
      return yield* new AttachmentUploadError({
        status: 429,
        message: "Upload capacity is busy. Retry shortly.",
      });
    }
    active++;
    clients.set(input.clientId, (clients.get(input.clientId) ?? 0) + 1);
    const id = randomUUID();
    const part = path.join(directory, `${id}.part`);
    const finalPath = path.join(directory, id);
    return yield* Effect.gen(function* () {
      const createdAt = now();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const totals = yield* sql<{
            total: number;
            draft: number;
          }>`SELECT COALESCE(SUM(size_bytes),0) AS total,
          COALESCE(SUM(CASE WHEN draft_thread_id = ${input.threadId} THEN size_bytes ELSE 0 END),0) AS draft FROM attachment_uploads`;
          if (
            (totals[0]?.total ?? 0) + size > ATTACHMENT_PROFILE_QUOTA_BYTES ||
            (totals[0]?.draft ?? 0) + size > ATTACHMENT_DRAFT_QUOTA_BYTES
          ) {
            return yield* new AttachmentUploadError({
              status: 507,
              message: "Attachment staging quota is full. Release unused uploads and retry.",
            });
          }
          yield* sql`INSERT INTO attachment_uploads(upload_id,draft_thread_id,kind,name,mime_type,size_bytes,content_hash,path,created_at,expires_at,source)
          VALUES(${id},${input.threadId},'file',${name},'application/octet-stream',${size},'',${part},${createdAt},${new Date(Date.now() + HOUR).toISOString()},${input.source ?? null})`;
        }),
      );
      yield* io(() => mkdir(directory, { recursive: true }));
      let received = 0;
      const hash = createHash("sha256");
      let prefix = Buffer.alloc(0);
      yield* Effect.acquireUseRelease(
        io(() => open(part, "wx", 0o600)),
        (file) =>
          Stream.fromAsyncIterable(
            input.req,
            () =>
              new AttachmentUploadError({
                status: 400,
                message: "Upload interrupted before all bytes arrived.",
              }),
          ).pipe(
            Stream.runForEach((data) =>
              io(async () => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                received += chunk.length;
                if (received > size) throw new Error("Upload exceeds reservation");
                hash.update(chunk);
                if (prefix.length < 16)
                  prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
                let offset = 0;
                while (offset < chunk.length) {
                  const result = await file.write(chunk, offset, chunk.length - offset);
                  if (!result.bytesWritten) throw new Error("Write made no progress");
                  offset += result.bytesWritten;
                }
              }),
            ),
            Effect.timeoutOrElse({
              duration: "10 minutes",
              onTimeout: () =>
                Effect.fail(
                  new AttachmentUploadError({
                    status: 408,
                    message: "Upload timed out. Retry the file.",
                  }),
                ),
            }),
            Effect.flatMap(() =>
              received === size
                ? io(() => file.sync())
                : Effect.fail(
                    new AttachmentUploadError({ status: 400, message: "Incomplete upload." }),
                  ),
            ),
          ),
        (file) => io(() => file.close()).pipe(Effect.ignore),
      );
      yield* io(() => rename(part, finalPath));
      const imageMime = size <= ATTACHMENT_MAX_IMAGE_BYTES ? sniffUploadImage(prefix) : null;
      const declared = input.req.headers["content-type"]?.split(";")[0]?.trim();
      const result = {
        kind: imageMime ? ("image" as const) : ("file" as const),
        mime:
          imageMime ??
          (declared &&
          declared.length <= UPLOAD_MIME_MAX_LENGTH &&
          /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(declared) &&
          !declared.startsWith("image/")
            ? declared
            : "application/octet-stream"),
        hash: hash.digest("hex"),
      };
      const rows =
        yield* sql<UploadRow>`UPDATE attachment_uploads SET kind=${result.kind}, mime_type=${result.mime},
        content_hash=${result.hash},path=${finalPath},expires_at=${new Date(Date.now() + 24 * HOUR).toISOString()}
        WHERE upload_id=${id} RETURNING *`;
      return dto(rows[0]!);
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.gen(function* () {
              yield* io(async () => {
                await Promise.all(
                  [part, finalPath].map((file) => unlink(file).catch(() => undefined)),
                );
              }).pipe(Effect.ignore);
              yield* sql`DELETE FROM attachment_uploads WHERE upload_id=${id}`.pipe(Effect.ignore);
            })
          : Effect.void,
      ),
      Effect.ensuring(
        Effect.sync(() => {
          active--;
          const count = (clients.get(input.clientId) ?? 1) - 1;
          if (count) clients.set(input.clientId, count);
          else clients.delete(input.clientId);
        }),
      ),
    );
  });

  const getUploads = Effect.fnUntraced(function* (threadId: ThreadId, ids: ReadonlyArray<string>) {
    return yield* sql.withTransaction(
      Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            const rows =
              yield* sql<UploadRow>`UPDATE attachment_uploads SET last_draft_touch_at=${now()},expires_at=${new Date(Date.now() + 7 * 24 * HOUR).toISOString()}
        WHERE upload_id=${id} AND draft_thread_id=${threadId} AND content_hash<>'' AND expires_at>${now()} RETURNING *`;
            return rows[0] ? dto(rows[0]) : null;
          }),
        { concurrency: 1 },
      ),
    );
  });
  const releaseUploads = Effect.fnUntraced(function* (
    threadId: ThreadId,
    ids: ReadonlyArray<string>,
  ) {
    for (const id of ids)
      yield* sql`UPDATE attachment_uploads SET expires_at=${now()} WHERE upload_id=${id} AND draft_thread_id=${threadId}`;
    yield* sweep;
  });
  const claim = Effect.fnUntraced(function* (
    id: string,
    destination: string,
    remaining?: { total: number; images: number },
  ) {
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql<UploadRow>`UPDATE attachment_uploads SET claim_lease_until=${new Date(Date.now() + 10 * 60 * 1000).toISOString()}
        WHERE upload_id=${id} AND content_hash<>'' AND expires_at>${now()} RETURNING *`;
        if (!rows[0])
          return yield* new AttachmentUploadError({
            status: 410,
            message: "Upload expired or was released. Re-attach the file.",
          });
        if (
          remaining &&
          (rows[0].size_bytes > remaining.total ||
            (rows[0].kind === "image" && rows[0].size_bytes > remaining.images))
        ) {
          return yield* new AttachmentUploadError({
            status: 413,
            message: "Attachments exceed the per-turn byte limit.",
          });
        }
        yield* sql`INSERT INTO attachment_upload_claims(claim_id,upload_id,lease_until) VALUES(${destination},${id},${new Date(Date.now() + 10 * 60 * 1000).toISOString()})`;
        return rows[0];
      }),
    );
    yield* io(async () => {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(row.path, destination, constants.COPYFILE_FICLONE);
    }).pipe(
      Effect.uninterruptible,
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.gen(function* () {
              yield* io(() => unlink(destination).catch(() => undefined)).pipe(Effect.ignore);
              yield* finishClaim(id, destination).pipe(Effect.ignore);
            })
          : Effect.void,
      ),
    );
    return { attachment: dto(row), sourcePath: destination };
  });
  const finishClaim = (id: string, claimId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM attachment_upload_claims WHERE claim_id=${claimId} AND upload_id=${id}`;
        yield* sql`UPDATE attachment_uploads SET claim_lease_until=(SELECT MAX(lease_until) FROM attachment_upload_claims WHERE upload_id=${id}) WHERE upload_id=${id}`;
      }),
    );
  const sweep = sql.withTransaction(
    Effect.gen(function* () {
      const expired =
        yield* sql<UploadRow>`SELECT * FROM attachment_uploads WHERE expires_at<=${now()} AND (claim_lease_until IS NULL OR claim_lease_until<=${now()})`;
      for (const row of expired) {
        // Uploads are copies, never message/queue files; still refuse a path held by the registry.
        const owners = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM attachments a JOIN attachment_owners o ON o.attachment_id=a.attachment_id WHERE a.final_path=${row.path} OR a.staging_path=${row.path}`;
        if ((owners[0]?.count ?? 0) > 0) continue;
        yield* io(() =>
          unlink(row.path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          }),
        );
        if (row.content_hash === "") {
          yield* io(() =>
            unlink(path.join(directory, row.upload_id)).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            }),
          );
        }
        yield* sql`DELETE FROM attachment_uploads WHERE upload_id=${row.upload_id}`;
      }
    }),
  );
  const openUpload = Effect.fnUntraced(function* (id: string) {
    const rows =
      yield* sql<UploadRow>`SELECT * FROM attachment_uploads WHERE upload_id=${id} AND content_hash<>'' AND expires_at>${now()}`;
    if (!rows[0])
      return yield* new AttachmentUploadError({
        status: 410,
        message: "Upload expired. Re-attach the file.",
      });
    const row = rows[0];
    const file = yield* io(() => openContainedFile(directory, path.basename(row.path)));
    return { file, name: row.name };
  });
  const cloneToUpload = Effect.fnUntraced(function* (
    threadId: ThreadId,
    source: { attachmentId: string } | { uploadId: string },
  ) {
    const rows =
      "uploadId" in source
        ? yield* sql<{
            name: string;
            mime_type: string;
            size_bytes: number;
            final_path: string;
          }>`SELECT name,mime_type,size_bytes,path AS final_path FROM attachment_uploads WHERE upload_id=${source.uploadId} AND content_hash<>'' AND expires_at>${now()}`
        : yield* sql<{
            name: string;
            mime_type: string;
            size_bytes: number;
            final_path: string;
          }>`SELECT name,mime_type,size_bytes,final_path FROM attachments WHERE attachment_id=${source.attachmentId} AND lifecycle='ready'`;
    const row = rows[0];
    if (!row)
      return yield* new AttachmentUploadError({
        status: 404,
        message: "Attachment is unavailable.",
      });
    const file = yield* io(() =>
      openContainedFile(attachmentsDir, path.relative(attachmentsDir, row.final_path)),
    );
    return yield* upload({
      threadId,
      clientId: "clone",
      req: Object.assign(file.createReadStream({ autoClose: false }), {
        headers: {
          "content-length": String(row.size_bytes),
          "content-type": row.mime_type,
          "x-f5-file-name": encodeURIComponent(row.name),
        },
      }),
    }).pipe(Effect.ensuring(io(() => file.close()).pipe(Effect.ignore)));
  });
  return {
    upload,
    getUploads,
    releaseUploads,
    claim,
    finishClaim,
    sweep,
    openUpload,
    cloneToUpload,
  };
});
