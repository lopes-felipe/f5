import type http from "node:http";
import { ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Exit, type FileSystem, type Path, Schema } from "effect";
import { IMMUTABLE_PRIVATE_CACHE_CONTROL, openContainedFile, serveAsset } from "../../assetHttp.ts";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "../../attachmentPaths.ts";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { AttachmentUploadError, type makeAttachmentUploads } from "../../attachmentUploads.ts";

/** Call only after the listener's own authorization and protocol checks. */
export function makeAttachmentHttpRoutes(deps: {
  attachmentsDir: string;
  attachmentUploads: Effect.Success<ReturnType<typeof makeAttachmentUploads>>;
  fileSystem: FileSystem.FileSystem;
  path: Path.Path;
}) {
  const { attachmentsDir, attachmentUploads, fileSystem, path } = deps;
  // Only mobile uploads created in this host runtime have a mobile owner.
  const mobileUploads = new Map<string, { deviceId: string; expiresAt: number }>();
  return (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    clientId?: string,
    authorizationStatus?: () => 401 | 503 | null,
  ) =>
    Effect.gen(function* () {
      const uploadsPath = clientId ? "/mobile/v1/attachments/uploads" : "/api/attachments/uploads";
      const attachmentsPrefix = clientId ? "/mobile/v1/attachments/" : ATTACHMENTS_ROUTE_PREFIX;
      const respond = (status: number, headers: Record<string, string>, body?: string) => {
        res.writeHead(status, clientId ? { ...headers, "Cache-Control": "no-store" } : headers);
        res.end(body);
      };
      const respondUnavailable = (status: 401 | 503) =>
        respond(
          status,
          { "Content-Type": "application/json" },
          JSON.stringify({ error: status === 401 ? "unauthorized" : "disabled" }),
        );
      if (
        url.pathname.startsWith(uploadsPath + "/") &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        const id = url.pathname.slice((uploadsPath + "/").length);
        if (clientId) {
          const owner = mobileUploads.get(id);
          if (owner?.deviceId !== clientId || owner.expiresAt <= Date.now()) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return true;
          }
        }
        const opened = yield* Effect.exit(attachmentUploads.openUpload(id));
        const unavailable = authorizationStatus?.();
        if (unavailable) {
          if (Exit.isSuccess(opened)) yield* Effect.promise(() => opened.value.file.close());
          respondUnavailable(unavailable);
          return true;
        }
        if (Exit.isFailure(opened))
          respond(410, { "Cache-Control": "no-store" }, "Upload expired. Re-attach the file.");
        else
          yield* Effect.promise(() =>
            serveAsset(
              req,
              res,
              opened.value.file,
              opened.value.name,
              clientId ? { cacheControl: "no-store" } : undefined,
            ).catch(() => {
              if (!res.destroyed) res.destroy();
            }),
          );
        return true;
      }
      if (url.pathname === uploadsPath && req.method === "POST") {
        const threadId = url.searchParams.get("threadId");
        const client = clientId ?? req.headers["x-f5-upload-client"];
        if (!threadId || threadId.length > 128 || !/^[a-zA-Z0-9_-]+$/u.test(threadId)) {
          respond(
            400,
            { "Content-Type": "application/json" },
            JSON.stringify({ error: "Invalid draft thread ID." }),
          );
          return true;
        }
        const result = yield* Effect.exit(
          attachmentUploads.upload({
            req,
            threadId: ThreadId.makeUnsafe(threadId),
            ...(url.searchParams.get("source") === "pasted-text" ||
            url.searchParams.get("source") === "snapshot"
              ? { source: url.searchParams.get("source") as "pasted-text" | "snapshot" }
              : {}),
            clientId:
              typeof client === "string" && client.length <= 128
                ? client
                : (req.socket.remoteAddress ?? "unknown"),
          }),
        );
        const unavailable = authorizationStatus?.();
        if (unavailable) {
          if (Exit.isSuccess(result))
            yield* attachmentUploads
              .releaseUploads(ThreadId.makeUnsafe(threadId), [result.value.uploadId])
              .pipe(Effect.ignore);
          respondUnavailable(unavailable);
          return true;
        }
        if (Exit.isFailure(result)) {
          const failure = Cause.squash(result.cause);
          const status = Schema.is(AttachmentUploadError)(failure) ? failure.status : 500;
          respond(
            status,
            {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              ...(status === 429 || status === 507 ? { "Retry-After": "2" } : {}),
            },
            JSON.stringify({
              error: Schema.is(AttachmentUploadError)(failure)
                ? failure.message
                : "Attachment upload failed.",
            }),
          );
        } else {
          if (clientId) {
            const now = Date.now();
            for (const [id, owner] of mobileUploads) {
              if (owner.expiresAt <= now) mobileUploads.delete(id);
            }
            if (mobileUploads.size >= 2048) {
              const oldest = mobileUploads.keys().next().value;
              if (oldest !== undefined) mobileUploads.delete(oldest);
            }
            mobileUploads.set(result.value.uploadId, {
              deviceId: clientId,
              expiresAt: Date.parse(result.value.expiresAt),
            });
          }
          respond(
            201,
            { "Content-Type": "application/json", "Cache-Control": "no-store" },
            JSON.stringify(result.value),
          );
        }
        return true;
      }
      if (url.pathname.startsWith(attachmentsPrefix)) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          respond(405, { Allow: "GET, HEAD" }, "Method not allowed");
          return true;
        }
        const rawRelativePath = url.pathname.slice(attachmentsPrefix.length);
        const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
        if (!normalizedRelativePath) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
          return true;
        }

        const isIdLookup =
          !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
        if (clientId && !isIdLookup) {
          respond(404, { "Content-Type": "text/plain" }, "Not Found");
          return true;
        }
        const filePath = isIdLookup
          ? resolveAttachmentPathById({
              attachmentsDir,
              attachmentId: normalizedRelativePath,
            })
          : resolveAttachmentRelativePath({
              attachmentsDir,
              relativePath: normalizedRelativePath,
            });
        if (!filePath) {
          respond(
            isIdLookup ? 404 : 400,
            { "Content-Type": "text/plain" },
            isIdLookup ? "Not Found" : "Invalid attachment path",
          );
          return true;
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          respond(404, { "Content-Type": "text/plain" }, "Not Found");
          return true;
        }

        yield* Effect.promise(async () => {
          try {
            const file = await openContainedFile(
              attachmentsDir,
              path.relative(attachmentsDir, filePath),
            );
            const unavailable = authorizationStatus?.();
            if (unavailable) {
              await file.close();
              respondUnavailable(unavailable);
              return;
            }
            await serveAsset(req, res, file, filePath, {
              cacheControl: clientId ? "no-store" : IMMUTABLE_PRIVATE_CACHE_CONTROL,
            });
          } catch {
            if (res.headersSent) res.destroy();
            else respond(404, { "Content-Type": "text/plain" }, "Not Found");
          }
        });
        return true;
      }
      return false;
    });
}
