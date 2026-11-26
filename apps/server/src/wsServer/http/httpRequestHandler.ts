import type http from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import Mime from "@effect/platform-node/Mime";
import {
  F5_PROTOCOL_HEADER,
  type OrchestrationGetStartupSnapshotInput,
  type ServerRuntimeReadiness,
  ThreadId,
} from "@t3tools/contracts";
import {
  DESKTOP_ACTIVITY_PATH,
  ORCHESTRATION_STARTUP_SNAPSHOT_PATH,
  type DesktopBackendActivity,
} from "@t3tools/shared/backendPaths";
import { Cause, Effect, Exit, type FileSystem, Option, type Path, Schema } from "effect";

import {
  IMMUTABLE_PRIVATE_CACHE_CONTROL,
  openContainedFile,
  serveAsset,
  streamFileHandle,
} from "../../assetHttp.ts";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "../../attachmentPaths.ts";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { AttachmentUploadError, type makeAttachmentUploads } from "../../attachmentUploads.ts";
import type { makeBackupService } from "../../backupService.ts";
import type { ProfileGithubAccount } from "../../git/ProfileGithubAccount.ts";
import type { makeHtmlPreviewBroker } from "../../htmlRender/HtmlPreviewBroker.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { desktopBusyThreadCount } from "../../orchestration/sessionBusy.ts";
import type { makeProjectionTurnRepository } from "../../persistence/Layers/ProjectionTurns.ts";
import { createGitHubMediaProxy } from "../../prHub/githubMediaProxy.ts";
import type { makeCheckedInProjectFileService } from "../../project/CheckedInProjectFileService.ts";
import { tryHandleProjectFaviconRequest } from "../../projectFaviconRoute.ts";
import {
  AUTH_RATE_LIMITED_MESSAGE,
  isPrivateHttpPath,
  REQUEST_HOST_NOT_ALLOWED_MESSAGE,
  type makeServerAuth,
} from "../../serverAuth.ts";
import type { ForgeAccounts } from "../../sourceControl/accountRouting.ts";
import type { makeWorkspaceAssetAuthorizer } from "../../WorkspaceAssetAuthorizer.ts";
import { protocolMatches, SERVER_BOOTSTRAP, UPGRADE_REQUIRED } from "../protocol.ts";
import {
  buildStaticAssetResponseHeaders,
  DESKTOP_RENDERER_ORIGIN,
  PRIVATE_CORS_ALLOW_HEADERS,
  PRIVATE_CORS_HEADERS,
  PRIVATE_CORS_METHODS,
  resolveStaticAssetPath,
  shouldFallbackToSpaIndex,
} from "./staticAssets.ts";

const gzipSnapshot = promisify(gzip);

export interface HttpRequestHandlerDependencies {
  readonly port: number;
  readonly mode: string;
  readonly devUrl: URL | undefined;
  readonly staticDir: string | undefined;
  readonly attachmentsDir: string;
  readonly backendIncarnation: string;
  readonly serverAuth: ReturnType<typeof makeServerAuth>;
  readonly htmlPreviewBroker: ReturnType<typeof makeHtmlPreviewBroker>;
  readonly forgeAccounts: Option.Option<typeof ForgeAccounts.Service>;
  readonly githubAccount: ProfileGithubAccount;
  readonly getRuntimeReadiness: () => ServerRuntimeReadiness;
  readonly getAwaitOrchestrationEngine: () => Effect.Effect<
    Pick<OrchestrationEngineShape, "getReadModel">,
    Error
  >;
  readonly getAgentBridgeTurns: () => Effect.Success<typeof makeProjectionTurnRepository>;
  readonly readStartupSnapshot: (
    body: OrchestrationGetStartupSnapshotInput,
    transport: "ws" | "http",
  ) => Effect.Effect<unknown, Error>;
  readonly backupService: Effect.Success<typeof makeBackupService>;
  readonly attachmentUploads: Effect.Success<ReturnType<typeof makeAttachmentUploads>>;
  readonly getWorkspaceAssetAuthorizer: () => ReturnType<typeof makeWorkspaceAssetAuthorizer>;
  readonly getCheckedInProjectFileService: () => ReturnType<typeof makeCheckedInProjectFileService>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Builds the Node HTTP request listener shared by desktop and headless web
 * modes: host/CORS/auth guards, capability asset delivery, backup/restore,
 * attachment upload/download, gzip startup snapshots, and static SPA serving.
 */
export function createHttpRequestListener(
  deps: HttpRequestHandlerDependencies,
): http.RequestListener {
  const {
    port,
    mode,
    devUrl,
    staticDir,
    attachmentsDir,
    backendIncarnation,
    serverAuth,
    htmlPreviewBroker,
    forgeAccounts,
    githubAccount,
    getRuntimeReadiness,
    getAwaitOrchestrationEngine,
    getAgentBridgeTurns,
    readStartupSnapshot,
    backupService,
    attachmentUploads,
    getWorkspaceAssetAuthorizer,
    getCheckedInProjectFileService,
    fileSystem,
    path,
  } = deps;

  return (req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        // Before anything else, static files included: a rebound page must not load the app
        // under its own origin either.
        if (!serverAuth.isRequestHostAllowed(req)) {
          respond(
            403,
            { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify({ error: REQUEST_HOST_NOT_ALLOWED_MESSAGE }),
          );
          return;
        }
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        // Workspace asset handles are capabilities: the URL is the credential, so
        // they skip session auth but still need CORS for the renderer's fetch().
        const isCapabilityAssetPath = url.pathname.startsWith("/api/workspace-assets/");
        const isPrivatePath = isPrivateHttpPath(url.pathname) && !isCapabilityAssetPath;
        const requestOrigin = req.headers.origin;
        // Attachment URLs are also loaded by <img>, whose requests do not
        // carry an Origin header. Keep those cache entries separate from
        // authenticated CORS fetches used by copy and download actions.
        if (isPrivatePath || isCapabilityAssetPath) {
          res.setHeader("Vary", "Origin");
        }
        const isExplicitPrivateCorsOrigin =
          requestOrigin === devUrl?.origin ||
          (mode === "desktop" && requestOrigin === DESKTOP_RENDERER_ORIGIN);
        if (
          isCapabilityAssetPath &&
          typeof requestOrigin === "string" &&
          isExplicitPrivateCorsOrigin &&
          (req.method === "GET" || req.method === "HEAD")
        ) {
          // No credentials: the handle alone authorizes the read.
          res.setHeader("Access-Control-Allow-Origin", requestOrigin);
          res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
        }
        const isAllowedPrivateCorsRequest =
          isPrivatePath &&
          typeof requestOrigin === "string" &&
          isExplicitPrivateCorsOrigin &&
          serverAuth.isWebSocketOriginAllowed(req);
        if (isAllowedPrivateCorsRequest) {
          res.setHeader("Access-Control-Allow-Credentials", "true");
          res.setHeader("Access-Control-Allow-Origin", requestOrigin);
          res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length");
        }
        if (req.method === "OPTIONS" && isPrivatePath) {
          if (!isAllowedPrivateCorsRequest) {
            respond(
              403,
              {
                "Cache-Control": "no-store",
                "Content-Type": "application/json; charset=utf-8",
              },
              JSON.stringify({ error: "CORS origin is not allowed." }),
            );
            return;
          }

          const requestedMethod = req.headers["access-control-request-method"]?.toUpperCase() ?? "";
          const rawRequestedHeaders = req.headers["access-control-request-headers"];
          const requestedHeaders = (
            Array.isArray(rawRequestedHeaders)
              ? rawRequestedHeaders.join(",")
              : (rawRequestedHeaders ?? "")
          )
            .split(",")
            .map((header) => header.trim().toLowerCase())
            .filter((header) => header.length > 0);
          if (
            !PRIVATE_CORS_METHODS.has(requestedMethod) ||
            requestedHeaders.some((header) => !PRIVATE_CORS_HEADERS.has(header))
          ) {
            respond(
              403,
              {
                "Cache-Control": "no-store",
                "Content-Type": "application/json; charset=utf-8",
              },
              JSON.stringify({ error: "CORS request method or headers are not allowed." }),
            );
            return;
          }

          res.setHeader(
            "Vary",
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
          );
          respond(204, {
            "Access-Control-Allow-Headers": PRIVATE_CORS_ALLOW_HEADERS,
            "Access-Control-Allow-Methods": "GET, POST",
            "Cache-Control": "no-store",
            "Content-Length": "0",
          });
          return;
        }

        const handledAuthRequest = yield* Effect.promise(() =>
          serverAuth.handleHttpRequest(req, res, url),
        );
        if (handledAuthRequest) {
          return;
        }
        if (isPrivatePath && !serverAuth.isHttpRequestAuthenticated(req)) {
          // A locked-out client is told to wait, so it does not take its token for a wrong one.
          const retryAfter = serverAuth.bearerRetryAfterSeconds(req);
          respond(
            retryAfter === null ? 401 : 429,
            {
              "Cache-Control": "no-store",
              "Content-Type": "application/json; charset=utf-8",
              ...(retryAfter === null ? {} : { "Retry-After": `${retryAfter}` }),
            },
            JSON.stringify({
              error: retryAfter === null ? "Authentication required." : AUTH_RATE_LIMITED_MESSAGE,
            }),
          );
          return;
        }
        if (
          isPrivatePath &&
          url.pathname.startsWith("/api/") &&
          !serverAuth.isWebSocketOriginAllowed(req)
        ) {
          respond(
            403,
            { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify({ error: "Request origin is not allowed." }),
          );
          return;
        }

        if (
          isPrivatePath &&
          !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") &&
          !protocolMatches(req.headers[F5_PROTOCOL_HEADER.toLowerCase()])
        ) {
          respond(
            426,
            { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify(UPGRADE_REQUIRED),
          );
          return;
        }
        if (url.pathname.startsWith("/api/html-renders/preview/")) {
          const id = url.pathname.slice("/api/html-renders/preview/".length);
          const html = /^[a-f0-9-]{36}$/.test(id) ? htmlPreviewBroker.readInput(id) : null;
          const allowed = req.method === "GET" || req.method === "HEAD";
          respond(
            allowed ? (html === null ? 410 : 200) : 405,
            {
              "Cache-Control": "no-store",
              "Content-Type": "text/plain; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox; default-src 'none'",
            },
            req.method === "HEAD" ? undefined : (html ?? "Preview expired."),
          );
          return;
        }
        if (url.pathname === "/api/prhub/media") {
          const accounts = Option.isSome(forgeAccounts)
            ? yield* forgeAccounts.value.listAccounts()
            : [];
          const accountId = url.searchParams.get("accountId");
          const proxy = createGitHubMediaProxy({
            configuredHosts: accounts
              .filter((account) => account.provider === "github")
              .map((account) => account.host),
            resolveToken: async (host) => {
              if (accountId) {
                const account = accounts.find(
                  (value) =>
                    value.id === accountId && value.provider === "github" && value.host === host,
                );
                if (!account || Option.isNone(forgeAccounts)) return undefined;
                return Effect.runPromise(forgeAccounts.value.getToken(account.id));
              }
              return (await githubAccount.token(host)) ?? undefined;
            },
          });
          yield* Effect.promise(() => proxy(req, res));
          return;
        }
        if (url.pathname === DESKTOP_ACTIVITY_PATH && req.method === "GET") {
          const headers = {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
          };
          const readiness = getRuntimeReadiness();
          if (readiness.state !== "ready") {
            respond(503, headers, JSON.stringify({ state: readiness.state }));
            return;
          }
          const orchestrationEngine = yield* getAwaitOrchestrationEngine();
          const model = yield* orchestrationEngine.getReadModel();
          const pending = yield* getAgentBridgeTurns().listRecentPendingTurnStartThreadIds({
            since: new Date(Date.now() - 600_000).toISOString(),
          });
          respond(
            200,
            headers,
            JSON.stringify({
              busyThreadCount: desktopBusyThreadCount(model, pending),
            } satisfies DesktopBackendActivity),
          );
          return;
        }
        if (url.pathname === "/api/bootstrap" && req.method === "GET") {
          respond(
            200,
            { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify(SERVER_BOOTSTRAP),
          );
          return;
        }
        if (url.pathname === ORCHESTRATION_STARTUP_SNAPSHOT_PATH) {
          const headers = {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            Vary: "Origin, Accept-Encoding",
          };
          if (req.method !== "GET") {
            respond(405, { ...headers, Allow: "GET" });
            return;
          }
          if (url.searchParams.get("incarnation") !== backendIncarnation) {
            respond(409, headers);
            return;
          }
          const detailThreadId = url.searchParams.get("detailThreadId");
          const parsedDetailThreadId =
            detailThreadId === null
              ? Option.none()
              : Schema.decodeUnknownOption(ThreadId)(detailThreadId);
          if (detailThreadId !== null && Option.isNone(parsedDetailThreadId)) {
            respond(400, headers);
            return;
          }
          yield* getAwaitOrchestrationEngine();
          const snapshot = yield* readStartupSnapshot(
            Option.isSome(parsedDetailThreadId)
              ? { detailThreadId: parsedDetailThreadId.value }
              : {},
            "http",
          );
          const json = JSON.stringify(snapshot);
          const acceptGzip = req.headers["accept-encoding"]
            ?.split(",")
            .some((encoding) =>
              /^\s*gzip\s*(?:;\s*q=(?:1(?:\.0*)?|0\.\d*[1-9]\d*))?\s*$/i.test(encoding),
            );
          if (acceptGzip) {
            const body = yield* Effect.tryPromise(() => gzipSnapshot(json));
            respond(200, { ...headers, "Content-Encoding": "gzip" }, body);
          } else {
            respond(200, headers, json);
          }
          return;
        }

        if (url.pathname === "/api/storage/backup") {
          if (req.method !== "GET") {
            respond(405, { Allow: "GET", "Content-Type": "application/json; charset=utf-8" });
            return;
          }
          const includeSecrets = url.searchParams.get("includeSecrets") === "1";
          const passwordHeader = req.headers["x-f5-backup-password"];
          const password = Array.isArray(passwordHeader) ? passwordHeader[0] : passwordHeader;
          if (includeSecrets && (!password || password.length < 12)) {
            respond(
              400,
              { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
              JSON.stringify({
                error: "Encrypted secret export requires a password of at least 12 characters.",
              }),
            );
            return;
          }
          const filename = `f5-backup-${new Date().toISOString().slice(0, 10)}.f5backup`;
          const exit = yield* Effect.exit(
            backupService.exportArchive({
              output: res,
              includeSecrets,
              ...(password ? { password } : {}),
              onReady: ({ contentLength }) => {
                res.writeHead(200, {
                  "Cache-Control": "no-store",
                  "Content-Disposition": `attachment; filename="${filename}"`,
                  "Content-Length": contentLength,
                  "Content-Type": "application/x-f5-backup",
                  "X-Content-Type-Options": "nosniff",
                });
              },
            }),
          );
          if (Exit.isFailure(exit)) {
            if (!res.headersSent) {
              const failure = Cause.squash(exit.cause);
              respond(
                500,
                { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
                JSON.stringify({
                  error:
                    failure instanceof Error ? failure.message : "Unable to create backup archive.",
                }),
              );
            } else if (!res.destroyed) {
              res.destroy();
            }
          }
          return;
        }

        if (url.pathname === "/api/storage/restore") {
          if (req.method !== "POST") {
            respond(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8" });
            return;
          }
          const passwordHeader = req.headers["x-f5-backup-password"];
          const password = Array.isArray(passwordHeader) ? passwordHeader[0] : passwordHeader;
          const contentLengthHeader = req.headers["content-length"];
          const contentLength =
            typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
          if (
            contentLength !== undefined &&
            (!Number.isSafeInteger(contentLength) || contentLength < 0)
          ) {
            req.resume();
            respond(
              400,
              { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
              JSON.stringify({ error: "Backup upload has an invalid Content-Length header." }),
            );
            return;
          }
          if (
            contentLength !== undefined &&
            contentLength > backupService.restoreLimits.maxCompressedBytes
          ) {
            req.resume();
            respond(
              413,
              { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
              JSON.stringify({
                error: "Backup upload exceeds the compressed restore size limit.",
              }),
            );
            return;
          }
          const exit = yield* Effect.exit(
            backupService.stageRestore({
              source: req,
              ...(password ? { password } : {}),
              ...(contentLength !== undefined ? { contentLength } : {}),
            }),
          );
          if (Exit.isFailure(exit)) {
            const failure = Cause.squash(exit.cause);
            const message =
              failure instanceof Error ? failure.message : "Unable to validate and stage backup.";
            respond(
              400,
              { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
              JSON.stringify({ error: message }),
            );
            return;
          }
          respond(
            202,
            { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify(exit.value),
          );
          return;
        }
        if (
          url.pathname.startsWith("/api/attachments/uploads/") &&
          (req.method === "GET" || req.method === "HEAD")
        ) {
          const id = url.pathname.slice("/api/attachments/uploads/".length);
          const opened = yield* Effect.exit(attachmentUploads.openUpload(id));
          if (Exit.isFailure(opened))
            respond(410, { "Cache-Control": "no-store" }, "Upload expired. Re-attach the file.");
          else
            yield* Effect.promise(() =>
              serveAsset(req, res, opened.value.file, opened.value.name).catch(() => {
                if (!res.destroyed) res.destroy();
              }),
            );
          return;
        }
        if (url.pathname === "/api/attachments/uploads" && req.method === "POST") {
          const threadId = url.searchParams.get("threadId");
          const client = req.headers["x-f5-upload-client"];
          if (!threadId || threadId.length > 128 || !/^[a-zA-Z0-9_-]+$/u.test(threadId)) {
            respond(
              400,
              { "Content-Type": "application/json" },
              JSON.stringify({ error: "Invalid draft thread ID." }),
            );
            return;
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
            respond(
              201,
              { "Content-Type": "application/json", "Cache-Control": "no-store" },
              JSON.stringify(result.value),
            );
          }
          return;
        }
        if (
          yield* Effect.promise(() =>
            tryHandleProjectFaviconRequest(
              url,
              res,
              getWorkspaceAssetAuthorizer(),
              getCheckedInProjectFileService(),
              req,
              serverAuth.externalRequestOrigin,
            ),
          )
        ) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            respond(405, { Allow: "GET, HEAD" }, "Method not allowed");
            return;
          }
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
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
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          yield* Effect.promise(async () => {
            try {
              const file = await openContainedFile(
                attachmentsDir,
                path.relative(attachmentsDir, filePath),
              );
              await serveAsset(req, res, file, filePath, {
                cacheControl: IMMUTABLE_PRIVATE_CACHE_CONTROL,
              });
            } catch {
              if (res.headersSent) res.destroy();
              else respond(404, { "Content-Type": "text/plain" }, "Not Found");
            }
          });
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const resolved = resolveStaticAssetPath({ staticDir, pathname: url.pathname, path });
        if (!resolved.ok) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          respond(405, { Allow: "GET, HEAD" }, "Method not allowed");
          return;
        }

        let filePath = resolved.filePath;
        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          if (!shouldFallbackToSpaIndex(req.headers, resolved.rawRelativePath)) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          filePath = path.resolve(resolved.staticRoot, "index.html");
        }
        const relative = path.relative(resolved.staticRoot, filePath);
        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        yield* Effect.promise(async () => {
          try {
            const file = await openContainedFile(resolved.staticRoot, relative);
            await streamFileHandle(
              req,
              res,
              file,
              buildStaticAssetResponseHeaders({
                relativePath: relative,
                contentType,
                pathSep: path.sep,
              }),
            );
          } catch {
            if (res.headersSent) res.destroy();
            else respond(404, { "Content-Type": "text/plain" }, "Not Found");
          }
        });
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  };
}
