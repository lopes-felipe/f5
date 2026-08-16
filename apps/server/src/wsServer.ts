/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  AGENTS_WS_CHANNELS,
  AGENTS_WS_METHODS,
  USAGE_WS_METHODS,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PROJECT_READ_FILE_MAX_SIZE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PR_HUB_WS_CHANNELS,
  PR_HUB_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  type StorageCleanupProgressPayload,
  WebSocketRequest,
  type WsResponse as WsResponseMessage,
  WsResponse,
  type WsPushEnvelopeBase,
  type WorkflowPlatformCreateRunInput,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  Cause,
  Deferred,
  Duration,
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
import { NextTurnQueueStore } from "./nextTurnQueue/Services/NextTurnQueueStore.ts";
import {
  NextTurnQueueDispatcher,
  type NextTurnQueueDispatcherShape,
} from "./nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { canonicalRequestHash } from "./nextTurnQueue/canonicalRequestHash.ts";
import {
  NextTurnQueueIdempotencyConflictError,
  type NextTurnQueueError,
} from "./nextTurnQueue/Errors.ts";
import { makeGlobalSearch } from "./globalSearch";
import { makeBackupService } from "./backupService";
import {
  BUILTIN_WORKFLOW_TEMPLATES,
  createWorkflowPlatformRun,
  inspectWorkflowPlatformRun,
} from "./workflowPlatform.ts";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import {
  browseWorkspaceEntries,
  clearWorkspaceIndexCache,
  listWorkspaceEntries,
  registerWorkspaceContentIndexInvalidator,
  searchWorkspaceEntries,
} from "./workspaceEntries";
import { makeProjectContentSearchManager } from "./projectContentSearch";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  ThreadBackgroundWork,
  type ThreadBackgroundWorkShape,
} from "./orchestration/Services/ThreadBackgroundWork";
import { UsageService, type UsageServiceShape } from "./usage/Services/UsageService";
import { ThreadCommandExecutionQuery } from "./orchestration/Services/ThreadCommandExecutionQuery";
import { ThreadFileChangeQuery } from "./orchestration/Services/ThreadFileChangeQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import {
  CodeReviewWorkflowService,
  type CodeReviewWorkflowServiceShape,
} from "./orchestration/Services/CodeReviewWorkflowService";
import {
  InvestigationWorkflowService,
  type InvestigationWorkflowServiceShape,
} from "./orchestration/Services/InvestigationWorkflowService";
import {
  WorkflowService,
  type WorkflowServiceShape,
} from "./orchestration/Services/WorkflowService";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "./orchestration/Services/ProviderCommandReactor.ts";
import {
  ProviderTurnDeliveryWorker,
  type ProviderTurnDeliveryWorkerShape,
} from "./orchestration/Services/ProviderTurnDeliveryWorker.ts";
import { HarnessValidation } from "./provider/Services/HarnessValidation";
import { ProviderService } from "./provider/Services/ProviderService";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderAdvisoryProjection } from "./provider/Services/ProviderAdvisoryProjection.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProviderUpdateAdvisor } from "./provider/Services/ProviderUpdateAdvisor.ts";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import { makeWorkspaceAssetAuthorizer } from "./WorkspaceAssetAuthorizer";
import { makeCheckedInProjectFileService } from "./project/CheckedInProjectFileService";
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
import {
  increment,
  previewRecordingFramesDroppedTotal,
  websocketConnectionsTotal,
} from "./observability/Metrics.ts";
import { observeRpcEffect } from "./observability/RpcInstrumentation.ts";
import {
  dispatchBootstrapTurnStart,
  isDefinitelyUncommittedDispatchError,
} from "./wsServer/bootstrapTurnStart.ts";
import { makeServerPushBus, makeWebSocketSendController } from "./wsServer/pushBus.ts";
import {
  resolveServerPerMessageDeflate,
  webSocketRuntimeName,
} from "./wsServer/webSocketTransport.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { cleanupStaleWorktrees } from "./orchestration/Layers/WorktreeStartupCleanup.ts";
import { makeServerOrchestrationRuntimeLayer } from "./serverLayers.ts";
import { withStartupPhaseTiming } from "./startupTiming.ts";
import { isPrivateHttpPath, makeServerAuth } from "./serverAuth.ts";
import { resolveDefaultWorktreePath } from "./git/worktreePaths.ts";
import { getReviewPreviewDiff } from "./git/ReviewDiffService.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import { getProviderTurnInputLengthIssue } from "@t3tools/shared/providerInput";
import { CodexMcpEventBus } from "./codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "./codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "./codex/CodexOAuthManager.ts";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService.ts";
import { McpRuntimeService } from "./mcp/McpRuntimeService.ts";
import { toCodexProviderStartOptions } from "./provider/codexProviderOptions.ts";
import { reconcileCodexThreadSnapshots } from "./orchestration/codexSnapshotReconciliation.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { StorageMaintenance, type StorageMaintenanceShape } from "./storage/StorageMaintenance.ts";
import { makePreviewManager } from "./preview/Manager.ts";
import { writeFileBytesAtomically } from "./atomicWrite.ts";
import { scanLocalServers } from "./preview/PortScanner.ts";
import { PreviewAutomationBroker } from "./mcp/PreviewAutomationBroker.ts";
import { PrHubAdvisoryService } from "./prHub/Services/PrHubAdvisoryService.ts";
import { PrHubService } from "./prHub/Services/PrHubService.ts";

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

const DESKTOP_RENDERER_ORIGIN = "t3://app";
const PRIVATE_CORS_METHODS = new Set(["GET", "POST"]);
const PRIVATE_CORS_HEADERS = new Set(["authorization", "content-type", "x-f5-backup-password"]);

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

function isRelativePathOutsideRoot(relativePath: string, path: Path.Path): boolean {
  return (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.startsWith("../") ||
    relativePath === ".." ||
    path.isAbsolute(relativePath)
  );
}

function validateWorkspaceRelativeTarget(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<
  { requestedAbsolutePath: string; relativePath: string; workspaceAbsolutePath: string },
  RouteRequestError
> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const workspaceAbsolutePath = params.path.resolve(params.workspaceRoot);
  const requestedAbsolutePath = params.path.resolve(workspaceAbsolutePath, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(workspaceAbsolutePath, requestedAbsolutePath),
  );
  if (isRelativePathOutsideRoot(relativeToRoot, params.path)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    requestedAbsolutePath,
    relativePath: relativeToRoot,
    workspaceAbsolutePath,
  });
}

function ensureRealPathInsideWorkspace(params: {
  workspaceRootRealPath: string;
  targetRealPath: string;
  path: Path.Path;
  allowWorkspaceRoot?: boolean;
}): Effect.Effect<void, RouteRequestError> {
  const realRelativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRootRealPath, params.targetRealPath),
  );
  if (
    isRelativePathOutsideRoot(realRelativeToRoot, params.path) &&
    !(params.allowWorkspaceRoot && (realRelativeToRoot === "." || realRelativeToRoot.length === 0))
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }
  return Effect.void;
}

export function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
  fileSystem: FileSystem.FileSystem;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  return Effect.gen(function* () {
    const target = yield* validateWorkspaceRelativeTarget(params);
    const workspaceRootRealPath = yield* params.fileSystem
      .realPath(target.workspaceAbsolutePath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to resolve workspace path: ${String(cause)}`,
            }),
        ),
      );
    const targetRealPathResult = yield* Effect.exit(
      params.fileSystem.realPath(target.requestedAbsolutePath),
    );
    if (Exit.isSuccess(targetRealPathResult)) {
      yield* ensureRealPathInsideWorkspace({
        workspaceRootRealPath,
        targetRealPath: targetRealPathResult.value,
        path: params.path,
      });
      return {
        absolutePath: targetRealPathResult.value,
        relativePath: target.relativePath,
      };
    }

    let currentParentPath = params.path.dirname(target.requestedAbsolutePath);
    while (true) {
      const parentRelativeToWorkspace = toPosixRelativePath(
        params.path.relative(target.workspaceAbsolutePath, currentParentPath),
      );
      if (
        isRelativePathOutsideRoot(parentRelativeToWorkspace, params.path) &&
        parentRelativeToWorkspace !== "." &&
        parentRelativeToWorkspace.length !== 0
      ) {
        return yield* new RouteRequestError({
          message: "Workspace file path must stay within the project root.",
        });
      }

      const parentRealPathResult = yield* Effect.exit(
        params.fileSystem.realPath(currentParentPath),
      );
      if (Exit.isSuccess(parentRealPathResult)) {
        yield* ensureRealPathInsideWorkspace({
          workspaceRootRealPath,
          targetRealPath: parentRealPathResult.value,
          path: params.path,
          allowWorkspaceRoot: true,
        });
        return {
          absolutePath: target.requestedAbsolutePath,
          relativePath: target.relativePath,
        };
      }

      const nextParentPath = params.path.dirname(currentParentPath);
      if (nextParentPath === currentParentPath) {
        return yield* new RouteRequestError({
          message: `Failed to resolve workspace path: ${String(parentRealPathResult.cause)}`,
        });
      }
      currentParentPath = nextParentPath;
    }
  });
}

export function resolveWorkspaceReadPath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
  fileSystem: FileSystem.FileSystem;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  return Effect.gen(function* () {
    const target = yield* validateWorkspaceRelativeTarget(params);
    const workspaceRootRealPath = yield* params.fileSystem
      .realPath(target.workspaceAbsolutePath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to resolve workspace path: ${String(cause)}`,
            }),
        ),
      );
    const targetRealPathResult = yield* Effect.exit(
      params.fileSystem.realPath(target.requestedAbsolutePath),
    );
    if (Exit.isSuccess(targetRealPathResult)) {
      yield* ensureRealPathInsideWorkspace({
        workspaceRootRealPath,
        targetRealPath: targetRealPathResult.value,
        path: params.path,
      });
      return {
        absolutePath: targetRealPathResult.value,
        relativePath: target.relativePath,
      };
    }

    return {
      absolutePath: target.requestedAbsolutePath,
      relativePath: target.relativePath,
    };
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFilePrefix(
  absolutePath: string,
  byteLimit: number,
): Effect.Effect<Uint8Array, RouteRequestError> {
  return Effect.tryPromise({
    try: async () => {
      const handle = await fsPromises.open(absolutePath, "r");
      try {
        const buffer = Buffer.allocUnsafe(byteLimit);
        const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => new RouteRequestError({ message: `Failed to read file: ${String(cause)}` }),
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function deriveRpcGroup(method: string): string {
  if (method.startsWith("agents.")) {
    return "agents";
  }
  if (method.startsWith("orchestration.")) {
    return "orchestration";
  }
  if (method.startsWith("git.")) {
    return "git";
  }
  if (method.startsWith("terminal.")) {
    return "terminal";
  }
  if (method.startsWith("preview.")) {
    return "preview";
  }
  if (method.startsWith("server.")) {
    return "server";
  }
  if (method.startsWith("prHub.")) {
    return "prHub";
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
  | ProviderUpdateAdvisor
  | ProviderAdvisoryProjection
  | HarnessValidation
  | ServerSettingsService
  | CodexMcpEventBus
  | CodexMcpSyncService
  | CodexOAuthManager
  | McpRuntimeService
  | ProjectMcpConfigService
  | PreviewAutomationBroker
  | PrHubAdvisoryService
  | PrHubService;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | CheckpointStore
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService
  | NextTurnQueueStore;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

function mapNextTurnQueueRouteError(error: NextTurnQueueError): RouteRequestError {
  return new RouteRequestError({ message: error.message, code: error._tag });
}

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

function formatRouteFailure(cause: Cause.Cause<unknown>): {
  readonly message: string;
  readonly code?: string;
} {
  const squashed = Cause.squash(cause);
  if (Schema.is(RouteRequestError)(squashed)) {
    return {
      message: squashed.message,
      ...(squashed.code !== undefined ? { code: squashed.code } : {}),
    };
  }
  return { message: formatRouteFailureMessage(cause) };
}

const MAX_ROUTE_CAUSE_MESSAGE_LENGTH = 1000;

function compactRouteCauseMessage(value: string): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= MAX_ROUTE_CAUSE_MESSAGE_LENGTH) {
    return compacted;
  }
  return `${compacted.slice(0, MAX_ROUTE_CAUSE_MESSAGE_LENGTH - 3)}...`;
}

function formatServerLifecycleRouteFailure(error: ServerLifecycleError): string {
  const baseMessage = `Orchestration runtime unavailable: ${error.operation}`;
  if (error.cause === undefined) {
    return baseMessage;
  }

  const causeMessage = Cause.isCause(error.cause)
    ? Cause.pretty(error.cause)
    : error.cause instanceof Error
      ? (error.cause.stack ?? error.cause.message)
      : String(error.cause);
  const compactedCauseMessage = compactRouteCauseMessage(causeMessage);
  return compactedCauseMessage.length > 0
    ? `${baseMessage}: ${compactedCauseMessage}`
    : baseMessage;
}

interface OrchestrationRuntimeServices {
  readonly threadBackgroundWork: ThreadBackgroundWorkShape;
  readonly usageService: UsageServiceShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerCommandReactor: ProviderCommandReactorShape;
  readonly providerTurnDeliveryWorker: ProviderTurnDeliveryWorkerShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly workflowService: WorkflowServiceShape;
  readonly codeReviewWorkflowService: CodeReviewWorkflowServiceShape;
  readonly investigationWorkflowService: InvestigationWorkflowServiceShape;
  readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
  readonly storageMaintenance: StorageMaintenanceShape;
  readonly nextTurnQueueDispatcher: NextTurnQueueDispatcherShape;
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
    mode,
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
  const serverAuth = makeServerAuth(authToken, {
    allowedWebSocketOrigins: [
      ...(mode === "desktop" ? [DESKTOP_RENDERER_ORIGIN] : []),
      ...(devUrl ? [devUrl.origin] : []),
    ],
  });
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const providerUpdateAdvisor = yield* ProviderUpdateAdvisor;
  const providerAdvisoryProjection = yield* ProviderAdvisoryProjection;
  const harnessValidation = yield* HarnessValidation;
  const serverSettings = yield* ServerSettingsService;
  const codexMcpEventBus = yield* CodexMcpEventBus;
  const codexMcpSyncService = yield* CodexMcpSyncService;
  const codexOAuthManager = yield* CodexOAuthManager;
  const mcpRuntimeService = yield* McpRuntimeService;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const previewAutomationBroker = yield* PreviewAutomationBroker;
  const prHub = yield* PrHubService;
  const prHubAdvisory = yield* PrHubAdvisoryService;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const nextTurnQueueStore = yield* NextTurnQueueStore;
  const globalSearch = yield* makeGlobalSearch;
  const backupService = yield* makeBackupService;

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
    process.env.NODE_ENV !== "test" &&
    process.env.VITEST !== "true" &&
    (process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS === "1" ||
      process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS === "true");

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

  const webSocketSendController = makeWebSocketSendController({ clients });
  const pushBus = yield* makeServerPushBus({
    clients,
    logOutgoingPush,
    sendClient: webSocketSendController.send,
  });
  const previewManager = makePreviewManager();
  const previewAutomationClientIdsByWs = new WeakMap<WebSocket, Map<string, string>>();

  const getPreviewAutomationClientIdsForWs = (ws: WebSocket): Map<string, string> => {
    let clientIds = previewAutomationClientIdsByWs.get(ws);
    if (!clientIds) {
      clientIds = new Map();
      previewAutomationClientIdsByWs.set(ws, clientIds);
    }
    return clientIds;
  };

  const getServerPreviewAutomationClientId = (ws: WebSocket, rendererClientId: string): string => {
    const clientIds = getPreviewAutomationClientIdsForWs(ws);
    const existing = clientIds.get(rendererClientId);
    if (existing) return existing;
    const next = `preview-ws-${randomUUID()}`;
    clientIds.set(rendererClientId, next);
    return next;
  };

  const authorizedPreviewAutomationClientIds = (ws: WebSocket): ReadonlySet<string> =>
    new Set(previewAutomationClientIdsByWs.get(ws)?.values() ?? []);

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
    const turnInput: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> =
      input.command;
    const { dispatchSource: _dispatchSource, ...turnStartCommand } =
      turnInput as typeof turnInput & {
        readonly dispatchSource?: unknown;
      };
    const inputLengthIssue = getProviderTurnInputLengthIssue(turnStartCommand.message.text);
    if (inputLengthIssue) {
      return yield* new RouteRequestError({
        message: inputLengthIssue.message,
      });
    }
    if (turnStartCommand.message.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return yield* new RouteRequestError({
        message: `A turn can include at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      });
    }
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

    const preparedAttachments = yield* Effect.forEach(
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

          const stagingPath = path.join(
            serverConfig.attachmentsDir,
            ".staging",
            createHash("sha256").update(turnStartCommand.commandId).digest("hex"),
            path.basename(attachmentPath),
          );
          return { attachment, persistedAttachment, attachmentPath, stagingPath, bytes };
        }),
      { concurrency: 1 },
    );

    const writtenAttachments: Array<{
      readonly id: string;
      readonly stagingPath: string;
      readonly finalPath: string;
    }> = [];
    const cleanupWrittenAttachments = Effect.forEach(
      writtenAttachments,
      (written) =>
        Effect.all(
          [
            fileSystem.remove(written.stagingPath, { force: true }).pipe(Effect.ignore),
            fileSystem.remove(written.finalPath, { force: true }).pipe(Effect.ignore),
            sql`DELETE FROM attachments WHERE attachment_id = ${written.id}`.pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      { concurrency: 1, discard: true },
    );
    const normalizedAttachments = yield* Effect.gen(function* () {
      yield* Effect.forEach(
        preparedAttachments,
        ({ attachment, persistedAttachment, attachmentPath, stagingPath, bytes }) =>
          writeFileBytesAtomically({ filePath: stagingPath, contents: bytes }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
            Effect.tap(() =>
              Effect.sync(() =>
                writtenAttachments.push({
                  id: persistedAttachment.id,
                  stagingPath,
                  finalPath: attachmentPath,
                }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      );

      yield* sql.withTransaction(
        Effect.forEach(
          preparedAttachments,
          ({ attachment, persistedAttachment, attachmentPath, stagingPath, bytes }) => {
            const createdAt = new Date().toISOString();
            return Effect.gen(function* () {
              yield* sql`
            INSERT INTO attachments (
              attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
              staging_path, final_path, lifecycle, created_at, updated_at
            ) VALUES (
              ${persistedAttachment.id}, ${turnStartCommand.threadId}, 'image', ${attachment.name},
              ${persistedAttachment.mimeType}, ${bytes.byteLength},
                  ${createHash("sha256").update(bytes).digest("hex")}, ${stagingPath}, ${attachmentPath},
                  'staged', ${createdAt}, ${createdAt}
            )
          `.pipe(
                Effect.mapError(
                  () =>
                    new RouteRequestError({
                      message: `Failed to record attachment '${attachment.name}'.`,
                    }),
                ),
              );
              yield* sql`
            INSERT INTO attachment_owners (
              attachment_id, owner_kind, owner_id, created_at
            ) VALUES (${persistedAttachment.id}, 'ingress', ${turnStartCommand.commandId}, ${createdAt})
          `.pipe(
                Effect.mapError(
                  () =>
                    new RouteRequestError({
                      message: `Failed to record attachment '${attachment.name}'.`,
                    }),
                ),
              );
            });
          },
          { concurrency: 1, discard: true },
        ),
      );

      yield* Effect.forEach(
        preparedAttachments,
        ({ persistedAttachment, attachmentPath, stagingPath }) =>
          Effect.gen(function* () {
            yield* fileSystem.rename(stagingPath, attachmentPath);
            yield* sql`
              UPDATE attachments SET lifecycle = 'ready', staging_path = NULL,
                updated_at = ${new Date().toISOString()}
              WHERE attachment_id = ${persistedAttachment.id} AND lifecycle = 'staged'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      return preparedAttachments.map((entry) => entry.persistedAttachment);
    }).pipe(Effect.tapError(() => cleanupWrittenAttachments));

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
      ...(normalizedBootstrap ? { bootstrap: normalizedBootstrap } : {}),
    } satisfies OrchestrationCommand;
  });

  const removePersistedTurnAttachments = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ) =>
    Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM attachment_owners
            WHERE attachment_id = ${attachment.id}
              AND owner_kind = 'ingress'
              AND owner_id = ${command.commandId}
          `.pipe(Effect.ignore);
          const owners = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM attachment_owners
            WHERE attachment_id = ${attachment.id}
          `.pipe(Effect.catch(() => Effect.succeed([{ count: 0 }])));
          if ((owners[0]?.count ?? 0) > 0) return;

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (attachmentPath) {
            yield* fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore);
          }
          yield* sql`
            DELETE FROM attachments
            WHERE attachment_id = ${attachment.id}
              AND NOT EXISTS (
                SELECT 1 FROM attachment_owners
                WHERE attachment_id = ${attachment.id}
              )
          `.pipe(Effect.ignore);
        }),
      { concurrency: 1, discard: true },
    );

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
        const isPrivatePath = isPrivateHttpPath(url.pathname);
        const requestOrigin = req.headers.origin;
        // Attachment URLs are also loaded by <img>, whose requests do not
        // carry an Origin header. Keep those cache entries separate from
        // authenticated CORS fetches used by copy and download actions.
        if (isPrivatePath) {
          res.setHeader("Vary", "Origin");
        }
        const isExplicitPrivateCorsOrigin =
          requestOrigin === devUrl?.origin ||
          (mode === "desktop" && requestOrigin === DESKTOP_RENDERER_ORIGIN);
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
            "Access-Control-Allow-Headers": "Authorization, Content-Type, X-F5-Backup-Password",
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
          respond(
            401,
            {
              "Cache-Control": "no-store",
              "Content-Type": "application/json; charset=utf-8",
            },
            JSON.stringify({ error: "Authentication required." }),
          );
          return;
        }
        if (url.pathname.startsWith("/api/storage/") && !serverAuth.isWebSocketOriginAllowed(req)) {
          respond(
            403,
            { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify({ error: "Request origin is not allowed." }),
          );
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
          yield* Effect.promise(() =>
            tryHandleProjectFaviconRequest(
              url,
              res,
              workspaceAssetAuthorizer,
              checkedInProjectFileService,
            ),
          )
        ) {
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
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: resolveServerPerMessageDeflate(),
  });

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
  const workspaceAssetAuthorizer = makeWorkspaceAssetAuthorizer({
    resolveProjectWorkspaceRoot: async (projectId) => {
      const snapshot = await Effect.runPromise(projectionReadModelQuery.getSnapshot());
      return (
        snapshot.projects.find((project) => project.id === projectId && project.deletedAt === null)
          ?.workspaceRoot ?? null
      );
    },
    resolveThreadWorkspaceRoot: async (threadId) => {
      const snapshot = await Effect.runPromise(projectionReadModelQuery.getSnapshot());
      const thread = snapshot.threads.find(
        (candidate) => candidate.id === threadId && candidate.deletedAt === null,
      );
      if (!thread) return null;
      if (thread.worktreePath) return thread.worktreePath;
      return (
        snapshot.projects.find(
          (project) => project.id === thread.projectId && project.deletedAt === null,
        )?.workspaceRoot ?? null
      );
    },
  });
  const checkedInProjectFileService = makeCheckedInProjectFileService(workspaceAssetAuthorizer);
  const projectContentSearchManager = makeProjectContentSearchManager();
  const unregisterWorkspaceContentInvalidator = registerWorkspaceContentIndexInvalidator(
    projectContentSearchManager.invalidateWorkspaceRoot,
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      unregisterWorkspaceContentInvalidator();
      await projectContentSearchManager.dispose();
    }),
  );
  const activeContentSearchesByClient = new WeakMap<WebSocket, Map<string, string>>();
  let nextContentSearchKey = 1;
  const threadCommandExecutionQuery = yield* ThreadCommandExecutionQuery;
  const threadFileChangeQuery = yield* ThreadFileChangeQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const { openInEditor, revealInFileManager } = yield* Open;
  const orchestrationRuntime = yield* Deferred.make<
    OrchestrationRuntimeServices,
    ServerLifecycleError
  >();
  const nextTurnQueueDispatcherRef = yield* Ref.make<NextTurnQueueDispatcherShape | null>(null);

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    providerAdvisoryProjection.getProviders.pipe(
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
      providers: providerAdvisoryProjection.getProviders,
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
  yield* Stream.runForEach(providerAdvisoryProjection.streamChanges, (providers) =>
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
      Effect.tap(() => providerUpdateAdvisor.noteRegistryChanged),
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(providerUpdateAdvisor.streamChanges, (advisories) =>
    pushBus.publishAll(WS_CHANNELS.providerAdvisoriesUpdated, { advisories }),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(prHub.streamSnapshots, (snapshot) =>
    pushBus.publishAll(PR_HUB_WS_CHANNELS.snapshotUpdated, snapshot),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(prHubAdvisory.streamAdvisories, (snapshot) =>
    pushBus.publishAll(PR_HUB_WS_CHANNELS.advisoriesUpdated, snapshot),
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

  const startOrchestrationRuntime = withStartupPhaseTiming(
    "orchestration.runtime.start",
    Effect.gen(function* () {
      const orchestrationRuntimeServices = yield* Layer.buildWithScope(
        orchestrationRuntimeLayer,
        subscriptionsScope,
      );
      const orchestrationEngine = ServiceMap.get(
        orchestrationRuntimeServices,
        OrchestrationEngineService,
      );
      const orchestrationReactor = ServiceMap.get(
        orchestrationRuntimeServices,
        OrchestrationReactor,
      );
      const providerSessionReaper = ServiceMap.get(
        orchestrationRuntimeServices,
        ProviderSessionReaper,
      );
      const threadBackgroundWork = ServiceMap.get(
        orchestrationRuntimeServices,
        ThreadBackgroundWork,
      );
      const usageService = ServiceMap.get(orchestrationRuntimeServices, UsageService);
      const providerCommandReactor = ServiceMap.get(
        orchestrationRuntimeServices,
        ProviderCommandReactor,
      );
      const providerTurnDeliveryWorker = ServiceMap.get(
        orchestrationRuntimeServices,
        ProviderTurnDeliveryWorker,
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
      const investigationWorkflowService = ServiceMap.get(
        orchestrationRuntimeServices,
        InvestigationWorkflowService,
      );
      const projectSetupScriptRunner = ServiceMap.get(
        orchestrationRuntimeServices,
        ProjectSetupScriptRunner,
      );
      const storageMaintenance = ServiceMap.get(orchestrationRuntimeServices, StorageMaintenance);
      const nextTurnQueueDispatcher = ServiceMap.get(
        orchestrationRuntimeServices,
        NextTurnQueueDispatcher,
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
      yield* Stream.runForEach(nextTurnQueueDispatcher.changes, (threadId) =>
        nextTurnQueueDispatcher.getSnapshot(threadId).pipe(
          Effect.flatMap((snapshot) =>
            pushBus.publishAll(WS_CHANNELS.nextTurnQueueUpdated, snapshot),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to publish next-turn queue snapshot", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ).pipe(Effect.forkIn(subscriptionsScope));
      yield* Stream.runForEach(nextTurnQueueDispatcher.summaryChanges, () =>
        nextTurnQueueDispatcher.getSummary.pipe(
          Effect.flatMap((summary) =>
            pushBus.publishAll(WS_CHANNELS.nextTurnQueueSummaryUpdated, summary),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to publish next-turn queue summary", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ).pipe(Effect.forkIn(subscriptionsScope));
      yield* Stream.runForEach(
        threadBackgroundWork.changes.pipe(
          Stream.throttle({
            cost: () => 1,
            units: 1,
            duration: Duration.millis(100),
            strategy: "enforce",
          }),
        ),
        () =>
          threadBackgroundWork.getSnapshot.pipe(
            Effect.flatMap((snapshot) =>
              pushBus.publishAll(AGENTS_WS_CHANNELS.snapshotUpdated, snapshot),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to publish background-work snapshot", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      ).pipe(Effect.forkIn(subscriptionsScope));

      yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
      yield* Scope.provide(providerSessionReaper.start(), subscriptionsScope);
      yield* Ref.set(nextTurnQueueDispatcherRef, nextTurnQueueDispatcher);
      yield* readiness.markOrchestrationSubscriptionsReady;
      yield* Deferred.succeed(orchestrationRuntime, {
        threadBackgroundWork,
        usageService,
        orchestrationEngine,
        providerCommandReactor,
        providerTurnDeliveryWorker,
        providerSessionDirectory,
        workflowService,
        codeReviewWorkflowService,
        investigationWorkflowService,
        projectSetupScriptRunner,
        storageMaintenance,
        nextTurnQueueDispatcher,
      }).pipe(Effect.orDie);

      // Fire-and-forget cleanup: clear stale `worktreePath` projections whose
      // directories have disappeared so polled git commands stop spamming
      // ENOENT against missing cwds. Errors are swallowed inside the helper;
      // failing cleanup must never block server startup.
      yield* cleanupStaleWorktrees(orchestrationEngine).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(subscriptionsScope),
      );
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Deferred.fail(
          orchestrationRuntime,
          new ServerLifecycleError({
            operation: "orchestrationRuntimeStart",
            cause,
          }),
        ).pipe(Effect.orDie);
        yield* Effect.logError("failed to start orchestration runtime", {
          causePretty: Cause.pretty(cause),
          cause,
        });
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
          message: formatServerLifecycleRouteFailure(error),
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

  const getNextTurnQueueSnapshot = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const dispatcher = yield* Ref.get(nextTurnQueueDispatcherRef);
      if (dispatcher !== null) {
        return yield* dispatcher.getSnapshot(threadId);
      }
      const data = yield* nextTurnQueueStore.listByThread(threadId);
      return {
        threadId,
        items: [...data.items],
        revision: data.state.revision,
        paused: data.state.paused,
        blockedKind: data.state.paused ? ("paused" as const) : ("waiting" as const),
        reasonCode: data.state.pauseReasonCode,
        reasonDetail: data.state.paused
          ? data.state.pauseDetail
          : "Waiting for the server to finish starting.",
        maxItems: 20,
        quarantinedCount: data.quarantinedCount,
      };
    });

  const publishNextTurnQueueSnapshot = (threadId: ThreadId) =>
    getNextTurnQueueSnapshot(threadId).pipe(
      Effect.flatMap((snapshot) => pushBus.publishAll(WS_CHANNELS.nextTurnQueueUpdated, snapshot)),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to publish next-turn queue snapshot", {
          threadId,
          causePretty: Cause.pretty(cause),
        }),
      ),
    );

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.terminalEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  const unsubscribePreviewEvents = previewManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.previewEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribePreviewEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;
  yield* Effect.sleep(Duration.seconds(5)).pipe(
    Effect.andThen(
      Effect.forever(
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const configuredSeconds = settings.prHub.pollIntervalSeconds;
          if (configuredSeconds === 0) {
            yield* serverSettings.streamChanges.pipe(
              Stream.filter((nextSettings) => nextSettings.prHub.pollIntervalSeconds !== 0),
              Stream.runHead,
            );
            return;
          }
          yield* prHub.refreshNow({ mode: "if_stale" }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("PR Hub refresh failed", {
                causePretty: Cause.pretty(cause),
              }),
            ),
          );
          yield* Effect.sleep(Duration.seconds(configuredSeconds));
        }),
      ),
    ),
    Effect.forkIn(subscriptionsScope),
  );

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
      case AGENTS_WS_METHODS.getSnapshot: {
        const { threadBackgroundWork } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* threadBackgroundWork.getSnapshot.pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: `Unable to load background work: ${error.message}`,
              }),
          ),
        );
      }

      case USAGE_WS_METHODS.getSummary: {
        const { usageService } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* usageService.getSummary(stripRequestTag(request.body)).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: `Unable to load usage: ${error.message}`,
              }),
          ),
        );
      }

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
            activityCount: result.activities.length,
            hasOlderMessages: result.hasOlderMessages,
            hasOlderCheckpoints: result.hasOlderCheckpoints,
            hasOlderActivities: result.hasOlderActivities,
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
            activityCount: result.activities.length,
            hasOlderMessages: result.hasOlderMessages,
            hasOlderCheckpoints: result.hasOlderCheckpoints,
            hasOlderActivities: result.hasOlderActivities,
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
          }).pipe(
            Effect.tapError((error) =>
              error._tag !== "GitCommandError" && isDefinitelyUncommittedDispatchError(error)
                ? removePersistedTurnAttachments(normalizedCommand)
                : Effect.void,
            ),
          );
        }
        if (normalizedCommand.type === "thread.turn.start") {
          yield* removePersistedTurnAttachments(normalizedCommand);
          return yield* new RouteRequestError({
            code: "NextTurnQueueAdmissionRequired",
            message:
              "Established-thread turns must be submitted through nextTurnQueue.submit so ordering is enforced by the server.",
          });
        }
        const result = yield* orchestrationEngine.dispatch(normalizedCommand);
        if (
          normalizedCommand.type === "thread.checkpoint.revert" ||
          normalizedCommand.type === "thread.compact.request"
        ) {
          const reason =
            normalizedCommand.type === "thread.checkpoint.revert"
              ? "Queue paused because the thread was reverted."
              : "Queue paused because the thread was compacted.";
          yield* nextTurnQueueStore.setPaused({
            threadId: normalizedCommand.threadId,
            paused: true,
            reasonCode:
              normalizedCommand.type === "thread.checkpoint.revert"
                ? "thread_reverted"
                : "thread_compacted",
            detail: reason,
          });
          yield* publishNextTurnQueueSnapshot(normalizedCommand.threadId);
        }
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

      case ORCHESTRATION_WS_METHODS.createInvestigationWorkflow: {
        const { investigationWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        const workflowId = yield* investigationWorkflowService.createWorkflow(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to create investigation workflow: ${String(cause)}`,
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

      case ORCHESTRATION_WS_METHODS.archiveInvestigationWorkflow: {
        const { investigationWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* investigationWorkflowService.archiveWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to archive investigation workflow: ${String(cause)}`,
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

      case ORCHESTRATION_WS_METHODS.unarchiveInvestigationWorkflow: {
        const { investigationWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* investigationWorkflowService.unarchiveWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to unarchive investigation workflow: ${String(cause)}`,
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

      case ORCHESTRATION_WS_METHODS.deleteInvestigationWorkflow: {
        const { investigationWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* investigationWorkflowService.deleteWorkflow(body.workflowId).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to delete investigation workflow: ${String(cause)}`,
              }),
          ),
        );
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.retryWorkflow: {
        const { workflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        return yield* workflowService.retryWorkflow(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to retry workflow: ${String(cause)}`,
              }),
          ),
        );
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

      case ORCHESTRATION_WS_METHODS.retryInvestigationWorkflow: {
        const { investigationWorkflowService } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* investigationWorkflowService.retryWorkflow(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to retry investigation workflow: ${String(cause)}`,
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
            ...(body.providerOptions ? { providerOptions: body.providerOptions } : {}),
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

      case WS_METHODS.projectsListEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list workspace entries: ${String(cause)}`,
            }),
        });
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

      case WS_METHODS.projectsGetCheckedInConfig: {
        const body = stripRequestTag(request.body);
        const snapshot = yield* projectionReadModelQuery.getSnapshot();
        if (
          !snapshot.projects.some(
            (project) => project.id === body.projectId && project.deletedAt === null,
          )
        ) {
          return yield* new RouteRequestError({ message: "Project is unavailable." });
        }
        return yield* Effect.tryPromise({
          try: () => checkedInProjectFileService.load(body.projectId),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to load checked-in project configuration: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsSearchContents: {
        const body = stripRequestTag(request.body);
        const snapshot = yield* projectionReadModelQuery.getSnapshot();
        const project = snapshot.projects.find(
          (candidate) => candidate.id === body.projectId && candidate.deletedAt === null,
        );
        if (!project) {
          return yield* new RouteRequestError({
            message: "Project content search target is unavailable.",
          });
        }
        const thread = body.threadId
          ? snapshot.threads.find(
              (candidate) =>
                candidate.id === body.threadId &&
                candidate.projectId === body.projectId &&
                candidate.deletedAt === null,
            )
          : null;
        if (body.threadId && !thread) {
          return yield* new RouteRequestError({
            message: "Project content search target is unavailable.",
          });
        }
        const workspaceRoot = thread?.worktreePath ?? project.workspaceRoot;
        let searches = activeContentSearchesByClient.get(ws);
        if (!searches) {
          searches = new Map();
          activeContentSearchesByClient.set(ws, searches);
        }
        const previousKey = searches.get(body.requestId);
        if (previousKey) {
          yield* Effect.promise(() => projectContentSearchManager.cancel(previousKey));
        }
        const requestKey = `content-search-${nextContentSearchKey++}`;
        searches.set(body.requestId, requestKey);
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              return await projectContentSearchManager.search({
                requestKey,
                workspaceRoot,
                request: body,
              });
            } finally {
              if (searches?.get(body.requestId) === requestKey) {
                searches.delete(body.requestId);
              }
            }
          },
          catch: () =>
            new RouteRequestError({
              message: "Project content search failed.",
            }),
        });
      }

      case WS_METHODS.projectsCancelContentSearch: {
        const body = stripRequestTag(request.body);
        const searches = activeContentSearchesByClient.get(ws);
        const requestKey = searches?.get(body.requestId);
        if (!requestKey) return { cancelled: false };
        searches?.delete(body.requestId);
        return {
          cancelled: yield* Effect.promise(() => projectContentSearchManager.cancel(requestKey)),
        };
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
          fileSystem,
        });
        const targetStatResult = yield* Effect.exit(fileSystem.stat(target.absolutePath));
        if (body.expectedContentSha256) {
          if (
            Exit.isFailure(targetStatResult) ||
            targetStatResult.value.type === "Directory" ||
            Number(targetStatResult.value.size) > PROJECT_READ_FILE_MAX_SIZE
          ) {
            return yield* new RouteRequestError({
              message: `Workspace file changed before save: ${target.relativePath}. Reload file before saving.`,
            });
          }
          const existingBytes = yield* fileSystem.readFile(target.absolutePath).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Workspace file changed before save: ${target.relativePath}. Reload file before saving.`,
                }),
            ),
          );
          const existingHash = sha256Hex(existingBytes);
          if (existingHash !== body.expectedContentSha256) {
            return yield* new RouteRequestError({
              message: `Workspace file changed before save: ${target.relativePath}. Reload file before saving.`,
            });
          }
        }
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
        clearWorkspaceIndexCache(body.cwd, {
          destroySearchIndex:
            Exit.isFailure(targetStatResult) || targetStatResult.value.type !== "File",
        });
        const writtenBytes = Buffer.from(body.contents, "utf8");
        return {
          relativePath: target.relativePath,
          byteLength: writtenBytes.byteLength,
          contentSha256: sha256Hex(writtenBytes),
        };
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
        const byteLength = Number(stat.size);
        const truncated = byteLength > PROJECT_READ_FILE_MAX_SIZE;
        const rawBytes = truncated
          ? yield* readFilePrefix(target.absolutePath, PROJECT_READ_FILE_MAX_SIZE)
          : yield* fileSystem
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
          try: () => new TextDecoder("utf-8", { fatal: !truncated }).decode(rawBytes),
          catch: () =>
            new RouteRequestError({
              message: `Binary file cannot be displayed: ${target.relativePath}`,
            }),
        });
        return {
          relativePath: target.relativePath,
          contents,
          byteLength,
          truncated,
          ...(truncated ? {} : { contentSha256: sha256Hex(rawBytes) }),
        };
      }

      case WS_METHODS.projectsAuthorizeEntry: {
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
        if (stat.type !== "File" && stat.type !== "Directory") {
          return yield* new RouteRequestError({
            message: `Unsupported workspace entry type: ${target.relativePath}`,
          });
        }
        const kind = stat.type === "Directory" ? ("directory" as const) : ("file" as const);
        if (body.kind !== undefined && body.kind !== kind) {
          return yield* new RouteRequestError({
            message: `Workspace entry type changed: ${target.relativePath}`,
          });
        }
        return { relativePath: target.relativePath, kind };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.shellRevealInFileManager: {
        const body = stripRequestTag(request.body);
        return yield* revealInFileManager(body.path);
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

      case WS_METHODS.reviewPreviewDiff: {
        const body = stripRequestTag(request.body);
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForBootstrap;
        const readModel = yield* orchestrationEngine.getReadModel();
        return yield* getReviewPreviewDiff({ request: body, readModel });
      }

      case PR_HUB_WS_METHODS.getSnapshot:
        return yield* prHub.getSnapshot;

      case PR_HUB_WS_METHODS.refresh: {
        const body = stripRequestTag(request.body);
        return yield* prHub.refreshNow(body);
      }

      case PR_HUB_WS_METHODS.approve: {
        const body = stripRequestTag(request.body);
        return yield* prHub.approve(body);
      }

      case PR_HUB_WS_METHODS.requestChanges: {
        const body = stripRequestTag(request.body);
        return yield* prHub.requestChanges(body);
      }

      case PR_HUB_WS_METHODS.comment: {
        const body = stripRequestTag(request.body);
        return yield* prHub.comment(body);
      }

      case PR_HUB_WS_METHODS.merge: {
        const body = stripRequestTag(request.body);
        return yield* prHub.merge(body);
      }

      case PR_HUB_WS_METHODS.markReady: {
        const body = stripRequestTag(request.body);
        return yield* prHub.markReady(body);
      }

      case PR_HUB_WS_METHODS.reRequestReview: {
        const body = stripRequestTag(request.body);
        return yield* prHub.reRequestReview(body);
      }

      case PR_HUB_WS_METHODS.snooze: {
        const body = stripRequestTag(request.body);
        return yield* prHub.snooze(body);
      }

      case PR_HUB_WS_METHODS.unsnooze: {
        const body = stripRequestTag(request.body);
        return yield* prHub.unsnooze(body);
      }

      case PR_HUB_WS_METHODS.ignore: {
        const body = stripRequestTag(request.body);
        return yield* prHub.ignore(body);
      }

      case PR_HUB_WS_METHODS.markSeen: {
        const body = stripRequestTag(request.body);
        return yield* prHub.markSeen(body);
      }

      case PR_HUB_WS_METHODS.markNotified: {
        const body = stripRequestTag(request.body);
        return yield* prHub.markNotified(body);
      }

      case PR_HUB_WS_METHODS.analyzeAdvisories: {
        const body = stripRequestTag(request.body);
        return yield* prHubAdvisory.analyzeAdvisories(body);
      }

      case PR_HUB_WS_METHODS.getAdvisories: {
        const body = stripRequestTag(request.body);
        return yield* prHubAdvisory.getAdvisories(body);
      }

      case PR_HUB_WS_METHODS.listLocalCheckoutCandidates: {
        const body = stripRequestTag(request.body);
        return yield* prHub.listLocalCheckoutCandidates(body);
      }

      case PR_HUB_WS_METHODS.getDetail: {
        const body = stripRequestTag(request.body);
        return yield* prHub.getDetail(body);
      }

      case PR_HUB_WS_METHODS.getTimeline: {
        const body = stripRequestTag(request.body);
        return yield* prHub.getTimeline(body);
      }

      case PR_HUB_WS_METHODS.getFiles: {
        const body = stripRequestTag(request.body);
        return yield* prHub.getFiles(body);
      }

      case PR_HUB_WS_METHODS.updateComment: {
        const body = stripRequestTag(request.body);
        return yield* prHub.updateComment(body);
      }

      case PR_HUB_WS_METHODS.setReaction: {
        const body = stripRequestTag(request.body);
        return yield* prHub.setReaction(body);
      }

      case PR_HUB_WS_METHODS.changeReviewers: {
        const body = stripRequestTag(request.body);
        return yield* prHub.changeReviewers(body);
      }

      case PR_HUB_WS_METHODS.updateBranch: {
        const body = stripRequestTag(request.body);
        return yield* prHub.updateBranch(body);
      }

      case PR_HUB_WS_METHODS.clearData:
        return yield* prHub.clearData();

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

      case WS_METHODS.previewOpen: {
        const body = stripRequestTag(request.body);
        return yield* previewManager.open(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.previewNavigate: {
        const body = stripRequestTag(request.body);
        return yield* previewManager.navigate(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.previewReportStatus: {
        const body = stripRequestTag(request.body);
        return yield* previewManager.reportStatus(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.previewReportRecordingMetrics: {
        const body = stripRequestTag(request.body);
        yield* increment(previewRecordingFramesDroppedTotal, {}, body.droppedFrames);
        return undefined;
      }

      case WS_METHODS.previewRefresh: {
        const body = stripRequestTag(request.body);
        return yield* previewManager.refresh(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.previewClose: {
        const body = stripRequestTag(request.body);
        return yield* previewManager.close(body).pipe(
          Effect.tap(() => previewAutomationBroker.clearTargets(body.threadId, body.tabId)),
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.previewList: {
        const body = stripRequestTag(request.body);
        return yield* previewManager.list(body);
      }

      case WS_METHODS.previewListLocalServers: {
        const servers = yield* Effect.tryPromise({
          try: () => scanLocalServers(),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to discover local servers: ${String(cause)}`,
            }),
        });
        const result = { servers, scannedAt: new Date().toISOString() };
        yield* pushBus.publishClient(ws, WS_CHANNELS.previewLocalServersUpdated, result);
        return result;
      }

      case WS_METHODS.previewAutomationReportOwner: {
        const body = stripRequestTag(request.body);
        const clientId = getServerPreviewAutomationClientId(ws, body.clientId);
        if (!body.supportsAutomation) {
          yield* previewAutomationBroker.clearOwner(clientId, body.connectionId);
          return {
            clientId: body.clientId,
            connectionId: body.connectionId ?? "preview-disabled",
            leaseExpiresAt: new Date().toISOString(),
          };
        }
        if (body.tabId) {
          const previewList = yield* previewManager.list({ threadId: body.threadId });
          const ownsTab = previewList.sessions.some((session) => session.tabId === body.tabId);
          if (!ownsTab) {
            yield* previewAutomationBroker.clearOwner(clientId, body.connectionId);
            return {
              clientId: body.clientId,
              connectionId: body.connectionId ?? "preview-invalid-tab",
              leaseExpiresAt: new Date().toISOString(),
            };
          }
        }
        return yield* previewAutomationBroker.reportOwner(
          {
            ...body,
            clientId,
            supportsAutomation: true,
            focusedAt: new Date().toISOString(),
          },
          {
            clientId,
            rendererClientId: body.clientId,
            send: (automationRequest) =>
              pushBus.publishClient(ws, WS_CHANNELS.previewAutomationRequest, automationRequest),
          },
        );
      }

      case WS_METHODS.previewAutomationClearOwner: {
        const body = stripRequestTag(request.body);
        const clientIds = previewAutomationClientIdsByWs.get(ws);
        const serverClientId = clientIds?.get(body.clientId);
        if (serverClientId) {
          yield* previewAutomationBroker.clearOwner(serverClientId, body.connectionId);
          clientIds?.delete(body.clientId);
        }
        return undefined;
      }

      case WS_METHODS.previewAutomationRespond: {
        const body = stripRequestTag(request.body);
        yield* previewAutomationBroker.respond(body, authorizedPreviewAutomationClientIds(ws));
        return undefined;
      }

      case WS_METHODS.serverProbe:
        return {};

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providers = yield* providerAdvisoryProjection.getProviders;
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.map(redactServerSettingsForClient),
        );
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          customKeybindings: keybindingsConfig.customKeybindings,
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
        yield* providerRegistry.refresh();
        yield* providerUpdateAdvisor.refreshAdvisories({ force: true }).pipe(Effect.forkChild);
        const providers = yield* providerAdvisoryProjection.getProviders;
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
        return keybindingsConfig;
      }

      case WS_METHODS.serverAddKeybinding: {
        const body = stripRequestTag(request.body);
        return yield* keybindingsManager.addKeybindingRule(body.rule).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.serverUpdateKeybinding: {
        const body = stripRequestTag(request.body);
        return yield* keybindingsManager.updateKeybindingRule(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.serverRemoveKeybinding: {
        const body = stripRequestTag(request.body);
        return yield* keybindingsManager.removeKeybindingRule(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.serverResetKeybindings: {
        return yield* keybindingsManager.resetKeybindingRules.pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.storageGetUsage: {
        const { storageMaintenance } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        return yield* storageMaintenance.inspect(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
      }

      case WS_METHODS.storageCleanup: {
        const { storageMaintenance } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        const publishProgress = (event: StorageCleanupProgressPayload) =>
          pushBus.publishClient(ws, WS_CHANNELS.storageCleanupProgress, event).pipe(Effect.asVoid);
        const result = yield* storageMaintenance.cleanup(body, { publishProgress }).pipe(
          Effect.tap(() =>
            pushBus.publishAll(WS_CHANNELS.storageInvalidated, {
              reason: "cleanup-completed",
              operationId: body.operationId,
            }),
          ),
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
              }),
          ),
        );
        return result;
      }

      case WS_METHODS.storageCancelCleanup: {
        const { storageMaintenance } = yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        yield* storageMaintenance.cancel(body.operationId);
        return undefined;
      }

      case WS_METHODS.nextTurnQueueList: {
        const body = stripRequestTag(request.body);
        return yield* getNextTurnQueueSnapshot(body.threadId).pipe(
          Effect.mapError(mapNextTurnQueueRouteError),
        );
      }

      case WS_METHODS.nextTurnQueueSummary:
        return yield* nextTurnQueueStore.summary.pipe(Effect.mapError(mapNextTurnQueueRouteError));

      case WS_METHODS.nextTurnQueueSubmit: {
        const body = stripRequestTag(request.body);
        if (body.command.bootstrap !== undefined) {
          return yield* new RouteRequestError({
            message: "Queued turns require an existing thread and cannot contain bootstrap work.",
            code: "NextTurnQueueBootstrapNotAllowedError",
          });
        }
        const requestHash = canonicalRequestHash(body.command);
        const existingSubmission = yield* nextTurnQueueStore
          .getBySubmissionId(body.submissionId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        if (existingSubmission !== null) {
          if (existingSubmission.requestHash !== requestHash) {
            return yield* mapNextTurnQueueRouteError(
              new NextTurnQueueIdempotencyConflictError({
                message: "That send identifier was already used for different content.",
              }),
            );
          }
          if (existingSubmission.disposition === "started") {
            return {
              disposition: "started" as const,
              submissionId: body.submissionId,
              sequence: existingSubmission.resultSequence ?? 0,
            };
          }
          if (
            existingSubmission.disposition === "canceled" ||
            existingSubmission.disposition === "cleared" ||
            existingSubmission.disposition === "rejected"
          ) {
            return {
              disposition: existingSubmission.disposition,
              submissionId: body.submissionId,
              reasonCode: existingSubmission.reasonCode ?? existingSubmission.disposition,
            };
          }
          if (existingSubmission.itemId !== null) {
            if (existingSubmission.disposition === "pending" && body.intent === "auto") {
              return yield* nextTurnQueueDispatcher
                .submitAndSettle({
                  threadId: existingSubmission.threadId,
                  itemId: existingSubmission.itemId,
                  submissionId: body.submissionId,
                })
                .pipe(Effect.mapError(mapNextTurnQueueRouteError));
            }
            return {
              disposition: "queued" as const,
              submissionId: body.submissionId,
              itemId: existingSubmission.itemId,
              snapshot: yield* nextTurnQueueDispatcher
                .getSnapshot(existingSubmission.threadId)
                .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
            };
          }
        }
        const command = yield* normalizeDispatchCommand({ command: body.command });
        if (command.type !== "thread.turn.start") {
          return yield* new RouteRequestError({
            message: "Only thread turn-start commands can be queued.",
          });
        }
        const itemId = CommandId.makeUnsafe(crypto.randomUUID());
        const inserted = yield* nextTurnQueueStore
          .insertSubmission({
            submissionId: body.submissionId,
            requestHash,
            itemId,
            command,
            atHead: body.intent === "queue-head",
          })
          .pipe(
            Effect.tapError(() => removePersistedTurnAttachments(command)),
            Effect.mapError(mapNextTurnQueueRouteError),
          );
        if (inserted.kind === "replay") {
          // A concurrent request may have normalized a second, independently-id'd
          // attachment set before the winning ledger transaction committed.
          // The ledger result is authoritative; discard this request's ingress files.
          yield* removePersistedTurnAttachments(command);
          const replayItemId = inserted.submission.itemId ?? itemId;
          if (body.intent === "auto") {
            return yield* nextTurnQueueDispatcher
              .submitAndSettle({
                threadId: inserted.submission.threadId,
                itemId: replayItemId,
                submissionId: body.submissionId,
              })
              .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          }
          return {
            disposition: "queued" as const,
            submissionId: body.submissionId,
            itemId: replayItemId,
            snapshot: yield* nextTurnQueueDispatcher
              .getSnapshot(inserted.submission.threadId)
              .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
          };
        }
        const result =
          body.intent === "auto"
            ? yield* nextTurnQueueDispatcher
                .submitAndSettle({
                  threadId: command.threadId,
                  itemId,
                  submissionId: body.submissionId,
                })
                .pipe(Effect.mapError(mapNextTurnQueueRouteError))
            : {
                disposition: "queued" as const,
                submissionId: body.submissionId,
                itemId,
                snapshot: yield* nextTurnQueueDispatcher
                  .getSnapshot(command.threadId)
                  .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
              };
        yield* nextTurnQueueStore
          .settleSubmission({ submissionId: body.submissionId, result })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        yield* nextTurnQueueDispatcher.notify(command.threadId);
        return result;
      }

      case WS_METHODS.nextTurnQueueUpdate: {
        const body = stripRequestTag(request.body);
        const item = yield* nextTurnQueueStore
          .updateCommand({
            itemId: body.itemId,
            expectedUpdatedAt: body.expectedUpdatedAt,
            update: (command) => {
              const { skillCall: currentSkillCall, ...messageWithoutSkillCall } = command.message;
              return {
                ...command,
                ...(body.provider !== undefined ? { provider: body.provider } : {}),
                ...(body.model !== undefined ? { model: body.model } : {}),
                ...(body.modelSelection !== undefined
                  ? { modelSelection: body.modelSelection }
                  : {}),
                ...(body.modelOptions !== undefined ? { modelOptions: body.modelOptions } : {}),
                ...(body.runtimeMode !== undefined ? { runtimeMode: body.runtimeMode } : {}),
                ...(body.interactionMode !== undefined
                  ? { interactionMode: body.interactionMode }
                  : {}),
                message: {
                  ...messageWithoutSkillCall,
                  ...(body.text !== undefined ? { text: body.text } : {}),
                  ...(body.skillCall === undefined
                    ? currentSkillCall === undefined
                      ? {}
                      : { skillCall: currentSkillCall }
                    : body.skillCall === null
                      ? {}
                      : { skillCall: body.skillCall }),
                },
              };
            },
          })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        yield* (yield* awaitOrchestrationRuntimeForRoute).nextTurnQueueDispatcher.notify(
          item.threadId,
        );
        return yield* getNextTurnQueueSnapshot(item.threadId).pipe(
          Effect.mapError(mapNextTurnQueueRouteError),
        );
      }

      case WS_METHODS.nextTurnQueueCancel: {
        const body = stripRequestTag(request.body);
        const removed = yield* nextTurnQueueStore
          .softDelete(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(removed.threadId);
        return {
          snapshot: yield* nextTurnQueueDispatcher
            .getSnapshot(removed.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
          removed: [removed],
        };
      }

      case WS_METHODS.nextTurnQueueReorder: {
        const body = stripRequestTag(request.body);
        yield* nextTurnQueueStore
          .replacePositions(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(body.threadId);
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueRetry: {
        const body = stripRequestTag(request.body);
        const item = yield* nextTurnQueueStore
          .retry(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(item.threadId);
        return yield* nextTurnQueueDispatcher
          .getSnapshot(item.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueuePromote: {
        const body = stripRequestTag(request.body);
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* nextTurnQueueDispatcher
          .promote(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueSetPaused: {
        const body = stripRequestTag(request.body);
        yield* nextTurnQueueStore
          .setPaused({
            threadId: body.threadId,
            paused: body.paused,
            reasonCode: body.paused ? "manual_pause" : null,
            expectedRevision: body.expectedRevision,
          })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(body.threadId);
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueDuplicate: {
        const body = stripRequestTag(request.body);
        const item = yield* nextTurnQueueStore
          .duplicate(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(item.threadId);
        return yield* nextTurnQueueDispatcher
          .getSnapshot(item.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueRefreshGate: {
        const body = stripRequestTag(request.body);
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* nextTurnQueueDispatcher
          .refreshGate(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueClear: {
        const body = stripRequestTag(request.body);
        const removed = yield* nextTurnQueueStore
          .clear(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(body.threadId);
        return {
          snapshot: yield* nextTurnQueueDispatcher
            .getSnapshot(body.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
          removed: [...removed],
        };
      }

      case WS_METHODS.nextTurnQueueRestore: {
        const body = stripRequestTag(request.body);
        const restored = yield* nextTurnQueueStore
          .restore(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        yield* nextTurnQueueDispatcher.notify(body.threadId);
        return {
          snapshot: yield* nextTurnQueueDispatcher
            .getSnapshot(body.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
          removed: [...restored],
        };
      }

      case WS_METHODS.nextTurnQueueRecheckDelivery: {
        const body = stripRequestTag(request.body);
        const { providerTurnDeliveryWorker, nextTurnQueueDispatcher } =
          yield* awaitOrchestrationRuntimeForRoute;
        const delivery = yield* providerTurnDeliveryWorker.recheck(body.threadId).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                code: "NextTurnQueueDeliveryRecoveryError",
                message: error.message,
              }),
          ),
        );
        if (delivery?.state === "accepted") {
          yield* nextTurnQueueDispatcher
            .handleDeliveryOutcome({
              deliveryId: delivery.deliveryId,
              commandId: delivery.commandId,
              threadId: delivery.threadId,
              state: "accepted",
              detail: null,
            })
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          yield* providerTurnDeliveryWorker.acknowledgeOutcome(delivery.deliveryId).pipe(
            Effect.mapError(
              (error) =>
                new RouteRequestError({
                  code: "NextTurnQueueDeliveryRecoveryError",
                  message: error.message,
                }),
            ),
          );
        }
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueRetryDelivery: {
        const body = stripRequestTag(request.body);
        const { providerTurnDeliveryWorker, nextTurnQueueDispatcher } =
          yield* awaitOrchestrationRuntimeForRoute;
        const delivery = yield* providerTurnDeliveryWorker.retry(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                code: "NextTurnQueueDeliveryRecoveryError",
                message: error.message,
              }),
          ),
        );
        yield* nextTurnQueueStore
          .retryDelivery({ commandId: delivery.commandId })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        yield* nextTurnQueueStore
          .setPaused({ threadId: body.threadId, paused: false })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        yield* nextTurnQueueDispatcher.notify(body.threadId);
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueDiscardDelivery: {
        const body = stripRequestTag(request.body);
        const { providerTurnDeliveryWorker, nextTurnQueueDispatcher } =
          yield* awaitOrchestrationRuntimeForRoute;
        const delivery = yield* providerTurnDeliveryWorker.discard(body.threadId).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                code: "NextTurnQueueDeliveryRecoveryError",
                message: error.message,
              }),
          ),
        );
        yield* nextTurnQueueStore
          .discardDelivery({ commandId: delivery.commandId })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        yield* nextTurnQueueDispatcher.notify(body.threadId);
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.globalSearchQuery: {
        const body = stripRequestTag(request.body);
        return yield* globalSearch.query(body).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: `Search failed: ${error.message}`,
              }),
          ),
        );
      }

      case WS_METHODS.workflowPlatformListTemplates:
        return { templates: BUILTIN_WORKFLOW_TEMPLATES };

      case WS_METHODS.workflowPlatformCreateRun: {
        const { workflowService, codeReviewWorkflowService, investigationWorkflowService } =
          yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body) as WorkflowPlatformCreateRunInput;
        return yield* createWorkflowPlatformRun(body, {
          planning: workflowService,
          codeReview: codeReviewWorkflowService,
          investigation: investigationWorkflowService,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({ message: `Failed to create workflow run: ${String(cause)}` }),
          ),
        );
      }

      case WS_METHODS.workflowPlatformInspectRun: {
        const body = stripRequestTag(request.body);
        const snapshot = yield* projectionReadModelQuery.getSnapshot();
        return yield* Effect.try({
          try: () => ({ inspection: inspectWorkflowPlatformRun(body, snapshot) }),
          catch: (cause) =>
            new RouteRequestError({ message: `Failed to inspect workflow run: ${String(cause)}` }),
        });
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
        Effect.flatMap((encodedResponse) => webSocketSendController.send(ws, encodedResponse)),
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
        error: formatRouteFailure(result.cause),
      });
    }

    return yield* sendWsResponse({
      id: request.success.id,
      result: result.value,
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://localhost:${port}`);
    } catch {
      rejectUpgrade(socket, 400, "Invalid WebSocket URL");
      return;
    }

    if (!serverAuth.isWebSocketOriginAllowed(request)) {
      rejectUpgrade(socket, 403, "WebSocket origin is not allowed");
      return;
    }

    if (!serverAuth.isWebSocketRequestAuthenticated(request, url)) {
      rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    logger.info("websocket transport negotiated", {
      runtime: webSocketRuntimeName(),
      extensions: ws.extensions.length > 0 ? ws.extensions : "none",
      compression: ws.extensions.includes("permessage-deflate") ? "enabled" : "disabled",
    });
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
      const activeContentSearches = activeContentSearchesByClient.get(ws);
      activeContentSearchesByClient.delete(ws);
      if (activeContentSearches) {
        for (const requestKey of activeContentSearches.values()) {
          void projectContentSearchManager.cancel(requestKey);
        }
      }
      void runPromise(
        increment(websocketConnectionsTotal, {
          event: "disconnect",
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const clientIds = previewAutomationClientIdsByWs.get(ws);
              if (!clientIds) return;
              previewAutomationClientIdsByWs.delete(ws);
              yield* Effect.forEach(
                clientIds.values(),
                (clientId) => previewAutomationBroker.clearOwner(clientId),
                { discard: true },
              );
            }),
          ),
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
