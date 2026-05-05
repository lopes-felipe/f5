/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PROJECT_READ_FILE_MAX_SIZE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type WsResponse as WsResponseMessage,
  WsResponse,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import { browseWorkspaceEntries, searchWorkspaceEntries } from "./workspaceEntries";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ThreadCommandExecutionQuery } from "./orchestration/Services/ThreadCommandExecutionQuery";
import { ThreadFileChangeQuery } from "./orchestration/Services/ThreadFileChangeQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import {
  CodeReviewWorkflowService,
  type CodeReviewWorkflowServiceShape,
} from "./orchestration/Services/CodeReviewWorkflowService";
import {
  WorkflowService,
  type WorkflowServiceShape,
} from "./orchestration/Services/WorkflowService";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "./orchestration/Services/ProviderCommandReactor.ts";
import { HarnessValidation } from "./provider/Services/HarnessValidation";
import { ProviderService } from "./provider/Services/ProviderService";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { increment, websocketConnectionsTotal } from "./observability/Metrics.ts";
import { observeRpcEffect } from "./observability/RpcInstrumentation.ts";
import { dispatchBootstrapTurnStart } from "./wsServer/bootstrapTurnStart.ts";
import { makeServerPushBus } from "./wsServer/pushBus.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { cleanupStaleWorktrees } from "./orchestration/Layers/WorktreeStartupCleanup.ts";
import { makeServerOrchestrationRuntimeLayer } from "./serverLayers.ts";
import { resolveDefaultWorktreePath } from "./git/worktreePaths.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import { CodexMcpEventBus } from "./codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "./codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "./codex/CodexOAuthManager.ts";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService.ts";
import { McpRuntimeService } from "./mcp/McpRuntimeService.ts";
import { toCodexProviderStartOptions } from "./provider/codexProviderOptions.ts";
import { reconcileCodexThreadSnapshots } from "./orchestration/codexSnapshotReconciliation.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    | Scope.Scope
    | ServerRuntimeServices
    | ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: Error): boolean => {
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

export function resolveWorkspaceReadPath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
  fileSystem: FileSystem.FileSystem;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const requestedAbsolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, requestedAbsolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.gen(function* () {
    const workspaceRootRealPath = yield* params.fileSystem.realPath(params.workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new RouteRequestError({
            message: `Failed to resolve workspace path: ${String(cause)}`,
          }),
      ),
    );
    const targetRealPathResult = yield* Effect.exit(
      params.fileSystem.realPath(requestedAbsolutePath),
    );
    if (Exit.isSuccess(targetRealPathResult)) {
      const realRelativeToRoot = toPosixRelativePath(
        params.path.relative(workspaceRootRealPath, targetRealPathResult.value),
      );
      if (
        realRelativeToRoot.length === 0 ||
        realRelativeToRoot === "." ||
        realRelativeToRoot.startsWith("../") ||
        realRelativeToRoot === ".." ||
        params.path.isAbsolute(realRelativeToRoot)
      ) {
        return yield* new RouteRequestError({
          message: "Workspace file path must stay within the project root.",
        });
      }
      return {
        absolutePath: targetRealPathResult.value,
        relativePath: relativeToRoot,
      };
    }

    return {
      absolutePath: requestedAbsolutePath,
      relativePath: relativeToRoot,
    };
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function deriveRpcGroup(method: string): string {
  if (method.startsWith("orchestration.")) {
    return "orchestration";
  }
  if (method.startsWith("git.")) {
    return "git";
  }
  if (method.startsWith("terminal.")) {
    return "terminal";
  }
  if (method.startsWith("server.")) {
    return "server";
  }
  if (method.startsWith("projects.")) {
    return "projects";
  }
  if (method.startsWith("shell.")) {
    return "shell";
  }
  return "other";
}

function rpcTraceAttributesForRequest(
  request: WebSocketRequest,
): Readonly<Record<string, unknown>> {
  const method = request.body._tag;
  const body = request.body as Record<string, unknown>;
  const attributes: Record<string, unknown> = {
    "rpc.transport": "websocket",
    "rpc.group": deriveRpcGroup(method),
  };

  const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
  if (threadId) {
    attributes["thread.id"] = threadId;
  }

  if (method === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    const command = body.command;
    if (typeof command === "object" && command !== null) {
      const commandRecord = command as Record<string, unknown>;
      if (typeof commandRecord.commandId === "string") {
        attributes["command.id"] = commandRecord.commandId;
      }
      if (!attributes["thread.id"] && typeof commandRecord.threadId === "string") {
        attributes["thread.id"] = commandRecord.threadId;
      }
    }
  }

  return attributes;
}

function resolveGitStatusInvalidation(event: OrchestrationEvent):
  | {
      readonly publish: true;
      readonly cwd: string | null;
    }
  | {
      readonly publish: false;
    } {
  if (event.type === "thread.created" && event.payload.worktreePath !== null) {
    return { publish: true, cwd: event.payload.worktreePath };
  }

  if (event.type === "thread.meta-updated" && event.payload.worktreePath !== undefined) {
    return { publish: true, cwd: event.payload.worktreePath };
  }

  return { publish: false };
}

const encodeWsResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));
const decodeWebSocketRequest = decodeJsonResult(WebSocketRequest);

export type ServerCoreRuntimeServices =
  | ProjectionSnapshotQuery
  | ThreadCommandExecutionQuery
  | ThreadFileChangeQuery
  | CheckpointDiffQuery
  | ProviderService
  | ProviderInstanceRegistry
  | ProviderRegistry
  | HarnessValidation
  | ServerSettingsService
  | CodexMcpEventBus
  | CodexMcpSyncService
  | CodexOAuthManager
  | McpRuntimeService
  | ProjectMcpConfigService;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | CheckpointStore
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

function formatRouteFailureMessage(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  if (
    squashed &&
    typeof squashed === "object" &&
    "_tag" in squashed &&
    squashed._tag === "RouteRequestError" &&
    "message" in squashed &&
    typeof squashed.message === "string"
  ) {
    return squashed.message;
  }
  return Cause.pretty(cause);
}

interface OrchestrationRuntimeServices {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerCommandReactor: ProviderCommandReactorShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly workflowService: WorkflowServiceShape;
  readonly codeReviewWorkflowService: CodeReviewWorkflowServiceShape;
  readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  | Scope.Scope
  | ServerRuntimeServices
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | SqlClient.SqlClient
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const harnessValidation = yield* HarnessValidation;
  const serverSettings = yield* ServerSettingsService;
  const codexMcpEventBus = yield* CodexMcpEventBus;
  const codexMcpSyncService = yield* CodexMcpSyncService;
  const codexOAuthManager = yield* CodexOAuthManager;
  const mcpRuntimeService = yield* McpRuntimeService;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );
  yield* serverSettings.start.pipe(
    Effect.mapError(
      (cause) =>
        new ServerLifecycleError({
          operation: "startServerSettings",
          cause,
        }),
    ),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");
  const readiness = yield* makeServerReadiness;
  const shouldLogThreadOpenTimings =
    process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS === "1" ||
    process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS === "true";

  function logOutgoingPush(push: WsPushEnvelopeBase, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      sequence: push.sequence,
      recipients,
      payload: push.data,
    });
  }

  function withWsThreadOpenTiming<A, E, R>(params: {
    readonly method: string;
    readonly threadId?: ThreadId | null;
    readonly effect: Effect.Effect<A, E, R>;
    readonly summarize?: (result: A) => Record<string, unknown>;
  }): Effect.Effect<A, E, R> {
    if (!shouldLogThreadOpenTimings) {
      return params.effect;
    }

    const startedAtMs = Date.now();
    return params.effect.pipe(
      Effect.tap((result) =>
        Effect.logInfo("ws thread open timing", {
          method: params.method,
          threadId: params.threadId ?? null,
          durationMs: Date.now() - startedAtMs,
          ...(params.summarize ? params.summarize(result) : {}),
        }),
      ),
      Effect.tapError((cause) =>
        Effect.logWarning("ws thread open timing failed", {
          method: params.method,
          threadId: params.threadId ?? null,
          durationMs: Date.now() - startedAtMs,
          cause,
        }),
      ),
    );
  }

  const pushBus = yield* makeServerPushBus({
    clients,
    logOutgoingPush,
  });
  yield* readiness.markPushBusReady;
  yield* keybindingsManager.start.pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "keybindingsRuntimeStart", cause }),
    ),
  );
  yield* readiness.markKeybindingsReady;

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;
    const normalizedBootstrap =
      turnStartCommand.bootstrap?.prepareWorktree?.projectCwd !== undefined
        ? {
            ...turnStartCommand.bootstrap,
            prepareWorktree: {
              ...turnStartCommand.bootstrap.prepareWorktree,
              projectCwd: yield* normalizeProjectWorkspaceRoot(
                turnStartCommand.bootstrap.prepareWorktree.projectCwd,
              ),
            },
          }
        : turnStartCommand.bootstrap;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
      ...(normalizedBootstrap ? { bootstrap: normalizedBootstrap } : {}),
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
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
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
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
                attachmentsDir: serverConfig.attachmentsDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                attachmentsDir: serverConfig.attachmentsDir,
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

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(streamExit)) {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
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

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const threadCommandExecutionQuery = yield* ThreadCommandExecutionQuery;
  const threadFileChangeQuery = yield* ThreadFileChangeQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const { openInEditor } = yield* Open;
  const orchestrationRuntime = yield* Deferred.make<
    OrchestrationRuntimeServices,
    ServerLifecycleError
  >();

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    providerRegistry.getProviders.pipe(
      Effect.bindTo("providers"),
      Effect.bind("settings", () =>
        serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
      ),
      Effect.flatMap(({ providers, settings }) =>
        pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          source: "keybindings",
          issues: event.issues,
          providers,
          settings,
        }),
      ),
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(serverSettings.streamChanges, (settings) =>
    Effect.all({
      keybindingsConfig: keybindingsManager.loadConfigState,
      providers: providerRegistry.getProviders,
    }).pipe(
      Effect.flatMap(({ keybindingsConfig, providers }) =>
        pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          source: "settings",
          issues: keybindingsConfig.issues,
          providers,
          settings: redactServerSettingsForClient(settings),
        }),
      ),
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(providerRegistry.streamChanges, (providers) =>
    Effect.all({
      keybindingsConfig: keybindingsManager.loadConfigState,
      settings: serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
    }).pipe(
      Effect.flatMap(({ keybindingsConfig, settings }) =>
        pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          source: "providers",
          issues: keybindingsConfig.issues,
          providers,
          settings,
        }),
      ),
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(codexMcpEventBus.streamStatusUpdates, (event) =>
    pushBus.publishAll(WS_CHANNELS.mcpStatusUpdated, event),
  ).pipe(Effect.forkIn(subscriptionsScope));

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path | SqlClient.SqlClient
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices) as <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Promise<A>;
  const orchestrationRuntimeLayer = makeServerOrchestrationRuntimeLayer().pipe(
    Layer.provide(Layer.succeedServices(runtimeServices)),
  );

  const startOrchestrationRuntime = Effect.gen(function* () {
    const orchestrationRuntimeServices = yield* Layer.buildWithScope(
      orchestrationRuntimeLayer,
      subscriptionsScope,
    );
    const orchestrationEngine = ServiceMap.get(
      orchestrationRuntimeServices,
      OrchestrationEngineService,
    );
    const orchestrationReactor = ServiceMap.get(orchestrationRuntimeServices, OrchestrationReactor);
    const providerSessionReaper = ServiceMap.get(
      orchestrationRuntimeServices,
      ProviderSessionReaper,
    );
    const providerCommandReactor = ServiceMap.get(
      orchestrationRuntimeServices,
      ProviderCommandReactor,
    );
    const providerSessionDirectory = ServiceMap.get(
      orchestrationRuntimeServices,
      ProviderSessionDirectory,
    );
    const workflowService = ServiceMap.get(orchestrationRuntimeServices, WorkflowService);
    const codeReviewWorkflowService = ServiceMap.get(
      orchestrationRuntimeServices,
      CodeReviewWorkflowService,
    );
    const projectSetupScriptRunner = ServiceMap.get(
      orchestrationRuntimeServices,
      ProjectSetupScriptRunner,
    );

    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      Effect.gen(function* () {
        yield* pushBus.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event);
        const gitStatusInvalidation = resolveGitStatusInvalidation(event);
        if (gitStatusInvalidation.publish) {
          yield* pushBus.publishAll(WS_CHANNELS.gitStatusInvalidated, {
            cwd: gitStatusInvalidation.cwd,
          });
        }
      }),
    ).pipe(Effect.forkIn(subscriptionsScope));

    yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
    yield* Scope.provide(providerSessionReaper.start(), subscriptionsScope);
    yield* readiness.markOrchestrationSubscriptionsReady;
    yield* Deferred.succeed(orchestrationRuntime, {
      orchestrationEngine,
      providerCommandReactor,
      providerSessionDirectory,
      workflowService,
      codeReviewWorkflowService,
      projectSetupScriptRunner,
    }).pipe(Effect.orDie);

    // Fire-and-forget cleanup: clear stale `worktreePath` projections whose
    // directories have disappeared so polled git commands stop spamming
    // ENOENT against missing cwds. Errors are swallowed inside the helper;
    // failing cleanup must never block server startup.
    yield* cleanupStaleWorktrees(orchestrationEngine).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(subscriptionsScope),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Deferred.fail(
          orchestrationRuntime,
          new ServerLifecycleError({
            operation: "orchestrationRuntimeStart",
            cause,
          }),
        ).pipe(Effect.orDie);
        yield* Effect.logError("failed to start orchestration runtime", { cause });
      }),
    ),
  );
  yield* startOrchestrationRuntime.pipe(Effect.forkIn(subscriptionsScope));

  const awaitOrchestrationRuntimeForBootstrap = Deferred.await(orchestrationRuntime).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      onTimeout: () =>
        Effect.fail(
          new ServerLifecycleError({
            operation: "orchestrationRuntimeStartTimeout",
          }),
        ),
    }),
  );

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForBootstrap;
      const { snapshot } = yield* projectionReadModelQuery.getStartupSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const awaitOrchestrationRuntimeForRoute = Deferred.await(orchestrationRuntime).pipe(
    Effect.mapError(
      (error) =>
        new RouteRequestError({
          message: `Orchestration runtime unavailable: ${error.operation}`,
        }),
    ),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      onTimeout: () =>
        Effect.fail(
          new RouteRequestError({
            message: "Orchestration runtime unavailable: startup timed out.",
          }),
        ),
    }),
  );
  const awaitOrchestrationRuntimeForOptionalBackground = Deferred.await(orchestrationRuntime).pipe(
    Effect.option,
  );

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.terminalEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;

  yield* Effect.addFinalizer(() =>
    Effect.all([closeAllClients, closeWebSocketServer.pipe(Effect.ignoreCause({ log: true }))]),
  );

  const reconcileThreadSnapshotsInBackground = (params: { threadId: ThreadId; reason: string }) =>
    Effect.sync(() => {
      const backgroundEffect = Effect.gen(function* () {
        const runtimeOption = yield* awaitOrchestrationRuntimeForOptionalBackground;
        if (Option.isNone(runtimeOption)) {
          return;
        }
        const { orchestrationEngine, providerSessionDirectory } = runtimeOption.value;
        const reconciliation = yield* reconcileCodexThreadSnapshots(
          {
            orchestrationEngine,
            providerService,
            providerSessionDirectory,
          },
          {
            threadIds: [params.threadId],
            reason: params.reason,
            mode: "missing-only",
            createdAt: new Date().toISOString(),
            // Passive read path: never relaunch a session the user stopped
            // just because they opened the chat. Recovery stays explicit
            // (resend, retry, etc.).
            skipStoppedBindings: true,
          },
        );
        if (reconciliation.candidateThreadCount > 0 || reconciliation.backfilledMessageCount > 0) {
          yield* Effect.logInfo("ws thread history reconciled codex snapshot", {
            threadId: params.threadId,
            reason: params.reason,
            candidateThreadCount: reconciliation.candidateThreadCount,
            providerReadCount: reconciliation.providerReadCount,
            backfilledMessageCount: reconciliation.backfilledMessageCount,
          });
        }
      }).pipe(Effect.ignoreCause({ log: true }));

      // Keep passive snapshot recovery off the request critical path so thread
      // opens always return local projection data immediately.
      setImmediate(() => {
        void runPromise(backgroundEffect.pipe(Effect.forkIn(subscriptionsScope), Effect.asVoid));
      });
    });

  const routeRequest = Effect.fnUntraced(function* (ws: WebSocket, request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.getStartupSnapshot: {
        const body = stripRequestTag(request.body);
        return yield* withWsThreadOpenTiming({
          method: ORCHESTRATION_WS_METHODS.getStartupSnapshot,
          threadId: body?.detailThreadId ?? null,
          effect: Effect.gen(function* () {
            if (body?.detailThreadId) {
              yield* reconcileThreadSnapshotsInBackground({
                threadId: body.detailThreadId,
                reason: "ws:getStartupSnapshot",
              });
            }
            return yield* projectionReadModelQuery.getStartupSnapshot(body);
          }),
          summarize: (result) => ({
            snapshotSequence: result.snapshot.snapshotSequence,
            threadCount: result.snapshot.threads.length,
            bundledTailMessages: result.threadTailDetails?.messages.length ?? 0,
            bundledTailCheckpoints: result.threadTailDetails?.checkpoints.length ?? 0,
          }),
        });
      }

      case ORCHESTRATION_WS_METHODS.getThreadTailDetails: {
        const body = stripRequestTag(request.body);
        return yield* withWsThreadOpenTiming({
          method: ORCHESTRATION_WS_METHODS.getThreadTailDetails,
          threadId: body.threadId,
          effect: Effect.gen(function* () {
            yield* reconcileThreadSnapshotsInBackground({
              threadId: body.threadId,
              reason: "ws:getThreadTailDetails",
            });
            return yield* projectionReadModelQuery.getThreadTailDetails(body);
          }),
          summarize: (result) => ({
            detailSequence: result.detailSequence,
            messageCount: result.messages.length,
            checkpointCount: result.checkpoints.length,
            hasOlderMessages: result.hasOlderMessages,
            hasOlderCheckpoints: result.hasOlderCheckpoints,
          }),
        });
      }

      case ORCHESTRATION_WS_METHODS.getThreadHistoryPage: {
        const body = stripRequestTag(request.body);
        return yield* withWsThreadOpenTiming({
          method: ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
          threadId: body.threadId,
          effect: projectionReadModelQuery.getThreadHistoryPage(body),
          summarize: (result) => ({
            detailSequence: result.detailSequence,
            messageCount: result.messages.length,
            checkpointCount: result.checkpoints.length,
            hasOlderMessages: result.hasOlderMessages,
            hasOlderCheckpoints: result.hasOlderCheckpoints,
          }),
        });
      }

      case ORCHESTRATION_WS_METHODS.getThreadDetails: {
        const body = stripRequestTag(request.body);
        yield* reconcileThreadSnapshotsInBackground({
          threadId: body.threadId,
          reason: "ws:getThreadDetails",
        });
        return yield* projectionReadModelQuery.getThreadDetails(body);
      }

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { orchestrationEngine, projectSetupScriptRunner } =
          yield* awaitOrchestrationRuntimeForRoute;
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        if (normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap) {
          return yield* dispatchBootstrapTurnStart({
            command: normalizedCommand,
            orchestrationEngine,
            git,
            projectSetupScriptRunner,
            worktreesDir: serverConfig.worktreesDir,
          });
        }
        const result = yield* orchestrationEngine.dispatch(normalizedCommand);
        return result;
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getThreadCommandExecutions: {
        const body = stripRequestTag(request.body);
        return yield* withWsThreadOpenTiming({
          method: ORCHESTRATION_WS_METHODS.getThreadCommandExecutions,
          threadId: body.threadId,
          effect: threadCommandExecutionQuery.getThreadCommandExecutions(body),
          summarize: (result) => ({
            latestSequence: result.latestSequence,
            executionCount: result.executions.length,
            isFullSync: result.isFullSync,
          }),
        });
      }

      case ORCHESTRATION_WS_METHODS.getThreadCommandExecution: {
        const body = stripRequestTag(request.body);
        return yield* threadCommandExecutionQuery.getThreadCommandExecution(body);
      }

      case ORCHESTRATION_WS_METHODS.getThreadFileChanges: {
        const body = stripRequestTag(request.body);
        return yield* withWsThreadOpenTiming({
          method: ORCHESTRATION_WS_METHODS.getThreadFileChanges,
          threadId: body.threadId,
          effect: threadFileChangeQuery.getThreadFileChanges(body),
          summarize: (result) => ({
            latestSequence: result.latestSequence,
            fileChangeCount: result.fileChanges.length,
            isFullSync: result.isFullSync,
          }),
        });
      }

      case ORCHESTRATION_WS_METHODS.getThreadFileChange: {
        const body = stripRequestTag(request.body);
        return yield* threadFileChangeQuery.getThreadFileChange(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case ORCHESTRATION_WS_METHODS.createWorkflow: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        const workflowId = yield* workflowService.createWorkflow(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to create workflow: ${String(cause)}`,
              }),
          ),
        );
        return { workflowId };
      }

      case ORCHESTRATION_WS_METHODS.archiveWorkflow: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* workflowService.archiveWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to archive workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.unarchiveWorkflow: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* workflowService.unarchiveWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to unarchive workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow: {
        const { codeReviewWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        const workflowId = yield* codeReviewWorkflowService.createWorkflow(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to create code review workflow: ${String(cause)}`,
              }),
          ),
        );
        return { workflowId };
      }

      case ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow: {
        const { codeReviewWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* codeReviewWorkflowService.archiveWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to archive code review workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow: {
        const { codeReviewWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* codeReviewWorkflowService.unarchiveWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to unarchive code review workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.deleteWorkflow: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* workflowService.deleteWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to delete workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow: {
        const { codeReviewWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* codeReviewWorkflowService.deleteWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to delete code review workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.retryWorkflow: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* workflowService.retryWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to retry workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow: {
        const { codeReviewWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* codeReviewWorkflowService.retryWorkflow(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to retry code review workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.startImplementation: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* workflowService
          .startImplementation({
            workflowId: body.workflowId,
            provider: body.provider,
            model: body.model,
            runtimeMode: body.runtimeMode,
            codeReviewEnabled: body.codeReviewEnabled,
            envMode: body.envMode,
            ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
            ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to start implementation: ${String(cause)}`,
                }),
            ),
          );
        return undefined;
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.filesystemBrowse: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => browseWorkspaceEntries(body),
          catch: () =>
            // Detailed error is already logged inside `browseWorkspaceEntries`.
            // Surface only a generic message so the endpoint cannot be used as
            // an enumeration oracle via RouteRequestError messages.
            new RouteRequestError({ message: "Failed to browse filesystem." }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.projectsReadFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceReadPath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
          fileSystem,
        });
        const stat = yield* fileSystem
          .stat(target.absolutePath)
          .pipe(
            Effect.mapError(
              () => new RouteRequestError({ message: `File not found: ${target.relativePath}` }),
            ),
          );
        if (stat.type === "Directory") {
          return yield* new RouteRequestError({
            message: `Path is a directory: ${target.relativePath}`,
          });
        }
        if (stat.size > PROJECT_READ_FILE_MAX_SIZE) {
          return yield* new RouteRequestError({
            message: `File too large (${Math.round(Number(stat.size) / 1024)}KB). Maximum is 2MB.`,
          });
        }
        const rawBytes = yield* fileSystem
          .readFile(target.absolutePath)
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({ message: `Failed to read file: ${String(cause)}` }),
            ),
          );
        const probe = new Uint8Array(rawBytes).subarray(0, 8192);
        if (probe.includes(0)) {
          return yield* new RouteRequestError({
            message: `Binary file cannot be displayed: ${target.relativePath}`,
          });
        }
        const contents = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(rawBytes),
          catch: () =>
            new RouteRequestError({
              message: `Binary file cannot be displayed: ${target.relativePath}`,
            }),
        });
        return { relativePath: target.relativePath, contents };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        const actionId = body.actionId ?? randomUUID();
        yield* pushBus
          .publishClient(ws, WS_CHANNELS.gitActionProgress, {
            actionId,
            cwd: body.cwd,
            action: body.action,
            kind: "action_started",
            phases: ["branch", "commit", "push", "pr"],
          })
          .pipe(Effect.asVoid);
        const result = yield* gitManager
          .runStackedAction(body, {
            actionId,
            progressReporter: {
              publish: (event) =>
                pushBus.publishClient(ws, WS_CHANNELS.gitActionProgress, event).pipe(Effect.asVoid),
            },
          })
          .pipe(
            Effect.tap((result) =>
              pushBus
                .publishClient(ws, WS_CHANNELS.gitActionProgress, {
                  actionId,
                  cwd: body.cwd,
                  action: body.action,
                  kind: "action_finished",
                  result,
                })
                .pipe(Effect.asVoid),
            ),
            Effect.tapError((cause) =>
              pushBus
                .publishClient(ws, WS_CHANNELS.gitActionProgress, {
                  actionId,
                  cwd: body.cwd,
                  action: body.action,
                  kind: "action_failed",
                  phase: null,
                  message: cause instanceof Error ? cause.message : String(cause),
                })
                .pipe(Effect.asVoid),
            ),
          );
        return result;
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        const targetBranch = body.newBranch ?? body.branch;
        return yield* git.createWorktree({
          ...body,
          path:
            body.path ??
            resolveDefaultWorktreePath({
              worktreesDir: serverConfig.worktreesDir,
              cwd: body.cwd,
              branch: targetBranch,
            }),
        });
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.map(redactServerSettingsForClient),
        );
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors,
          settings,
        };

      case WS_METHODS.serverUpdateSettings: {
        const body = stripRequestTag(request.body);
        return yield* serverSettings.updateSettings(body).pipe(
          Effect.map(redactServerSettingsForClient),
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.serverRefreshProviders: {
        const providers = yield* providerRegistry.refresh();
        return { providers };
      }

      case WS_METHODS.serverValidateHarnesses: {
        const body = stripRequestTag(request.body);
        const results = yield* harnessValidation
          .validate(
            body.providerOptions !== undefined
              ? { providerOptions: body.providerOptions }
              : undefined,
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ProviderValidationBusyError"
                ? new RouteRequestError({
                    message: error.message,
                  })
                : new RouteRequestError({
                    message: "Harness validation failed.",
                  }),
            ),
          );
        return { results };
      }

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.mcpGetProjectConfig: {
        const body = stripRequestTag(request.body);
        return yield* projectMcpConfigService.readProjectConfig(body.projectId).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.mcpGetCommonConfig:
        return yield* projectMcpConfigService.readCommonConfig().pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );

      case WS_METHODS.mcpReplaceProjectConfig: {
        const body = stripRequestTag(request.body);
        const result = yield* projectMcpConfigService.replaceProjectConfig(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
        yield* codexMcpEventBus.publishStatusUpdated({
          scope: "project",
          projectId: body.projectId,
          reason: "updated",
          ...(result.version ? { configVersion: result.version } : {}),
        });
        return result;
      }

      case WS_METHODS.mcpReplaceCommonConfig: {
        const body = stripRequestTag(request.body);
        const result = yield* projectMcpConfigService.replaceCommonConfig(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
        yield* codexMcpEventBus.publishStatusUpdated({
          scope: "common",
          reason: "updated",
          ...(result.version ? { configVersion: result.version } : {}),
        });
        return result;
      }

      case WS_METHODS.mcpGetEffectiveConfig: {
        const body = stripRequestTag(request.body);
        return yield* projectMcpConfigService.readEffectiveConfig(body.projectId).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.mcpGetProviderStatus: {
        const body = stripRequestTag(request.body);
        return yield* mcpRuntimeService.getProviderStatus(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.mcpGetServerStatuses: {
        const body = stripRequestTag(request.body);
        return yield* mcpRuntimeService.getServerStatuses(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.mcpStartLogin: {
        const body = stripRequestTag(request.body);
        return yield* mcpRuntimeService.startLogin(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.mcpGetLoginStatus: {
        const body = stripRequestTag(request.body);
        return yield* mcpRuntimeService.getLoginStatus(body);
      }

      case WS_METHODS.mcpGetCodexStatus: {
        const body = stripRequestTag(request.body);
        const providerOptions = toCodexProviderStartOptions({
          binaryPath: body.binaryPath,
          homePath: body.homePath,
        });
        return yield* codexMcpSyncService.getStatus({
          projectId: body.projectId,
          ...(providerOptions ? { providerOptions } : {}),
        });
      }

      case WS_METHODS.mcpReloadProject: {
        const body = stripRequestTag(request.body);
        const providerOptions = toCodexProviderStartOptions({
          binaryPath: body.binaryPath,
          homePath: body.homePath,
        });
        yield* providerService.reloadMcpConfigForProject({
          provider: "codex",
          projectId: body.projectId,
          ...(providerOptions ? { providerOptions } : {}),
        });
        const status = yield* codexMcpSyncService.getStatus({
          projectId: body.projectId,
          ...(providerOptions ? { providerOptions } : {}),
        });
        yield* codexMcpEventBus.publishStatusUpdated({
          provider: "codex",
          scope: "project",
          projectId: body.projectId,
          reason: "reloaded",
          ...(status.configVersion ? { configVersion: status.configVersion } : {}),
        });
        return status;
      }

      case WS_METHODS.mcpApplyToLiveSessions: {
        const body = stripRequestTag(request.body);
        const { providerCommandReactor } = yield* awaitOrchestrationRuntimeForRoute;
        const result = yield* providerCommandReactor.applyMcpConfigToLiveSessions(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
        yield* codexMcpEventBus.publishStatusUpdated({
          scope: result.scope,
          ...(result.projectId ? { projectId: result.projectId } : {}),
          reason: "applied",
          ...(result.configVersion ? { configVersion: result.configVersion } : {}),
        });
        return result;
      }

      case WS_METHODS.mcpStartOAuthLogin: {
        const body = stripRequestTag(request.body);
        return yield* codexOAuthManager.startLogin(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.mcpGetOAuthStatus: {
        const body = stripRequestTag(request.body);
        return yield* codexOAuthManager.getStatus(body);
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const sendWsResponse = (response: WsResponseMessage) =>
      encodeWsResponse(response).pipe(
        Effect.tap((encodedResponse) => Effect.sync(() => ws.send(encodedResponse))),
        Effect.asVoid,
      );

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
    }

    const request = decodeWebSocketRequest(messageText);
    if (Result.isFailure(request)) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${formatSchemaError(request.failure)}` },
      });
    }

    const method = request.success.body._tag;
    const result = yield* Effect.exit(
      observeRpcEffect(
        method,
        routeRequest(ws, request.success),
        rpcTraceAttributesForRequest(request.success),
      ).pipe(
        Effect.withSpan(`rpc.${method}`, {
          kind: "server",
        }),
      ),
    );
    if (Exit.isFailure(result)) {
      return yield* sendWsResponse({
        id: request.success.id,
        error: { message: formatRouteFailureMessage(result.cause) },
      });
    }

    return yield* sendWsResponse({
      id: request.success.id,
      result: result.value,
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    void runPromise(
      increment(websocketConnectionsTotal, {
        event: "connect",
      }),
    );
    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcomeData = {
      cwd,
      projectName,
      ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
      ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
    };
    // Send welcome before adding to broadcast set so publishAll calls
    // cannot reach this client before the welcome arrives.
    void runPromise(
      (autoBootstrapProjectFromCwd ? readiness.awaitServerReady : readiness.awaitClientReady).pipe(
        Effect.flatMap(() => pushBus.publishClient(ws, WS_CHANNELS.serverWelcome, welcomeData)),
        Effect.flatMap((delivered) =>
          delivered ? Ref.update(clients, (clients) => clients.add(ws)) : Effect.void,
        ),
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
    });

    let disconnectRecorded = false;
    const recordDisconnect = () => {
      if (disconnectRecorded) {
        return;
      }
      disconnectRecorded = true;
      void runPromise(
        increment(websocketConnectionsTotal, {
          event: "disconnect",
        }).pipe(
          Effect.andThen(
            Ref.update(clients, (clients) => {
              clients.delete(ws);
              return clients;
            }),
          ),
        ),
      );
    };

    ws.on("close", recordDisconnect);
    ws.on("error", recordDisconnect);
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
