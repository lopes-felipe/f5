import { timeOrderedUuid } from "@t3tools/shared/ids";
import { AgentSessionScanner } from "./project/AgentSessionScanner";
import {
  importAgentSessionProject,
  resolveAgentSessionHomes,
} from "./project/AgentSessionImporter";
import { startKeepAwake } from "./background/KeepAwake";
import { bindSubmissionTurnIds } from "./nextTurnQueue/submissionStatus.ts";
import { cancelQueuedSubmission } from "./nextTurnQueue/cancelSubmission.ts";
import { makeScheduledNotificationDelivery } from "./scheduledTasks/notificationDelivery.ts";
import { resolveTemporaryWorktreeBranch } from "./git/temporaryWorktreeBranch.ts";
import { parseNaturalLanguageSchedule } from "./scheduledTasks/naturalLanguage.ts";
import { TURN_SUBMISSION_FAILURES } from "./TurnSubmissionError.ts";
import { makeTurnSubmissionService } from "./TurnSubmissionService.ts";
import { RouteRequestError, mapNextTurnQueueRouteError } from "./turnSubmissionErrors.ts";
import { makeScheduledTaskService } from "./scheduledTasks/Service.ts";
import { makeScheduledTaskStore, scheduleError } from "./scheduledTasks/Store.ts";
import { McpAppService } from "./mcpApps/McpAppService.ts";
import { ThreadSettlementService } from "./orchestration/Layers/ThreadSettlementService.ts";
import { makeTurnGitStatusRefresh } from "./wsServer/turnGitStatusRefresh";
import { THREAD_SETTLEMENT_WS_METHODS } from "@t3tools/contracts";
import { PullRequestWatchService } from "./orchestration/Layers/PullRequestWatchService.ts";
import { PR_WATCH_CHANGED_CHANNEL } from "@t3tools/contracts";
import { makeHtmlPreviewBroker } from "./htmlRender/HtmlPreviewBroker.ts";
import { makeHtmlRenderRuntime } from "./htmlRender/HtmlRenderRuntime.ts";
import { ThreadMcpBroker } from "./mcp/threadMcpTools.ts";
import { makeThreadToolHandler } from "./mcp/threadToolRuntime.ts";
import { makePullRequestMcpHandler } from "./mcp/pullRequestMcpRuntime";
import { makeThreadImagePublisher } from "./mcp/publishThreadImage.ts";
import { ProjectionThreadMessageRepositoryLive } from "./persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadMessageRepository } from "./persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "./persistence/Services/ProjectionThreadProposedPlans.ts";
import { PrHubFederation } from "./prHub/Layers/PrHubFederation.ts";
import { PrHubReviewGuideService } from "./prHub/Layers/PrHubReviewGuideService.ts";
import { registerShutdown, ServerShutdown } from "./shutdown.ts";
import { makeSocketLiveness, closeSocketsWithin } from "./wsServer/socketLiveness.ts";
import { makeClientDiagnosticsReporter } from "./observability/clientDiagnostics.ts";
import { withProviderThreadAccess } from "./provider/providerThreadAccess.ts";
import { makeMcpSecretWriter } from "./mcp/McpSecretWriter.ts";
import { makeMcpAccountExecutionResolver } from "./mcp/accountExecution.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationOverloadError,
} from "./orchestration/Errors.ts";
import {
  WorkspaceRequiresNewWorktreeError,
  type GitWorkspaceSwitchHandler,
} from "./git/workspaceSwitch.ts";
import { inspectAttachableWorkspace, isProjectCheckout } from "./project/workspaceAttachment.ts";
import { discoverSourceControlProviderIdentities } from "./sourceControl/discovery.ts";
import {
  initializeNewProject,
  projectFolderSlug,
  reserveProjectFolder,
  resolveProjectsRoot,
} from "./project/createNewProject.ts";
import {
  prepareScratchRoot,
  scratchProjectIdFor,
  scratchRootFor,
  scratchWorkspaceRefusal,
} from "./project/scratchProject.ts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { answerMessageIdFor } from "@t3tools/shared/answerDelivery";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import {
  captureOptionalClaimServices,
  formatInPlaceSwitchBlockers,
  inPlaceSwitchBlockers,
  readWorktreeClaims,
} from "./project/worktreeClaims.ts";
import {
  pathContains,
  withRepositoryLifecycleLock,
} from "./project/Layers/WorktreeLifecycleCoordinator.ts";
import { GitHubCli } from "./git/Services/GitHubCli.ts";
import { GitService } from "./git/Services/GitService.ts";
import { TextGeneration } from "./git/Services/TextGeneration.ts";
import { makeUpstreamGit } from "./upstreamPorts/git.ts";
import { makeUpstreamGitHub } from "./upstreamPorts/github.ts";
import { makeUpstreamPortsService, UpstreamPortsError } from "./upstreamPorts/service.ts";
import { makeUpstreamStore } from "./upstreamPorts/store.ts";
import {
  assertExclusiveProfileCheckout,
  assertNotOtherProfileManagedCheckout,
} from "./profiles/RepositorySharing.ts";
import {
  WorkspaceTransition,
  type WorkspaceTransitionShape,
} from "./project/Services/WorkspaceTransition.ts";
import { WorktreePreparations } from "./persistence/Services/WorktreePreparations.ts";
import { WorktreePreparationsLive } from "./persistence/Layers/WorktreePreparations.ts";
import {
  WorktreePreparation,
  type WorktreePreparationShape,
} from "./project/Services/WorktreePreparation.ts";
import { removeWorktreeSafely } from "./project/worktreeClaims.ts";
import { WorktreeManager, type WorktreeManagerShape } from "./project/Services/WorktreeManager.ts";
import { canonicalWorktreePath, isTemporaryWorktreeBranch } from "./git/worktreePaths.ts";
import { WorkspaceWriteContext } from "./project/workspaceTransitionContext.ts";
import { followsCheckoutBranchAtTurnEnd } from "./project/worktreeReadiness.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects";
import {
  ProjectSkillSyncService,
  type ProjectSkillSyncServiceShape,
} from "./orchestration/Services/ProjectSkillSyncService.ts";
import { startScheduledBackups } from "./storage/scheduledBackups.ts";
import { startDatabaseSnapshots } from "./storage/databaseSnapshots.ts";
import { startDatabaseDamageTripwire } from "./storage/databaseDamageTripwire.ts";
import { getDatabaseDamage } from "./persistence/databaseHealth.ts";
import { rpcBusyTotal, rpcServerStartingTotal } from "./observability/Metrics";
import { rpcLane, RpcAdmission, rpcRequiresRuntime } from "@t3tools/shared/rpcScheduling";
import { writeWorkspaceFile } from "./WorkspaceFileWriter";
import { WorkspaceWatchRegistry } from "./workspaceWatch";
import {
  agentComputerUsePush,
  ComputerAutomationBroker,
} from "./computer/ComputerAutomationBroker";
import { reconcileChromeSessionSetups } from "./provider/chromeSessionRuntimeFactory";
import { finishAcknowledgedNativeRewind } from "./orchestration/nativeRewindAcknowledgement.ts";
import { readThreadPeek, readThreadPeeks } from "./orchestration/threadPeek.ts";
import { ProviderValidationError } from "./provider/Errors.ts";
import { NATIVE_OPERATION_WS_METHODS, ThreadId as NativeForkThreadId } from "@t3tools/contracts";
import {
  getClaudeTranscriptMaintenance,
  runClaudeTranscriptMaintenance,
  claudeMaintenanceErrorMessage,
} from "./maintenance/ClaudeTranscriptMaintenance.ts";
import { readAgentTranscript } from "./provider/agentTranscript/readAgentTranscript.ts";
import { stampSubmissionSource } from "./provider/submissionProvenance.ts";
import { AgentBridgeHostError, type AgentBridgeHostShape } from "./agentBridge/AgentBridgeHost.ts";
import {
  agentBridgeStdioSetups,
  makeAgentBridgeService,
} from "./agentBridge/AgentBridgeService.ts";
import { makeAgentBridgeStore } from "./agentBridge/AgentBridgeStore.ts";
import { makeBotTaskStore } from "./agentBridge/BotTaskStore.ts";
import { version as serverPackageVersion } from "../package.json" with { type: "json" };
import { usageResumeTargetAfterCredit } from "./usage/usageResumeAfterCredit.ts";
import { usageLimitKey } from "./nextTurnQueue/usageLimitResume.ts";
import { awaitActivation, waitForActivation, reportActive } from "./distribution/activation";
import { ForgeAccounts } from "./sourceControl/accountRouting.ts";
import { SourceControlProviderError } from "./sourceControl/SourceControlProvider.ts";
import { PrHubExtensions } from "./prHub/PrHubExtensions.ts";
import { readAssetImageDimensions } from "./imageDimensions";
import { makePreviewFileServer } from "./previewFileServer";
import { MessageId } from "@t3tools/contracts";
import {
  makeAttachmentUploads,
  materializeErrorMessage,
  resolveWorkflowAttachmentsDir,
  sweepWorkflowAttachments,
} from "./attachmentUploads";
import { GitCommandError } from "./git/Errors";
import { readProjectSettings, isInsideProjectWorkspace } from "./project/projectSettings";
import {
  discoverConfiguredProjectRepositories,
  listWorkspaceRepositories,
  makeWorkspaceRepositoryReadCache,
} from "./project/discoverProjectRepositories.ts";
import { selectNestedWorktreeRepositories } from "./project/worktreeRepositoryPaths.ts";
import { makeProjectCloneTracker } from "./project/ProjectCloneTracker.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { protocolMatches, SERVER_BOOTSTRAP, UPGRADE_REQUIRED } from "./wsServer/protocol";
import {
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  F5_PROTOCOL_QUERY,
  F5_UPGRADE_REQUIRED_CLOSE_CODE,
  type ServerRuntimeReadiness,
  type TurnSubmissionResult,
  type GitCheckoutConflict,
  type WebSocketResponse,
} from "@t3tools/contracts";
import { GithubDeviceLogin, resolveGithubOAuthClientId } from "./git/GithubDeviceLogin";
import { GithubCliImport } from "./git/GithubCliImport";
import { githubLauncherDir } from "./git/GithubCliLauncher";
import * as NodePath from "node:path";
import { writeProfileGitAuthorConfig } from "./git/gitConfigEnvironment";
import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration";
import { ProfileGithubAccount } from "./git/ProfileGithubAccount";
import { profileProviderAccounts } from "@t3tools/shared/profileProviderAccounts";
import {
  repositorySharingWarnings,
  invalidExecutionDirectories,
} from "./profiles/RepositorySharing";
import { makeServerSecretStore } from "./auth/Layers/ServerSecretStore";
import { ProfileRegistryStore, fallbackDefaultProfile } from "./profiles/ProfileRegistryStore";
import {
  GUEST_PROFILE_MUTATION_REFUSAL,
  guestActiveProfile,
  guestProfileSnapshot,
} from "./profiles/guestProfileIdentity.ts";
import { ProviderAccountService } from "./profiles/ProviderAccountService";
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

import {
  AGENTS_WS_CHANNELS,
  AGENTS_WS_METHODS,
  AGENT_BRIDGE_WS_CHANNELS,
  UPSTREAM_PORTS_WS_CHANNELS,
  UpstreamTriageBatchResult,
  USAGE_WS_METHODS,
  ELICITATION_WS_METHODS,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PROJECT_READ_FILE_MAX_SIZE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationGetStartupSnapshotInput,
  PR_HUB_WS_CHANNELS,
  ProjectId,
  type ProfileSummary,
  ThreadId,
  ProviderInstanceId,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsResponse,
  type WsPushEnvelopeBase,
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
  Semaphore,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { resolveAliasedBooleanEnv, THREAD_OPEN_TIMINGS_ENV } from "./envFlags.ts";
import { createLogger } from "./logger";
import { NextTurnQueueStore } from "./nextTurnQueue/Services/NextTurnQueueStore.ts";
import { makeProjectionTurnRepository } from "./persistence/Layers/ProjectionTurns.ts";
import {
  NextTurnQueueDispatcher,
  type NextTurnQueueDispatcherShape,
} from "./nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { makeGlobalSearch } from "./globalSearch";
import { makeBackupService } from "./backupService";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager, type TerminalError } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import {
  browseWorkspaceEntries,
  clearWorkspaceIndexCache,
  listWorkspaceEntries,
  listWorkspaceDirectory,
  registerWorkspaceContentIndexInvalidator,
  searchWorkspaceEntries,
} from "./workspaceEntries";
import { makeProjectContentSearchManager } from "./projectContentSearch";
import { WorkspaceSearchRestrictedError } from "./workspaceSearchRoot";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { captureSideChatContext } from "./orchestration/providerHandoff.ts";
import { isKnownProviderKind } from "@t3tools/contracts";
import { ProviderHandoffStateRepository } from "./persistence/Services/ProviderHandoffState.ts";
import { submitElicitation } from "./orchestration/elicitationSubmission";
import { ProjectionWorkspaceQuery } from "./orchestration/Services/ProjectionWorkspaceQuery";
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
import { Open, OpenError, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { makeWorkspaceAssetAuthorizer } from "./WorkspaceAssetAuthorizer";
import { makeCheckedInProjectFileService } from "./project/CheckedInProjectFileService";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import {
  AttachmentIngressError,
  discardAttachmentIngress,
  discardPreparedAttachmentIngress,
  persistPreparedAttachmentIngress,
  prepareAttachmentIngress,
  type PreparedAttachmentIngress,
} from "./attachmentIngress.ts";
import { expandHomePath } from "./os-jank.ts";
import { increment, websocketConnectionsTotal } from "./observability/Metrics.ts";
import { observeRpcEffect } from "./observability/RpcInstrumentation.ts";
import {
  recordSlowRpcRoute,
  SLOW_RPC_ROUTE_MS,
  startEventLoopDelayMonitor,
} from "./observability/serverHealth.ts";
import {
  buildSqliteInspectionSnapshot,
  runDoctorDiagnostics,
  type SqliteInspectionResult,
} from "./diagnostics/doctor.ts";
import { canonicalManagedWorktreesDirectories } from "./worktreesDirectoryPaths.ts";
import {
  type BootstrapThreadDisposition,
  dispatchBootstrapTurnStart,
} from "./wsServer/bootstrapTurnStart.ts";
import { makeWorktreePreparation } from "./project/worktreePreparation.ts";
import { WorktreeSetup, type WorktreeSetupShape } from "./project/Services/WorktreeSetup.ts";
import { withWorktreeLifecycleLock } from "./project/Layers/WorktreeLifecycleCoordinator.ts";
import { makeServerPushBus, makeWebSocketSendController } from "./wsServer/pushBus.ts";
import {
  WEB_SOCKET_MAX_PAYLOAD_BYTES,
  resolveServerPerMessageDeflate,
  webSocketRuntimeName,
} from "./wsServer/webSocketTransport.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { routeFailureMessage } from "./wsServer/routeFailureMessage.ts";
import { agentBridgeRoutes } from "./wsServer/routes/agentBridgeRoutes.ts";
import { githubAccountRoutes } from "./wsServer/routes/githubAccountRoutes.ts";
import { mcpRoutes } from "./wsServer/routes/mcpRoutes.ts";
import { prHubRoutes } from "./wsServer/routes/prHubRoutes.ts";
import { previewRoutes } from "./wsServer/routes/previewRoutes.ts";
import { profileRoutes } from "./wsServer/routes/profileRoutes.ts";
import { providerAccountRoutes } from "./wsServer/routes/providerAccountRoutes.ts";
import { scheduledTaskRoutes } from "./wsServer/routes/scheduledTaskRoutes.ts";
import { serverMetaRoutes } from "./wsServer/routes/serverMetaRoutes.ts";
import { storageRoutes } from "./wsServer/routes/storageRoutes.ts";
import { gitRoutes } from "./wsServer/routes/gitRoutes.ts";
import { terminalRoutes } from "./wsServer/routes/terminalRoutes.ts";
import { upstreamPortRoutes } from "./wsServer/routes/upstreamPortRoutes.ts";
import { workflowRoutes } from "./wsServer/routes/workflowRoutes.ts";
import { worktreeRoutes } from "./wsServer/routes/worktreeRoutes.ts";
import { createHttpRequestListener } from "./wsServer/http/httpRequestHandler.ts";
import { DESKTOP_RENDERER_ORIGIN } from "./wsServer/http/staticAssets.ts";
import {
  answerFromTable,
  routePromise,
  routeTables,
  tableAnswers,
} from "./wsServer/routes/routeTable.ts";
import { cleanupStaleWorktrees } from "./orchestration/Layers/WorktreeStartupCleanup.ts";
import { makeServerOrchestrationRuntimeLayer } from "./serverLayers.ts";
import {
  formatStillStartingMessage,
  getCurrentStartupPhase,
  withStartupPhaseTiming,
} from "./startupTiming.ts";
import {
  AUTH_RATE_LIMITED_MESSAGE,
  makeServerAuth,
  REQUEST_HOST_NOT_ALLOWED_MESSAGE,
} from "./serverAuth.ts";
import { getReviewPreviewDiff } from "./git/ReviewDiffService.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import {
  getMessageTextLengthIssue,
  getThreadReferenceLimitIssue,
} from "@t3tools/shared/providerInput";
import { CodexControlClientRegistry } from "./codex/CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "./codex/CodexMcpEventBus.ts";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService.ts";
import { McpRuntimeService } from "./mcp/McpRuntimeService.ts";
import { reconcileCodexThreadSnapshots } from "./orchestration/codexSnapshotReconciliation.ts";
import { makeHistoryRecoveredSessionSet } from "./orchestration/providerTerminalLifecycle.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { DiskSpaceMonitor } from "./storage/DiskSpaceMonitor.ts";
import { StorageMaintenance, type StorageMaintenanceShape } from "./storage/StorageMaintenance.ts";
import {
  StorageCleanupWorker,
  type StorageCleanupWorkerShape,
} from "./storage/StorageCleanupWorker.ts";
import {
  DefaultBranchAutoPull,
  type DefaultBranchAutoPullShape,
} from "./git/DefaultBranchAutoPull.ts";
import { makePreviewManager } from "./preview/Manager.ts";
import { OwnedPreviewUrls } from "./preview/PortScanner.ts";
import { PreviewAutomationBroker } from "./mcp/PreviewAutomationBroker.ts";
import { computerUseLease } from "./provider/computerUseLease.ts";
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

type SubmissionSource = "human" | "automation";

const clientDiagnosticsReporter = makeClientDiagnosticsReporter();
const BACKEND_INCARNATION = process.env.F5_DESKTOP_BACKEND_INCARNATION || crypto.randomUUID();
const MAX_RECONNECT_REPLAY_EVENTS = 128;
const MAX_RECONNECT_REPLAY_BYTES = 512 * 1024;
const isServerNotRunningError = (error: Error): boolean => {
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const reason =
    statusCode === 401 ? "Unauthorized" : statusCode === 429 ? "Too Many Requests" : "Bad Request";
  socket.end(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("") +
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
  allowWorkspaceRoot?: boolean;
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<
  { requestedAbsolutePath: string; relativePath: string; workspaceAbsolutePath: string },
  RouteRequestError
> {
  const normalizedInputPath = params.relativePath;
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
  if (
    isRelativePathOutsideRoot(relativeToRoot, params.path) &&
    !(params.allowWorkspaceRoot && params.relativePath === "." && relativeToRoot.length === 0)
  ) {
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
  allowWorkspaceRoot?: boolean;
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
        allowWorkspaceRoot: params.allowWorkspaceRoot ?? false,
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
        let offset = 0;
        while (offset < byteLimit) {
          const { bytesRead } = await handle.read(buffer, offset, byteLimit - offset, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        return buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => new RouteRequestError({ message: `Failed to read file: ${String(cause)}` }),
  });
}

type RequestBodyWithoutTag<T> = T extends { _tag: string } ? Omit<T, "_tag"> : never;

function stripRequestTag<T extends { _tag: string }>(body: T): RequestBodyWithoutTag<T> {
  return Struct.omit(body, ["_tag"]) as RequestBodyWithoutTag<T>;
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
  if (method.startsWith("upstreamPorts.")) {
    return "upstreamPorts";
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

/** The RPC method a route fiber serves, so a runtime wait can attribute itself. */
const CurrentRpcMethod = ServiceMap.Reference<string | null>("f5/ws/CurrentRpcMethod", {
  defaultValue: () => null,
});
const LARGE_RPC_RESPONSE_LOG_BYTES = 1024 * 1024;

/**
 * Sent when a result cannot be encoded, so the client still releases the
 * request's slot. Built without the schema that just failed.
 */
export function encodeResponseEncodeFailure(id: string): string {
  return JSON.stringify({
    id,
    error: { message: "Response could not be encoded", code: "ResponseEncodeFailed" },
  });
}

/**
 * The pre-admission answer for a request that needs the orchestration runtime
 * while it starts; `null` lets the request proceed to admission.
 */
export function serverStartingRejection(
  body: { readonly _tag: string },
  readiness: ServerRuntimeReadiness,
) {
  return readiness.state === "starting" && rpcRequiresRuntime(body)
    ? {
        code: "ServerStarting" as const,
        retryable: true,
        retryAfterMs: 1_000,
        message: "F5 is still starting. The request will run once startup finishes.",
      }
    : null;
}

/** Best-effort id recovery for requests whose body fails schema decoding. */
export function readWebSocketRequestId(messageText: string): string | null {
  try {
    const value: unknown = JSON.parse(messageText);
    if (typeof value !== "object" || value === null || !("id" in value)) return null;
    const id = value.id;
    return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

export type ServerCoreRuntimeServices =
  | ProjectionSnapshotQuery
  | ProjectionWorkspaceQuery
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
  | CodexControlClientRegistry
  | CodexMcpEventBus
  | McpRuntimeService
  | ProjectMcpConfigService
  | PreviewAutomationBroker
  | PrHubAdvisoryService
  | PrHubReviewGuideService
  | PrHubService;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | CheckpointStore
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | NextTurnQueueStore;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function workspaceSearchRouteError(cause: unknown, summary: string): RouteRequestError {
  if (cause instanceof WorkspaceSearchRestrictedError) {
    return new RouteRequestError({ message: cause.message, code: cause.code });
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new RouteRequestError({ message: `${summary}: ${detail}` });
}

function toDeliveryRecoveryError(error: Error): RouteRequestError {
  return new RouteRequestError({
    code: "NextTurnQueueDeliveryRecoveryError",
    message: error.message,
  });
}

function formatRouteFailure(
  cause: Cause.Cause<unknown>,
  method: string,
): {
  readonly message: string;
  readonly code?: string;
  readonly checkoutConflict?: GitCheckoutConflict;
  readonly retryable?: boolean;
} {
  const squashed = Cause.squash(cause);
  if (Schema.is(OrchestrationOverloadError)(squashed))
    return { message: squashed.message, code: squashed._tag, retryable: squashed.retryable };
  if (
    method === WS_METHODS.gitCheckout &&
    Schema.is(GitCommandError)(squashed) &&
    squashed.checkoutConflict
  ) {
    return {
      code: "GitCheckoutConflict",
      message: `Local changes in ${squashed.checkoutConflict.cwd} would be overwritten by switching to '${squashed.checkoutConflict.branch}'.`,
      checkoutConflict: squashed.checkoutConflict,
    };
  }
  if (squashed instanceof WorkspaceRequiresNewWorktreeError)
    return { message: squashed.message, code: squashed.code };
  if (Schema.is(AttachmentIngressError)(squashed)) {
    return { message: squashed.message };
  }
  if (Schema.is(OpenError)(squashed)) {
    // Generic launch failures ("failed to spawn detached process") keep the
    // real reason in `cause`; carry its message without the stack.
    const cause = squashed.cause instanceof Error ? squashed.cause.message.trim() : "";
    return { message: cause ? `${squashed.message}: ${cause}` : squashed.message };
  }
  if (Schema.is(RouteRequestError)(squashed)) {
    return {
      message: squashed.message,
      ...(squashed.code !== undefined ? { code: squashed.code } : {}),
    };
  }
  // PR Hub's own precondition checks are written for the user; skip the provider prefix.
  if (Schema.is(SourceControlProviderError)(squashed) && squashed.operation === "prHub.action")
    return { message: squashed.detail };
  return { message: routeFailureMessage(cause) };
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

  // The message only: the startup failure is logged with its full cause.
  const causeMessage = Cause.isCause(error.cause)
    ? routeFailureMessage(error.cause)
    : error.cause instanceof Error
      ? error.cause.message
      : String(error.cause);
  const compactedCauseMessage = compactRouteCauseMessage(causeMessage);
  return compactedCauseMessage.length > 0
    ? `${baseMessage}: ${compactedCauseMessage}`
    : baseMessage;
}

/**
 * How long a route waits for the orchestration runtime before failing. Kept
 * just under the web client's 60s request timeout (`REQUEST_TIMEOUT_MS` in
 * apps/web/src/wsTransport.ts) so the client sees this message rather than a
 * bare "Request timed out". Large profiles legitimately take 30-40s to start.
 */
const ORCHESTRATION_RUNTIME_ROUTE_WAIT_MS = 55_000;

interface OrchestrationRuntimeServices {
  readonly providerHandoffStates: ProviderHandoffStateRepository["Service"] | undefined;
  readonly mcpApps: McpAppService["Service"];
  readonly threadSettlement: ThreadSettlementService["Service"];
  readonly pullRequestWatches: PullRequestWatchService["Service"];
  readonly projectSkillSyncService: ProjectSkillSyncServiceShape;
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
  readonly worktreeSetup: WorktreeSetupShape;
  readonly worktreePreparation: WorktreePreparationShape;
  readonly worktreeManager: WorktreeManagerShape;
  readonly workspaceTransition: WorkspaceTransitionShape;
  readonly storageCleanupWorker: StorageCleanupWorkerShape;
  readonly defaultBranchAutoPull: DefaultBranchAutoPullShape;
}

export const createServer = Effect.fn(function* (
  options: { readonly orchestrationStartupGate?: Effect.Effect<void> } = {},
): Effect.fn.Return<
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
    rotateDesktopBootstrapToken: mode === "desktop",
    ...(serverConfig.profile ? { profileId: serverConfig.profile.id } : {}),
    allowedWebSocketOrigins: [
      ...(mode === "desktop" ? [DESKTOP_RENDERER_ORIGIN] : []),
      ...(devUrl ? [devUrl.origin] : []),
    ],
    ...(serverConfig.trustedProxies ? { trustedProxies: serverConfig.trustedProxies } : {}),
  });
  const availableEditors = yield* Effect.promise(() => resolveAvailableEditors());

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const shutdown = yield* Effect.serviceOption(ServerShutdown);
  let shuttingDown = false;
  yield* registerShutdown("websocket-admission", "admission", () =>
    Effect.sync(() => {
      shuttingDown = true;
    }),
  );
  const keybindingsManager = yield* Keybindings;
  const providerService = yield* ProviderService;
  const elicitationSubmissionsInFlight = new Set<string>();
  const providerRegistry = yield* ProviderRegistry;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry;
  const providerUpdateAdvisor = yield* ProviderUpdateAdvisor;
  const providerAdvisoryProjection = yield* ProviderAdvisoryProjection;
  const harnessValidation = yield* HarnessValidation;
  const serverSettings = yield* ServerSettingsService;
  const codexMcpEventBus = yield* CodexMcpEventBus;
  const mcpRuntimeService = yield* McpRuntimeService;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const previewAutomationBroker = yield* PreviewAutomationBroker;
  const computerAutomationBroker = yield* Effect.serviceOption(ComputerAutomationBroker);
  const forgeAccounts = yield* Effect.serviceOption(ForgeAccounts);
  const htmlPreviewBroker = makeHtmlPreviewBroker();
  yield* Effect.addFinalizer(() => Effect.sync(() => htmlPreviewBroker.close()));
  const threadMcpBroker = yield* Effect.serviceOption(ThreadMcpBroker);
  const threadMcpFederation = yield* Effect.serviceOption(PrHubFederation);
  const prHubExtensions = yield* Effect.serviceOption(PrHubExtensions);
  const diskSpaceMonitor = yield* Effect.serviceOption(DiskSpaceMonitor);
  const prHub = yield* PrHubService;
  const prHubAdvisory = yield* PrHubAdvisoryService;
  const prHubReviewGuide = yield* PrHubReviewGuideService;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  // The turn repository lives in the orchestration runtime, built later; build one
  // here so claims on the draft branch-switch route see accepted, undelivered turns.
  const withClaimServices = yield* captureOptionalClaimServices({
    turns: yield* makeProjectionTurnRepository.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    ),
  });
  yield* sql`UPDATE scheduled_control SET ready=0 WHERE id=1`.pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "scheduledTasks.closeStartupGate", cause }),
    ),
  );
  const attachmentUploads = yield* makeAttachmentUploads(serverConfig.attachmentsDir);
  const workflowAttachmentsDir = resolveWorkflowAttachmentsDir(serverConfig);
  const nextTurnQueueStore = yield* NextTurnQueueStore;
  const globalSearch = yield* makeGlobalSearch;
  const projectionProjects = yield* Effect.service(ProjectionProjectRepository).pipe(
    Effect.provide(ProjectionProjectRepositoryLive),
  );
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

  yield* startScheduledBackups(backupService);
  yield* startDatabaseSnapshots;

  const clients = yield* Ref.make(new Set<WebSocket>());
  const scratchProjectSemaphore = yield* Semaphore.make(1);
  const agentSessionSemaphore = yield* Semaphore.make(1);
  const agentSessionScanner = new AgentSessionScanner();
  const logger = createLogger("ws");
  const readiness = yield* makeServerReadiness;
  const shouldLogThreadOpenTimings =
    process.env.NODE_ENV !== "test" &&
    process.env.VITEST !== "true" &&
    resolveAliasedBooleanEnv(THREAD_OPEN_TIMINGS_ENV.primary, THREAD_OPEN_TIMINGS_ENV.legacy)
      .enabled;

  function logOutgoingPush(push: WsPushEnvelopeBase, recipients: number) {
    if (!logWebSocketEvents || push.channel === WS_CHANNELS.providerAccountEvent) return;
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
  const defaultProfileStateDir =
    serverConfig.defaultStateDir ??
    (serverConfig.profile?.isDefault === false
      ? (() => {
          throw new Error("Isolated profiles require defaultStateDir.");
        })()
      : serverConfig.stateDir);
  const profilesStore = new ProfileRegistryStore(
    defaultProfileStateDir,
    3773 + (devUrl ? 1000 : 0),
  );
  const profileSecrets = yield* makeServerSecretStore.pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "profiles.secrets", cause })),
  );
  const storeMcpSecret = yield* makeMcpSecretWriter(profileSecrets);
  const resolveMcpFeatureExecution = yield* makeMcpAccountExecutionResolver.pipe(
    Effect.provideService(ProjectionProjectRepository, projectionProjects),
  );
  const githubAccount = new ProfileGithubAccount(profileSecrets, fetch, serverConfig);
  const githubLogin = new GithubDeviceLogin(githubAccount, resolveGithubOAuthClientId(process.env));
  yield* Effect.addFinalizer(() => Effect.sync(() => githubLogin.cancel()));
  const stopEventLoopDelayMonitor = startEventLoopDelayMonitor();
  yield* Effect.addFinalizer(() => Effect.sync(stopEventLoopDelayMonitor));
  const githubCliImport = new GithubCliImport({
    account: githubAccount,
    // Profile state dirs live under the F5 home (parent of Default's state dir).
    f5StateRoots: [
      serverConfig.stateDir,
      defaultProfileStateDir,
      NodePath.dirname(defaultProfileStateDir),
    ],
    launcherDir: githubLauncherDir(serverConfig.stateDir),
  });
  const activeProfile = serverConfig.profile ?? fallbackDefaultProfile(defaultProfileStateDir);
  const profileCall = routePromise;
  const computeProfiles = async () => {
    const snapshot = await profilesStore.list(activeProfile.id);
    const providers = await Effect.runPromise(providerRegistry.getProviders);
    const sharedRepositories = await repositorySharingWarnings(snapshot.profiles, activeProfile.id);
    const invalidDirectories = await invalidExecutionDirectories(serverConfig.stateDir).catch(
      () => [],
    );
    const enriched = {
      ...snapshot,
      profiles: snapshot.profiles.map((profile) =>
        profile.isActive
          ? {
              ...profile,
              sharedRepositories,
              invalidDirectories,
              providerAccounts: profileProviderAccounts(providers),
            }
          : profile,
      ),
    };
    // A Linux VM guest reports the host's VM profile, never its own Default.
    return serverConfig.guestProfileId
      ? guestProfileSnapshot(enriched, serverConfig.guestProfileId, serverConfig.port)
      : enriched;
  };
  /** The welcome's profile when the registry has no active record (e.g. it can't be read). */
  const welcomeFallback = (): ProfileSummary => {
    const profile: ProfileSummary = {
      ...fallbackDefaultProfile(defaultProfileStateDir),
      ...activeProfile,
      port,
      stateDir: serverConfig.stateDir,
      isActive: true,
      providerAccounts: [],
    };
    return serverConfig.guestProfileId
      ? guestActiveProfile(profile, serverConfig.guestProfileId, port)
      : profile;
  };
  let profileReadCache: { expires: number; value: ReturnType<typeof computeProfiles> } | undefined;
  const readProfiles = () => {
    if (profileReadCache && profileReadCache.expires > Date.now()) return profileReadCache.value;
    const value = computeProfiles();
    profileReadCache = { expires: Date.now() + 2000, value };
    void value.catch(() => {
      if (profileReadCache?.value === value) profileReadCache = undefined;
    });
    return value;
  };
  if (serverConfig.profilesRoot) {
    yield* Effect.tryPromise({
      try: () => profilesStore.init(),
      catch: (cause) => new ServerLifecycleError({ operation: "profiles.init", cause }),
    }).pipe(Effect.ignore);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        profilesStore.watch(() => {
          profileReadCache = undefined;
          void readProfiles()
            .then((snapshot) =>
              Effect.runPromise(pushBus.publishAll(WS_CHANNELS.profilesUpdated, snapshot)),
            )
            .catch((cause) =>
              Effect.runPromise(Effect.logError("Failed to refresh profiles", cause)),
            );
        }),
      ),
      (close) => Effect.sync(close),
    );
  }
  // Every window shows a global banner while an agent controls the computer.
  if (Option.isNone(computerAutomationBroker))
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        computerUseLease.subscribe((holder) => {
          void Effect.runPromise(
            pushBus.publishAll(WS_CHANNELS.agentComputerUseChanged, {
              holders:
                holder === null
                  ? []
                  : [
                      {
                        threadId: ThreadId.makeUnsafe(holder),
                        delivery: "foreground",
                        state: "active",
                      },
                    ],
            }),
          );
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
  if (Option.isSome(computerAutomationBroker)) {
    const computer = computerAutomationBroker.value;
    // Settle crashed or timed-out Chrome launches before any session can reuse them.
    yield* reconcileChromeSessionSetups(serverConfig.stateDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchDefect(() => Effect.void),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        computer.subscribe((event) => {
          // One merged publication for native, Chrome and execution-state changes, so a
          // reconnecting client restores real pending, active and paused state.
          if (event.channel === "computer.use.changed") {
            computerUseLease.setFromHost(event.data.holders[0]?.threadId ?? null);
            void Effect.runPromise(
              pushBus.publishAll(
                WS_CHANNELS.agentComputerUseChanged,
                agentComputerUsePush(event.data),
              ),
            );
          }
          if (event.channel === "computer.host") {
            if (event.data.type === "chromeInterrupted") {
              const interrupted = event.data;
              void Effect.runPromise(
                Deferred.await(orchestrationRuntime).pipe(
                  Effect.flatMap(({ orchestrationEngine }) =>
                    computer.generation(interrupted.threadId) === interrupted.sessionGeneration
                      ? orchestrationEngine
                          .dispatch({
                            type: "thread.turn.interrupt",
                            commandId: CommandId.makeUnsafe(timeOrderedUuid()),
                            threadId: ThreadId.makeUnsafe(interrupted.threadId),
                            createdAt: new Date().toISOString(),
                          })
                          .pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ).catch(() => undefined);
            } else if (event.data.type === "pauseChanged")
              void Effect.runPromise(
                previewAutomationBroker.setPaused(
                  ThreadId.makeUnsafe(event.data.threadId),
                  event.data.paused,
                ),
              );
            else if (event.data.type === "killSwitch") {
              const killed = event.data;
              void Effect.runPromise(
                Deferred.await(orchestrationRuntime).pipe(
                  Effect.flatMap(({ orchestrationEngine }) =>
                    computer.matchesTurn(killed.threadId, killed.sessionGeneration, killed.turnId)
                      ? orchestrationEngine
                          .dispatch({
                            type: "thread.turn.interrupt",
                            commandId: CommandId.makeUnsafe(timeOrderedUuid()),
                            threadId: ThreadId.makeUnsafe(killed.threadId),
                            createdAt: new Date().toISOString(),
                          })
                          .pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ).catch(() => undefined);
            }
          } else {
            switch (event.channel) {
              case "computer.access.requested":
                void Effect.runPromise(
                  pushBus.publishAll(WS_CHANNELS.computerAccessRequested, event.data),
                );
                break;
              case "computer.access.settled":
                void Effect.runPromise(
                  pushBus.publishAll(WS_CHANNELS.computerAccessSettled, event.data),
                );
                break;
              case "computer.access.grantsChanged":
                void Effect.runPromise(
                  pushBus.publishAll(WS_CHANNELS.computerAccessGrantsChanged, event.data),
                );
                break;
              case "computer.observations.invalidated":
                void Effect.runPromise(
                  pushBus.publishAll(WS_CHANNELS.computerObservationsInvalidated, event.data),
                );
                break;
              case "computer.activity":
                void Effect.runPromise(
                  pushBus.publishAll(WS_CHANNELS.computerActivity, event.data),
                );
                break;
            }
          }
        }),
      ),
      (off) => Effect.sync(off),
    );
  }
  const accountService = new ProviderAccountService(
    serverConfig,
    serverSettings,
    terminalManager,
    (event, owner) => {
      void Effect.runPromise(
        pushBus.publishClient(owner as WebSocket, WS_CHANNELS.providerAccountEvent, event),
      );
    },
    async (instanceId) => {
      await Effect.runPromise(providerRegistry.refreshInstance(instanceId));
      profileReadCache = undefined;
      await Effect.runPromise(
        pushBus.publishAll(WS_CHANNELS.profilesUpdated, await readProfiles()),
      );
    },
    async (instanceId) =>
      (await Effect.runPromise(providerService.listSessions())).some(
        (session) => session.providerInstanceId === instanceId && session.activeTurnId != null,
      ),
    async (instanceId) => {
      const sessions = await Effect.runPromise(providerService.listSessions());
      if (
        sessions.some(
          (session) => session.providerInstanceId === instanceId && session.activeTurnId != null,
        )
      )
        throw new Error("Stop this instance's active turn before changing its account.");
      for (const session of sessions) {
        if (session.providerInstanceId === instanceId) {
          await Effect.runPromise(providerService.stopSession({ threadId: session.threadId }));
        }
      }
    },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => accountService.dispose()));
  const previewManager = makePreviewManager({
    resolveNavigationPolicy: (threadId) =>
      previewAutomationBroker
        .resolvePolicy(threadId as ThreadId)
        .pipe(Effect.map((policy) => ({ externalHosts: policy.externalHosts }))),
  });
  const previewAutomationClientIdsByWs = new WeakMap<WebSocket, Map<string, string>>();
  const previewAutomationHostIdByWs = new WeakMap<WebSocket, string>();

  const getPreviewAutomationHostId = (ws: WebSocket): string => {
    let hostId = previewAutomationHostIdByWs.get(ws);
    if (!hostId) {
      hostId = `preview-host-${randomUUID()}`;
      previewAutomationHostIdByWs.set(ws, hostId);
    }
    return hostId;
  };

  /** Every renderer connection can be asked to host a preview; non-desktop ones ignore it. */
  const registerPreviewAutomationHost = (ws: WebSocket) =>
    previewAutomationBroker.registerHost({
      hostId: getPreviewAutomationHostId(ws),
      push: (event) => {
        switch (event.type) {
          case "ownerRequested":
            return pushBus.publishClient(ws, WS_CHANNELS.previewAutomationOwnerRequested, {
              requestId: event.requestId,
              threadId: event.threadId,
            });
          case "ownerReleased":
            return pushBus.publishClient(ws, WS_CHANNELS.previewAutomationOwnerReleased, {
              threadId: event.threadId,
            });
          case "pauseChanged":
            return pushBus.publishClient(ws, WS_CHANNELS.previewAutomationPauseChanged, {
              threadId: event.threadId,
              paused: event.paused,
            });
        }
      },
    });

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

  const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
    const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot));
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

  const prepareTurnStartCommand = Effect.fnUntraced(function* (input: {
    readonly command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
  }) {
    const { dispatchSource: _dispatchSource, ...turnStartCommand } =
      input.command as typeof input.command & {
        readonly dispatchSource?: unknown;
      };
    const inputLengthIssue =
      getMessageTextLengthIssue(turnStartCommand.message.text) ??
      getThreadReferenceLimitIssue(turnStartCommand.message.text);
    if (inputLengthIssue) {
      return yield* new RouteRequestError({
        message: inputLengthIssue.message,
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
    const attachmentIngress = yield* prepareAttachmentIngress({
      attachments: turnStartCommand.message.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
      commandId: turnStartCommand.commandId,
      threadId: turnStartCommand.threadId,
      uploads: attachmentUploads,
    });
    const command = {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: attachmentIngress.attachments,
      },
      ...(normalizedBootstrap ? { bootstrap: normalizedBootstrap } : {}),
    } satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    return { attachmentIngress, command };
  });

  const persistPreparedTurnStartCommand = Effect.fnUntraced(function* (prepared: {
    readonly attachmentIngress: PreparedAttachmentIngress;
    readonly command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
  }) {
    yield* persistPreparedAttachmentIngress(prepared.attachmentIngress);
    return prepared.command;
  });

  /**
   * Creates the thread, prepares its worktree and setup script, and starts the
   * first turn. A failure that rolled the new thread back is reported with a
   * `BootstrapThread*` error code so the client can retry under a fresh id.
   */
  interface InflightBootstrap {
    readonly requestHash: string;
    readonly done: Deferred.Deferred<void>;
    outcome:
      | { readonly kind: "result"; readonly value: TurnSubmissionResult | null }
      | { readonly kind: "error"; readonly message: string; readonly code?: string };
  }
  const inflightBootstraps = new Map<string, InflightBootstrap>();
  const singleFlightBootstrap = <
    A extends TurnSubmissionResult | null,
    E extends { readonly message: string },
    R,
  >(
    submissionId: string,
    requestHash: string,
    run: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | RouteRequestError, R> =>
    Effect.gen(function* () {
      const existing = inflightBootstraps.get(submissionId);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return yield* new RouteRequestError({
            message: "That send identifier was already used for different content.",
            code: "NextTurnQueueIdempotencyConflictError",
          });
        }
        yield* Deferred.await(existing.done);
        const outcome = existing.outcome;
        if (outcome.kind === "result") return outcome.value as A;
        return yield* new RouteRequestError({
          message: outcome.message,
          ...(outcome.code !== undefined ? { code: outcome.code } : {}),
        });
      }
      const entry: InflightBootstrap = {
        requestHash,
        done: yield* Deferred.make<void>(),
        outcome: { kind: "error", message: "The send was interrupted." },
      };
      inflightBootstraps.set(submissionId, entry);
      return yield* run.pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            entry.outcome = { kind: "result", value: result };
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            const code = (error as { readonly code?: unknown }).code;
            entry.outcome = {
              kind: "error",
              message: error.message,
              ...(typeof code === "string" ? { code } : {}),
            };
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => inflightBootstraps.delete(submissionId)).pipe(
            Effect.andThen(Deferred.succeed(entry.done, undefined)),
          ),
        ),
      );
    });

  /**
   * Starts background worktree setup for a first send. Returns null when the
   * project cannot host a separate worktree and the send may run in the
   * project checkout; a send that requires a worktree is rejected instead,
   * before any thread exists.
   */
  const startWorktreeSetupSubmission = (input: {
    readonly command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
    readonly submissionId: CommandId;
    readonly requestHash: string;
    readonly worktreeSetup: WorktreeSetupShape;
    readonly submissionSource: SubmissionSource;
  }) =>
    Effect.gen(function* () {
      const prepared = yield* prepareTurnStartCommand({ command: input.command });
      yield* stampSubmissionSource(
        prepared.command.commandId,
        prepared.command.threadId,
        input.submissionSource,
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const result = yield* input.worktreeSetup
        .start({
          command: prepared.command,
          submissionId: input.submissionId,
          requestHash: input.requestHash,
          persistAttachments: persistPreparedAttachmentIngress(prepared.attachmentIngress).pipe(
            Effect.asVoid,
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
          discardAttachments: discardPreparedAttachmentIngress(prepared.attachmentIngress).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        })
        .pipe(
          Effect.tapError(() =>
            discardPreparedAttachmentIngress(prepared.attachmentIngress).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          ),
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
                ...(error.code !== undefined ? { code: error.code } : {}),
              }),
          ),
        );
      if (result.kind === "unavailable") {
        yield* discardPreparedAttachmentIngress(prepared.attachmentIngress).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        if (input.command.bootstrap?.prepareWorktree?.requireWorktree === true) {
          return yield* new RouteRequestError({
            message: `Worktree isolation unavailable: ${result.detail}`,
            code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
          });
        }
        return null;
      }
      yield* releaseSentUploads(input.command.threadId, input.command.message.attachments);
      return result.result;
    });

  const validateCreationAttachment = (input: {
    projectId: ProjectId;
    worktreePath: string | null;
    branch: string | null;
    sharedFilesystemConfirmed?: boolean | undefined;
    threadId?: ThreadId | undefined;
  }) =>
    Effect.gen(function* () {
      const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
      const model = yield* orchestrationEngine.getReadModel();
      const project = model.projects.find(
        (entry) => entry.id === input.projectId && entry.deletedAt === null,
      );
      if (!project) return yield* new RouteRequestError({ message: "Unknown project." });
      if (!input.worktreePath) {
        yield* Effect.tryPromise({
          try: () => assertNotOtherProfileManagedCheckout(serverConfig, project.workspaceRoot),
          catch: (cause) =>
            new RouteRequestError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        return;
      }
      yield* withWorktreeLifecycleLock(
        input.worktreePath,
        Effect.gen(function* () {
          const target = yield* inspectAttachableWorkspace(
            git,
            serverConfig,
            project.workspaceRoot,
            input.worktreePath!,
            input.branch,
          ).pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
          const usage = yield* readWorktreeClaims(target.canonicalRoot).pipe(
            Effect.provideService(OrchestrationEngineService, orchestrationEngine),
            Effect.provideService(ProviderService, providerService),
            Effect.provideService(TerminalManager, terminalManager),
            Effect.provideService(NextTurnQueueStore, nextTurnQueueStore),
          );
          if (usage.unknown || usage.setupThreadIds.some((id) => id !== input.threadId))
            return yield* new RouteRequestError({
              message: "Workspace ownership could not be verified or another operation owns it.",
            });
          if (
            usage.threadIds.some((id) => id !== input.threadId) &&
            !input.sharedFilesystemConfirmed
          )
            return yield* new RouteRequestError({
              message: "Confirm sharing this checkout's filesystem with the linked conversations.",
            });
        }),
      );
    });

  const dispatchWithCreationAttachment = (
    engine: OrchestrationEngineShape,
    command: OrchestrationCommand,
  ) => {
    if (command.type !== "thread.create") return engine.dispatch(command);
    return Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const project = model.projects.find((entry) => entry.id === command.projectId);
      const workspace = command.worktreePath ?? project?.workspaceRoot;
      if (!workspace)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Unknown project workspace.",
        });
      return yield* withWorktreeLifecycleLock(
        workspace,
        validateCreationAttachment(command).pipe(
          Effect.mapError(
            (error) =>
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: error.message,
              }),
          ),
          Effect.andThen(engine.dispatch(command)),
        ),
      );
    }).pipe(
      Effect.catchTag("RepositoryLifecycleError", (error) =>
        Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: error.message,
          }),
        ),
      ),
    );
  };

  const runBootstrapTurnStart = Effect.fnUntraced(function* (input: {
    readonly command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
    readonly submissionSource: SubmissionSource;
  }) {
    const prepared = yield* prepareTurnStartCommand({ command: input.command });
    yield* stampSubmissionSource(
      prepared.command.commandId,
      prepared.command.threadId,
      input.submissionSource,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    let rolledBack: BootstrapThreadDisposition | null = null;
    return yield* dispatchBootstrapTurnStart({
      command: prepared.command,
      orchestrationEngine: {
        ...input.orchestrationEngine,
        dispatch: (command) => dispatchWithCreationAttachment(input.orchestrationEngine, command),
      },
      git: { ...git, createWorktree: createConfiguredWorktree },
      prepareNestedWorktrees: (worktree) =>
        Effect.gen(function* () {
          const model = yield* input.orchestrationEngine.getReadModel();
          const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(worktree.cwd));
          const project = yield* Effect.findFirst(model.projects, (entry) =>
            entry.deletedAt !== null
              ? Effect.succeed(false)
              : Effect.tryPromise(() => canonicalWorktreePath(entry.workspaceRoot)).pipe(
                  Effect.map((root) => root === canonical),
                  Effect.orElseSucceed(() => false),
                ),
          );
          if (Option.isNone(project)) return;
          const repositories = yield* discoverConfiguredProjectRepositories(
            project.value,
            git,
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
          const selected = yield* selectNestedWorktreeRepositories(
            repositories,
            worktree.repositoryPaths,
          );
          const layoutCreate = project.value.scripts.find(
            (script) => script.worktreeLayout === "create",
          )?.command;
          if (selected.length === 0 && !layoutCreate) return;
          if (!git.prepareWorktreeGroup)
            return yield* Effect.fail(new Error("Worktree group setup is unavailable."));
          yield* withWorktreeLifecycleLock(
            worktree.path,
            git.prepareWorktreeGroup({
              ...(layoutCreate ? { layoutCreate } : {}),
              rooted: true,
              projectId: project.value.id,
              threadId: prepared.command.threadId,
              projectRoot: worktree.cwd,
              path: worktree.path,
              branch: worktree.branch,
              baseBranch: worktree.baseBranch,
              repositories: repositories.map(({ path }) => path),
              selected: selected.map(({ path }) => path),
            }),
          );
        }).pipe(
          Effect.mapError(
            (error) =>
              new GitCommandError({
                operation: "bootstrap",
                cwd: worktree.cwd,
                command: "prepare nested worktrees",
                detail: error.message,
              }),
          ),
        ),
      rollbackWorktree: (receipt, ownedTerminalId) =>
        Effect.gen(function* () {
          if (ownedTerminalId)
            yield* terminalManager.close({
              threadId: prepared.command.threadId,
              terminalId: ownedTerminalId,
            });
          return yield* removeWorktreeSafely({
            projectCwd: receipt.cwd,
            path: receipt.path,
            policy: {
              kind: "ownedRollback",
              ownThreadId: prepared.command.threadId,
              ownedCreation: { ...receipt, created: true },
            },
          });
        }).pipe(
          Effect.provideService(GitCore, git),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.provideService(OrchestrationEngineService, input.orchestrationEngine),
          Effect.provideService(NextTurnQueueStore, nextTurnQueueStore),
          Effect.provideService(TerminalManager, terminalManager),
          Effect.provideService(ProviderService, providerService),
          Effect.flatMap((result) =>
            result.blockedReasons.length
              ? Effect.fail(new Error(`Worktree retained: ${result.blockedReasons.join("; ")}`))
              : Effect.void,
          ),
          Effect.mapError(
            (error) =>
              new GitCommandError({
                operation: "bootstrap.rollback",
                cwd: receipt.cwd,
                command: "worktree remove",
                detail: error.message,
              }),
          ),
        ),
      ...(prepared.attachmentIngress.attachments.length > 0
        ? {
            persistAttachments: persistPreparedAttachmentIngress(prepared.attachmentIngress).pipe(
              Effect.asVoid,
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
            discardAttachments: discardPreparedAttachmentIngress(prepared.attachmentIngress).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          }
        : {}),
      projectSetupScriptRunner: {
        runForThread: (request) =>
          Effect.gen(function* () {
            if (!request.worktreePath)
              return yield* input.projectSetupScriptRunner.runForThread(request);
            const { worktreePreparation } = yield* awaitOrchestrationRuntimeForRoute;
            const model = yield* input.orchestrationEngine.getReadModel();
            const thread = model.threads.find((thread) => thread.id === request.threadId);
            if (thread?.branch)
              yield* worktreePreparation.prepare({
                threadId: thread.id,
                projectId: thread.projectId,
                worktreePath: request.worktreePath,
                branch: thread.branch,
              });
            return { status: "no-script" as const };
          }),
      },
      worktreesDir: serverConfig.worktreesDir,
      onThreadRolledBack: (disposition) => {
        rolledBack = disposition;
      },
    }).pipe(
      Effect.mapError((error) =>
        rolledBack === null
          ? error
          : new RouteRequestError({
              message: error.message,
              code:
                rolledBack === "deleted"
                  ? BOOTSTRAP_THREAD_DELETED_ERROR_CODE
                  : BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
            }),
      ),
    );
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
    /** Provenance stamped on a turn start; the first stamp for a command wins. */
    readonly submissionSource: SubmissionSource;
  }) {
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

    if (input.command.type === "thread.snooze") {
      const createdAt = new Date().toISOString();
      const createdAtMs = Date.parse(createdAt);
      const untilMs = Date.parse(input.command.until);
      if (
        !Number.isFinite(untilMs) ||
        untilMs <= createdAtMs ||
        untilMs > createdAtMs + 365 * 24 * 60 * 60 * 1_000
      ) {
        return yield* new RouteRequestError({
          message: "Snooze time must be in the future and no more than one year away.",
        });
      }
      return { ...input.command, createdAt } satisfies OrchestrationCommand;
    }

    if (
      input.command.type === "thread.pins.replace" ||
      input.command.type === "thread.pins.import-legacy" ||
      input.command.type === "thread.unsnooze"
    ) {
      return {
        ...input.command,
        createdAt: new Date().toISOString(),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "thread.turn.steer")
      return yield* new RouteRequestError({
        message: "Steers must be submitted through the durable queue.",
      });
    if (input.command.type === "thread.user-input.respond") {
      yield* stampSubmissionSource(
        CommandId.makeUnsafe(`answer-delivery:${input.command.commandId}`),
        input.command.threadId,
        "human",
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }
    if (input.command.type === "thread.user-input.respond" && input.command.attachments?.length) {
      const command = input.command;
      const prepared = yield* prepareTurnStartCommand({
        command: {
          type: "thread.turn.start",
          commandId: command.commandId,
          threadId: command.threadId,
          message: {
            messageId: MessageId.makeUnsafe(answerMessageIdFor(command.commandId)),
            role: "user",
            text: JSON.stringify(command.answers),
            attachments: command.attachments ?? [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: command.createdAt,
        },
      });
      const persisted = yield* persistPreparedTurnStartCommand(prepared);
      return {
        ...command,
        attachments: persisted.message.attachments,
      } satisfies OrchestrationCommand;
    }
    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const prepared = yield* prepareTurnStartCommand({ command: input.command });
    yield* stampSubmissionSource(
      prepared.command.commandId,
      prepared.command.threadId,
      input.submissionSource,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return yield* persistPreparedTurnStartCommand(prepared);
  });

  /**
   * Once a turn's attachments are committed as independent message/queue copies,
   * the draft's upload staging is no longer needed. Release it so sent bytes stop
   * counting against the draft and profile quotas. Call only after the send has
   * committed: failures before that keep the uploads so the restored draft can retry.
   */
  const releaseSentUploads = (
    threadId: ThreadId,
    attachments: ReadonlyArray<{ readonly type: string; readonly uploadId?: string }>,
  ) => {
    const uploadIds = attachments.flatMap((attachment) =>
      attachment.type === "upload" && attachment.uploadId ? [attachment.uploadId] : [],
    );
    return uploadIds.length === 0
      ? Effect.void
      : attachmentUploads
          .releaseUploads(threadId, uploadIds)
          .pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "Releasing sent attachment uploads failed; they will expire on their own.",
              ),
            ),
          );
  };

  const removePersistedTurnAttachments = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ) =>
    discardAttachmentIngress({
      attachments: command.message.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
      commandId: command.commandId,
    });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer(
    createHttpRequestListener({
      port,
      mode,
      devUrl,
      staticDir,
      attachmentsDir: serverConfig.attachmentsDir,
      backendIncarnation: BACKEND_INCARNATION,
      serverAuth,
      htmlPreviewBroker,
      forgeAccounts,
      githubAccount,
      getRuntimeReadiness: () => runtimeReadiness,
      getAwaitOrchestrationEngine: () =>
        Effect.map(
          awaitOrchestrationRuntimeForRoute,
          ({ orchestrationEngine }) => orchestrationEngine,
        ),
      getAgentBridgeTurns: () => agentBridgeTurns,
      readStartupSnapshot: (body, transport) => readStartupSnapshot(body, transport),
      backupService,
      attachmentUploads,
      getWorkspaceAssetAuthorizer: () => workspaceAssetAuthorizer,
      getCheckedInProjectFileService: () => checkedInProjectFileService,
      fileSystem,
      path,
    }),
  );
  guardHttpResponseWriteErrors(httpServer, (code) => {
    void Effect.runPromise(
      Effect.logWarning("Unexpected HTTP response or upgrade write error", { code }),
    );
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WEB_SOCKET_MAX_PAYLOAD_BYTES,
    perMessageDeflate: resolveServerPerMessageDeflate(),
  });

  const socketLiveness = makeSocketLiveness();
  yield* Effect.addFinalizer(() => Effect.sync(() => socketLiveness.dispose()));
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

  const closeAllClients = Effect.promise(() =>
    closeSocketsWithin(
      wss.clients,
      performance.now() +
        Math.max(0, (Option.getOrUndefined(shutdown)?.deadline ?? Date.now() + 1500) - Date.now()),
    ),
  ).pipe(Effect.andThen(Ref.set(clients, new Set())));

  yield* registerShutdown("websockets", "producers", () => closeAllClients);
  const listenOptions = host ? { host, port } : { port };
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const projectionWorkspaceQuery = yield* ProjectionWorkspaceQuery;
  const workspaceAssetAuthorizer = makeWorkspaceAssetAuthorizer({
    attachmentsRoot: serverConfig.attachmentsDir,
    resolveProjectWorkspaceRoot: async (projectId) => {
      const workspace = await Effect.runPromise(
        projectionWorkspaceQuery.getProjectWorkspace(ProjectId.makeUnsafe(projectId)),
      );
      // The scratch root is shared by every thread without a project; only a thread scope
      // reaches one of its folders.
      return Option.match(workspace, {
        onNone: () => null,
        onSome: (value) => (isScratchProject(value) ? null : value.workspaceRoot),
      });
    },
    resolveThreadWorkspaceRoot: async (threadId) => {
      const workspace = await Effect.runPromise(
        projectionWorkspaceQuery.getThreadWorkspace(ThreadId.makeUnsafe(threadId)),
      );
      return Option.match(workspace, {
        onNone: () => null,
        onSome: (value) => value.workspaceRoot,
      });
    },
  });
  const settingsForWorkspace = (workspace: string) =>
    Effect.gen(function* () {
      const global = yield* serverSettings.getSettings;
      const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
      const model = yield* orchestrationEngine.getReadModel();
      const linked = model.threads.find((t) => t.worktreePath === workspace && !t.deletedAt);
      const project = linked
        ? model.projects.find((p) => p.id === linked.projectId && p.deletedAt === null)
        : model.projects
            .filter((p) => !p.deletedAt && isInsideProjectWorkspace(p.workspaceRoot, workspace))
            .sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length)[0];
      return project ? (yield* readProjectSettings(global, project)).settings : global;
    });
  const createConfiguredWorktree: typeof git.createWorktree = (input) =>
    Effect.gen(function* () {
      const settings = yield* settingsForWorkspace(input.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "createWorktree",
              cwd: input.cwd,
              command: "resolve project settings",
              detail: cause.message,
            }),
        ),
      );
      return yield* git.createWorktree({ ...input, submodules: settings.worktreeSubmodules });
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
  // Open files and visible directories per client; released on disconnect.
  const workspaceWatchRegistry = new WorkspaceWatchRegistry<WebSocket>({
    notify: (client, notification) => {
      void Effect.runPromise(
        pushBus.publishClient(client, WS_CHANNELS.projectsWatchedPathsChanged, notification),
      );
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => workspaceWatchRegistry.dispose()));
  yield* registerShutdown("workspace-watchers", "admission", () =>
    Effect.sync(() => workspaceWatchRegistry.dispose()),
  );
  const threadCommandExecutionQuery = yield* ThreadCommandExecutionQuery;
  const threadFileChangeQuery = yield* ThreadFileChangeQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const { openInEditor, revealInFileManager } = yield* Open;
  const orchestrationPrepared = yield* Deferred.make<void, ServerLifecycleError>();
  const orchestrationRuntime = yield* Deferred.make<
    OrchestrationRuntimeServices,
    ServerLifecycleError
  >();
  /** Revision 0 is `starting`; the single transition to ready or failed is revision 1. */
  let runtimeReadiness: ServerRuntimeReadiness = { state: "starting", revision: 0 };
  const currentRuntimeReadiness = (): ServerRuntimeReadiness => {
    if (runtimeReadiness.state !== "starting") return runtimeReadiness;
    const phase = getCurrentStartupPhase()?.phase;
    return phase ? { ...runtimeReadiness, phase } : runtimeReadiness;
  };
  // Requests that still park inside a route while the runtime starts. A
  // runtime-dependent request is answered `ServerStarting` before admission,
  // so every arrival here is a policy misclassification. Arrivals are counted
  // as they happen; every parked request resumes at readiness, so the earliest
  // arrival bounds the longest wait.
  const runtimeParkedByMethod = new Map<string, number>();
  let firstRuntimeParkedAt: number | null = null;
  const noteRuntimeParked = (method: string) => {
    const count = runtimeParkedByMethod.get(method) ?? 0;
    runtimeParkedByMethod.set(method, count + 1);
    firstRuntimeParkedAt ??= Date.now();
    if (count === 0)
      logger.warn("rpc method policy misclassified a runtime-dependent route", { method });
  };
  const logRuntimeParking = () => {
    if (firstRuntimeParkedAt === null) return;
    logger.info("requests parked while the orchestration runtime started", {
      parkedByMethod: Object.fromEntries(runtimeParkedByMethod),
      maxParkedMs: Date.now() - firstRuntimeParkedAt,
    });
  };
  const nextTurnQueueDispatcherRef = yield* Ref.make<NextTurnQueueDispatcherShape | null>(null);

  yield* Effect.gen(function* () {
    while (true) {
      yield* attachmentUploads.sweep.pipe(
        Effect.catch(() => Effect.logWarning("Attachment upload cleanup failed; will retry.")),
      );
      yield* Effect.tryPromise(() => sweepWorkflowAttachments(workflowAttachmentsDir)).pipe(
        Effect.flatMap(({ failed }) =>
          failed > 0
            ? Effect.logWarning("Some workflow attachments could not be removed; will retry.", {
                failed,
              })
            : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Workflow attachment cleanup failed; will retry.", { cause }),
        ),
      );
      yield* Effect.sleep("1 hour");
    }
  }).pipe(Effect.forkScoped);

  const previewFileServer = makePreviewFileServer(workspaceAssetAuthorizer);
  yield* Effect.addFinalizer(() => Effect.promise(previewFileServer.close));
  const subscriptionsScope = yield* Scope.make("sequential");
  const reconcileWorktreeBranch = (
    engine: import("./orchestration/Services/OrchestrationEngine.ts").OrchestrationEngineShape,
    cwd: string,
    branch: string | null,
  ) =>
    Effect.gen(function* () {
      const prepare = git.prepareObservedWorktreeBranch;
      if (!prepare || !branch || isTemporaryWorktreeBranch(branch)) return;
      if (!(yield* serverSettings.getSettings).followWorktreeBranchChanges) return;
      const target = NodePath.resolve(cwd);
      const model = yield* engine.getReadModel();
      const { projects, threads } = model;
      const candidates = threads.filter(
        (thread) => thread.deletedAt === null && thread.worktreePath !== null,
      );
      let thread = candidates.find((thread) => NodePath.resolve(thread.worktreePath!) === target);
      if (!candidates.length || thread?.branch === branch) return;
      if (!thread) {
        const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(target));
        let memberOwner: (typeof candidates)[number] | undefined;
        for (const candidate of candidates) {
          const candidatePath = yield* Effect.tryPromise(() =>
            canonicalWorktreePath(candidate.worktreePath!),
          ).pipe(Effect.orElseSucceed(() => null));
          if (candidatePath === canonical) {
            thread = candidate;
            break;
          }
          if (!candidatePath || !git.readWorktreeGroup || !pathContains(candidatePath, canonical))
            continue;
          const group = yield* git.readWorktreeGroup(candidatePath);
          if (
            group?.threadId === candidate.id &&
            group.members.some((member) => member.path === canonical)
          )
            memberOwner = candidate;
        }
        thread ??= memberOwner;
      }
      const worktreePath = thread?.worktreePath;
      if (
        !thread ||
        !worktreePath ||
        thread.branch === branch ||
        thread.session?.activeTurnId ||
        thread.latestTurn?.state === "running"
      )
        return;
      const project = projects.find(
        (project) => project.id === thread.projectId && project.deletedAt === null,
      );
      if (!project) return;
      const verifyOwnership = (current: typeof model) =>
        Effect.gen(function* () {
          if (!(yield* followsCheckoutBranchAtTurnEnd(current, thread.id, worktreePath, branch)))
            return yield* Effect.fail(
              new Error("The worktree is shared with another conversation."),
            );
        });
      const mapInvariant = (error: { message: string }) =>
        new OrchestrationCommandInvariantError({
          commandType: "thread.meta.update",
          detail: error.message,
        });
      yield* verifyOwnership(model);
      const prepared = yield* prepare({
        projectRoot: project.workspaceRoot,
        path: worktreePath,
        threadId: thread.id,
        previousBranch: thread.branch,
        branch,
      });
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("server:worktree-branch:" + randomUUID()),
          threadId: thread.id,
          branch,
          worktreePath,
          expectedBranch: thread.branch,
          expectedWorktreePath: worktreePath,
        })
        .pipe(
          Effect.provideService(WorkspaceWriteContext, {
            expected: {
              branch: thread.branch,
              worktreePath,
              sessionUpdatedAt: thread.session?.updatedAt ?? null,
            },
            observation: true,
            verifyObservation: engine.getReadModel().pipe(
              Effect.flatMap((current) =>
                current === model ? Effect.void : verifyOwnership(current),
              ),
              Effect.andThen(prepared.verifyBranch),
              Effect.mapError(mapInvariant),
            ),
            commitObservation: prepared.commit.pipe(Effect.mapError(mapInvariant)),
          }),
        );
    });
  const pendingBranchObservations = new Map<string, { branch: string | null }>();
  const failedBranchObservations = new Map<string, { branch: string; retryAfter: number }>();
  const observeWorktreeBranch = (
    engine: Parameters<typeof reconcileWorktreeBranch>[0],
    cwd: string,
    branch: string | null,
  ) =>
    Effect.suspend(() => {
      const target = NodePath.resolve(cwd);
      const failed = failedBranchObservations.get(target);
      if (failed?.branch === branch && failed.retryAfter > Date.now()) return Effect.void;
      failedBranchObservations.delete(target);
      const pending = pendingBranchObservations.get(target);
      if (pending) {
        pending.branch = branch;
        return Effect.void;
      }
      if (!branch || pendingBranchObservations.size >= 64) return Effect.void;
      const observation: { branch: string | null } = { branch };
      pendingBranchObservations.set(target, observation);
      return Effect.gen(function* () {
        let observed: string | null;
        do {
          observed = observation.branch;
          const attemptedBranch = observed;
          if (attemptedBranch)
            yield* reconcileWorktreeBranch(engine, target, observed).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  if (observation.branch !== attemptedBranch) return;
                  if (failedBranchObservations.size >= 64) {
                    const oldest = failedBranchObservations.keys().next().value;
                    if (oldest !== undefined) failedBranchObservations.delete(oldest);
                  }
                  failedBranchObservations.set(target, {
                    branch: attemptedBranch,
                    retryAfter: Date.now() + 30_000,
                  });
                }),
              ),
            );
        } while (observed !== observation.branch);
      }).pipe(
        Effect.ensuring(Effect.sync(() => pendingBranchObservations.delete(target))),
        Effect.forkIn(subscriptionsScope),
        Effect.asVoid,
      );
    });
  if (git.subscribeStatusRefresh) {
    const unsubscribe = yield* git.subscribeStatusRefresh((cwd) => {
      Effect.runFork(pushBus.publishAll(WS_CHANNELS.gitStatusInvalidated, { cwd }));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  }

  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  let wakeUpstreamPorts: (threadId?: string) => Effect.Effect<void> = () => Effect.void;
  yield* Stream.runForEach(serverSettings.streamChanges, () => wakeUpstreamPorts()).pipe(
    Effect.forkIn(subscriptionsScope),
  );
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
  // Agents and terminals include this file, so author changes apply to running sessions.
  const syncProfileGitAuthor = (settings: {
    gitAuthorName?: string | undefined;
    gitAuthorEmail?: string | undefined;
  }) =>
    Effect.promise(() =>
      writeProfileGitAuthorConfig(
        serverConfig.stateDir,
        settings.gitAuthorName ?? "",
        settings.gitAuthorEmail ?? "",
      ).catch(() => {}),
    );
  yield* serverSettings.getSettings.pipe(
    Effect.flatMap(syncProfileGitAuthor),
    Effect.orElseSucceed(() => undefined),
  );
  yield* Stream.runForEach(serverSettings.streamChanges, syncProfileGitAuthor).pipe(
    Effect.forkIn(subscriptionsScope),
  );
  yield* Stream.runForEach(serverSettings.streamChanges, (settings) =>
    Effect.all({
      computerPolicy: Option.isSome(computerAutomationBroker)
        ? Effect.promise(() => computerAutomationBroker.value.refreshPolicies())
        : Effect.void,
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
      Effect.tap(() => wakeUpstreamPorts()),
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(providerUpdateAdvisor.streamChanges, (advisories) =>
    pushBus.publishAll(WS_CHANNELS.providerAdvisoriesUpdated, { advisories }),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(prHub.streamChanges, (snapshot) =>
    pushBus.publishAll(PR_HUB_WS_CHANNELS.changed, snapshot),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(prHubAdvisory.streamAdvisories, (snapshot) =>
    pushBus.publishAll(PR_HUB_WS_CHANNELS.advisoriesUpdated, snapshot),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Stream.runForEach(codexMcpEventBus.streamStatusUpdates, (event) =>
    pushBus.publishAll(WS_CHANNELS.mcpStatusUpdated, event),
  ).pipe(Effect.forkIn(subscriptionsScope));
  if (diskSpaceMonitor._tag === "Some")
    yield* Stream.runForEach(diskSpaceMonitor.value.changes, (status) =>
      pushBus.publishAll(WS_CHANNELS.storageDiskSpaceUpdated, status),
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
      // An explicit gate keeps startup/readiness fixtures independent of module caches.
      yield* options.orchestrationStartupGate ?? Effect.void;
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
      const providerHandoffStates = Option.getOrUndefined(
        ServiceMap.getOption(orchestrationRuntimeServices, ProviderHandoffStateRepository),
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
      const mcpApps = ServiceMap.get(orchestrationRuntimeServices, McpAppService);
      const threadSettlement = ServiceMap.get(
        orchestrationRuntimeServices,
        ThreadSettlementService,
      );
      const pullRequestWatches = ServiceMap.get(
        orchestrationRuntimeServices,
        PullRequestWatchService,
      );
      const worktreeManager = ServiceMap.get(orchestrationRuntimeServices, WorktreeManager);
      const workspaceTransition = ServiceMap.get(orchestrationRuntimeServices, WorkspaceTransition);
      const worktreeSetup = ServiceMap.get(orchestrationRuntimeServices, WorktreeSetup);
      const worktreePreparation = ServiceMap.get(orchestrationRuntimeServices, WorktreePreparation);
      const storageCleanupWorker = ServiceMap.get(
        orchestrationRuntimeServices,
        StorageCleanupWorker,
      );
      const projectSkillSyncService = ServiceMap.get(
        orchestrationRuntimeServices,
        ProjectSkillSyncService,
      );
      const defaultBranchAutoPull = ServiceMap.get(
        orchestrationRuntimeServices,
        DefaultBranchAutoPull,
      );

      if (
        Option.isSome(threadMcpBroker) &&
        Option.isSome(threadMcpFederation) &&
        Option.isSome(prHubExtensions)
      ) {
        const html = yield* makeHtmlRenderRuntime({
          engine: orchestrationEngine,
          internalPaths: [serverConfig.stateDir],
          attachmentsDir: serverConfig.attachmentsDir,
          preview: htmlPreviewBroker,
        });
        const publishImage = yield* makeThreadImagePublisher({
          engine: orchestrationEngine,
          attachmentsDir: serverConfig.attachmentsDir,
        });
        const threadContextRepositories = yield* Effect.gen(function* () {
          return {
            messages: yield* ProjectionThreadMessageRepository,
            plans: yield* ProjectionThreadProposedPlanRepository,
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ProjectionThreadMessageRepositoryLive,
              ProjectionThreadProposedPlanRepositoryLive,
            ),
          ),
        );
        yield* threadMcpBroker.value
          .register(
            makeThreadToolHandler({
              ...threadContextRepositories,
              sql,
              engine: orchestrationEngine,
              federation: threadMcpFederation.value,
              guides: prHubReviewGuide,
              watches: pullRequestWatches,
              settlement: threadSettlement,
              links: prHubExtensions.value,
              pullRequests: makePullRequestMcpHandler({
                federation: threadMcpFederation.value,
                extensions: prHubExtensions.value,
                git: gitManager,
                engine: orchestrationEngine,
              }),
              html,
              publishImage,
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, subscriptionsScope), Effect.orDie);
      }

      const refreshTurnGitStatus = makeTurnGitStatusRefresh({
        scope: subscriptionsScope,
        resolveCwd: (threadId) =>
          Effect.gen(function* () {
            const model = yield* orchestrationEngine.getReadModel();
            const thread = model.threads.find((thread) => thread.id === threadId);
            const project = model.projects.find((project) => project.id === thread?.projectId);
            return thread ? threadWorkspaceCwd(thread, project) : null;
          }),
        read: (cwd) =>
          gitManager
            .status({ cwd, includeRemote: false, includePullRequest: false })
            .pipe(Effect.orElseSucceed(() => null)),
        publish: (cwd, status) =>
          pushBus
            .publishAll(WS_CHANNELS.gitStatusInvalidated, { cwd, status })
            .pipe(Effect.andThen(observeWorktreeBranch(orchestrationEngine, cwd, status.branch))),
      });
      yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          if (event.type.startsWith("project.")) profileReadCache = undefined;
          if (
            event.type === "project.deleted" &&
            Object.hasOwn(
              (yield* serverSettings.getSettings).projectSettingsOverrides,
              event.aggregateId,
            )
          ) {
            yield* serverSettings
              .updateSettings({ projectSettingsOverrides: { [event.aggregateId]: null } })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Failed to prune deleted project settings", { error }),
                ),
              );
          }
          yield* pushBus.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event);
          if (event.type === "thread.turn-processing-quiesced") {
            yield* refreshTurnGitStatus(event.payload.threadId);
          }
          if (event.type === "thread.turn-processing-quiesced" || event.type === "thread.deleted")
            yield* wakeUpstreamPorts(event.aggregateId);
          const gitStatusInvalidation = resolveGitStatusInvalidation(event);
          if (gitStatusInvalidation.publish) {
            yield* pushBus.publishAll(WS_CHANNELS.gitStatusInvalidated, {
              cwd: gitStatusInvalidation.cwd,
            });
          }
        }),
      ).pipe(Effect.forkIn(subscriptionsScope, { startImmediately: true }));
      yield* Stream.runForEach(nextTurnQueueDispatcher.changes, (threadId) =>
        nextTurnQueueDispatcher.getSnapshot(threadId).pipe(
          Effect.flatMap((snapshot) =>
            pushBus.publishAll(WS_CHANNELS.nextTurnQueueUpdated, snapshot),
          ),
          Effect.tap(() => wakeUpstreamPorts(threadId)),
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
            strategy: "shape",
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

      yield* Stream.runForEach(worktreeSetup.changes, (payload) =>
        pushBus.publishAll(WS_CHANNELS.worktreeSetupUpdated, payload).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to publish worktree setup progress", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ).pipe(Effect.forkIn(subscriptionsScope));

      // Before the queue dispatcher starts, so a setup that was running at
      // shutdown is already recorded as failed when its queue is examined.
      yield* Deferred.succeed(orchestrationPrepared, undefined);
      yield* Effect.tryPromise(waitForActivation).pipe(
        Effect.mapError(
          (cause) => new ServerLifecycleError({ operation: "updateActivation", cause }),
        ),
      );
      yield* Scope.provide(worktreeSetup.startup, subscriptionsScope);
      // Clears a scheduled compaction's request now, and runs it once startup is ready.
      yield* Scope.provide(
        storageMaintenance.startScheduledCompaction(
          Deferred.await(orchestrationRuntime).pipe(Effect.ignore),
        ),
        subscriptionsScope,
      );
      // Registered before the reactors start writing, so the first corruption
      // error still finds the engine's read model intact.
      yield* Scope.provide(
        startDatabaseDamageTripwire({
          stateDir: serverConfig.stateDir,
          getReadModel: orchestrationEngine.getReadModel(),
          publish: (damage) =>
            pushBus.publishAll(WS_CHANNELS.serverDatabaseDamaged, damage).pipe(Effect.asVoid),
        }),
        subscriptionsScope,
      );
      yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
      yield* Scope.provide(providerSessionReaper.start(), subscriptionsScope);
      let lastStorageRevision = -1;
      let lastCompletedOperation: string | null = null;
      yield* Effect.forever(
        Effect.gen(function* () {
          const status = yield* storageMaintenance.getStatus;
          if (status.revision !== lastStorageRevision) {
            lastStorageRevision = status.revision;
            const bounded =
              Buffer.byteLength(JSON.stringify(status)) > 7 * 1024 && status.cleanup
                ? { ...status, cleanup: { ...status.cleanup, result: null } }
                : status;
            yield* pushBus.publishAll(WS_CHANNELS.storageStatusUpdated, bounded);
            if (
              status.cleanup?.completedAt &&
              status.cleanup.operationId !== lastCompletedOperation
            ) {
              lastCompletedOperation = status.cleanup.operationId;
              yield* pushBus.publishAll(WS_CHANNELS.storageInvalidated, {
                reason: "cleanup-completed",
                operationId: status.cleanup.operationId,
              });
              if (diskSpaceMonitor._tag === "Some")
                yield* diskSpaceMonitor.value.noteStorageChanged;
            }
          }
          yield* Effect.sleep("500 millis");
        }),
      ).pipe(Effect.forkIn(subscriptionsScope));
      yield* Scope.provide(storageCleanupWorker.start, subscriptionsScope);
      yield* Stream.runForEach(pullRequestWatches.changes, (threadId) =>
        pushBus.publishAll(PR_WATCH_CHANGED_CHANNEL, { threadId }),
      ).pipe(Effect.forkIn(subscriptionsScope));
      yield* Scope.provide(pullRequestWatches.start, subscriptionsScope);
      yield* Scope.provide(threadSettlement.start, subscriptionsScope);
      yield* Scope.provide(defaultBranchAutoPull.start, subscriptionsScope);
      yield* Scope.provide(
        startKeepAwake(orchestrationEngine, serverSettings, { desktop: mode === "desktop" }),
        subscriptionsScope,
      );
      if (diskSpaceMonitor._tag === "Some")
        yield* Scope.provide(
          diskSpaceMonitor.value.start({
            estimateReclaimable: storageMaintenance.summarizeReclaimable,
            pendingCompaction: storageMaintenance.getPendingCompaction,
          }),
          subscriptionsScope,
        );
      yield* Ref.set(nextTurnQueueDispatcherRef, nextTurnQueueDispatcher);
      yield* readiness.markOrchestrationSubscriptionsReady;
      yield* Deferred.succeed(orchestrationRuntime, {
        mcpApps,
        threadSettlement,
        pullRequestWatches,
        threadBackgroundWork,
        usageService,
        orchestrationEngine,
        providerCommandReactor,
        providerTurnDeliveryWorker,
        providerSessionDirectory,
        providerHandoffStates,
        workflowService,
        codeReviewWorkflowService,
        investigationWorkflowService,
        projectSetupScriptRunner,
        storageMaintenance,
        nextTurnQueueDispatcher,
        worktreeSetup,
        worktreePreparation,
        storageCleanupWorker,
        worktreeManager,
        workspaceTransition,
        projectSkillSyncService,
        defaultBranchAutoPull,
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
          orchestrationPrepared,
          new ServerLifecycleError({ operation: "orchestrationPrepare", cause }),
        );
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
  const orchestrationRuntimeStartedAtMs = Date.now();
  yield* startOrchestrationRuntime.pipe(Effect.forkIn(subscriptionsScope));
  // Clients hold runtime-dependent requests while this reports `starting`,
  // instead of parking them in route slots for the whole startup.
  yield* Deferred.await(orchestrationRuntime).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.succeed<ServerRuntimeReadiness>({ state: "ready", revision: 1 }),
      onFailure: (error) =>
        Effect.succeed<ServerRuntimeReadiness>({
          state: "failed",
          revision: 1,
          message: formatServerLifecycleRouteFailure(error),
        }),
    }),
    Effect.flatMap((readiness) =>
      Effect.suspend(() => {
        runtimeReadiness = readiness;
        logRuntimeParking();
        return pushBus.publishAll(WS_CHANNELS.serverRuntimeReadiness, {
          ...readiness,
          backendIncarnation: BACKEND_INCARNATION,
        });
      }),
    ),
    Effect.forkIn(subscriptionsScope),
  );

  // Server-internal waits (cwd auto-bootstrap, clone completion) have no
  // client deadline, so they wait for startup to finish however long catch-up
  // takes. Startup failures still surface: they fail the Deferred.
  const awaitOrchestrationRuntimeForBootstrap = Deferred.await(orchestrationRuntime);

  const projectClones = yield* makeProjectCloneTracker({
    stateDir: serverConfig.stateDir,
    git,
    scope: subscriptionsScope,
    onComplete: (job) =>
      Effect.gen(function* () {
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForBootstrap;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(`clone:${job.operationId}`),
          projectId: job.projectId,
          title: job.directoryName,
          workspaceRoot: job.destination,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: job.createdAt,
        });
      }),
  }).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "loadProjectClones", cause })),
  );

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  // A trial resumes an existing profile; it must not bootstrap a project before activation.
  if (autoBootstrapProjectFromCwd && process.env.F5_UPDATE_TRIAL !== "1") {
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
        bootstrapProjectDefaultModel = DEFAULT_MODEL_BY_PROVIDER.codex;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel =
          existingProject.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex;
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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

  const awaitOrchestrationRuntimeForRoute = Effect.suspend(() => {
    if (runtimeReadiness.state !== "starting") return Deferred.await(orchestrationRuntime);
    // A route still parking here holds an RPC slot: the policy should have
    // answered `ServerStarting` before admission. Count it per method.
    return Effect.gen(function* () {
      const method = yield* CurrentRpcMethod;
      // The runtime may have resolved just before readiness was published.
      if (method !== null && !(yield* Deferred.isDone(orchestrationRuntime)))
        noteRuntimeParked(method);
      return yield* Deferred.await(orchestrationRuntime);
    });
  }).pipe(
    Effect.mapError(
      (error) =>
        new RouteRequestError({
          message: formatServerLifecycleRouteFailure(error),
        }),
    ),
    Effect.timeoutOrElse({
      duration: Duration.millis(ORCHESTRATION_RUNTIME_ROUTE_WAIT_MS),
      onTimeout: () =>
        Effect.suspend(() =>
          Effect.fail(
            new RouteRequestError({
              message: formatStillStartingMessage({
                phase: getCurrentStartupPhase()?.phase ?? null,
                elapsedMs: Date.now() - orchestrationRuntimeStartedAtMs,
              }),
            }),
          ),
        ),
    }),
  );
  const withTerminalThreadAccess = <A>(threadId: string, action: Effect.Effect<A, TerminalError>) =>
    Effect.gen(function* () {
      const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
      const readThread = Effect.map(orchestrationEngine.getReadModel(), (model) =>
        model.threads.find((entry) => entry.id === threadId),
      );
      const thread = yield* readThread;
      const open = Effect.gen(function* () {
        // Re-read after waiting for provider access: a purge may have deleted
        // this archived thread while the request was queued.
        const current = yield* readThread;
        if ((thread && !current) || current?.deletedAt != null)
          return yield* new RouteRequestError({ message: "This conversation has been deleted." });
        return yield* current?.worktreePath
          ? withWorktreeLifecycleLock(current.worktreePath, action).pipe(
              Effect.catchTag("RepositoryLifecycleError", (error) =>
                Effect.fail(new RouteRequestError({ message: error.message })),
              ),
            )
          : action;
      });
      // Live and draft terminals must not wait for provider startup or routing.
      // Archived/deleted threads share the purge gate and revalidate after it.
      return yield* thread && (thread.archivedAt !== null || thread.deletedAt !== null)
        ? withProviderThreadAccess(threadId, open)
        : open;
    });
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

  /**
   * Admits a turn through the durable queue (or the bootstrap path for a
   * first send). The WS route submits as `human`; the Agent Bridge submits as
   * `automation`. Retries with the same submission id replay the stored result.
   */
  const toSubmissionError = (error: { readonly message: string; readonly code?: unknown }) =>
    new RouteRequestError({
      message: error.message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    });
  const turnSubmissions = makeTurnSubmissionService({
    nextTurnQueueStore,
    awaitOrchestrationRuntimeForRoute,
    git,
    singleFlightBootstrap,
    startWorktreeSetupSubmission: (input) =>
      startWorktreeSetupSubmission(input).pipe(Effect.mapError(toSubmissionError)),
    runBootstrapTurnStart: (input) =>
      runBootstrapTurnStart(input).pipe(Effect.mapError(toSubmissionError)),
    normalizeDispatchCommand: (input) =>
      normalizeDispatchCommand(input).pipe(Effect.mapError(toSubmissionError)),
    removePersistedTurnAttachments,
    releaseSentUploads,
  });

  const submitTurnSubmission = (...args: Parameters<typeof turnSubmissions>) =>
    turnSubmissions(...args).pipe(
      Effect.mapError(
        (error) =>
          new RouteRequestError({
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
          }),
      ),
    );

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

  const toAgentBridgeHostError = (error: {
    readonly message: string;
    readonly code?: unknown;
    readonly kind?: unknown;
  }) =>
    new AgentBridgeHostError({
      message: error.message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(TURN_SUBMISSION_FAILURES.some((kind) => kind === error.kind)
        ? { submissionFailure: error.kind as (typeof TURN_SUBMISSION_FAILURES)[number] }
        : {}),
    });
  const agentBridgeTurns = yield* makeProjectionTurnRepository.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  const getSubmissionThreadDetails: AgentBridgeHostShape["getThreadDetails"] = (threadId) =>
    Effect.gen(function* () {
      const details = yield* projectionReadModelQuery.getThreadDetails({ threadId });
      const turns = yield* agentBridgeTurns.listByThreadId({ threadId });
      return bindSubmissionTurnIds(details, turns);
    }).pipe(Effect.mapError(toAgentBridgeHostError));
  const getSubmissionTurnState: AgentBridgeHostShape["getTurnState"] = (input) =>
    agentBridgeTurns.getByTurnId(input).pipe(
      Effect.map((turn) => (Option.isSome(turn) ? turn.value.state : null)),
      Effect.mapError(toAgentBridgeHostError),
    );
  const getSubmissionQueueSnapshot: AgentBridgeHostShape["getQueueSnapshot"] = (threadId) =>
    getNextTurnQueueSnapshot(threadId).pipe(Effect.mapError(toAgentBridgeHostError));
  const getTurnSubmission: AgentBridgeHostShape["getSubmission"] = (submissionId) =>
    nextTurnQueueStore
      .getBySubmissionId(submissionId)
      .pipe(Effect.mapError(toAgentBridgeHostError));
  const submissionQueueChanges = Stream.unwrap(
    awaitOrchestrationRuntimeForOptionalBackground.pipe(
      Effect.map((runtime) =>
        Option.isSome(runtime) ? runtime.value.nextTurnQueueDispatcher.changes : Stream.empty,
      ),
    ),
  );
  const submissionDomainEvents = Stream.unwrap(
    awaitOrchestrationRuntimeForOptionalBackground.pipe(
      Effect.map((runtime) =>
        Option.isSome(runtime)
          ? runtime.value.orchestrationEngine.streamDomainEvents
          : Stream.empty,
      ),
    ),
  );
  const agentBridgeHost: AgentBridgeHostShape = {
    readSnapshot: awaitOrchestrationRuntimeForRoute.pipe(
      Effect.flatMap(({ orchestrationEngine }) => orchestrationEngine.getReadModel()),
      Effect.mapError(toAgentBridgeHostError),
    ),
    ensureThreadActivities: (threadIds) =>
      awaitOrchestrationRuntimeForRoute.pipe(
        Effect.flatMap(
          ({ orchestrationEngine }) =>
            orchestrationEngine.ensureThreadActivities?.(threadIds) ?? Effect.void,
        ),
        Effect.ignore,
      ),
    getThreadDetails: (threadId) =>
      projectionReadModelQuery
        .getThreadDetails({ threadId })
        .pipe(Effect.mapError(toAgentBridgeHostError)),
    getSubmissionThreadDetails,
    getTurnState: getSubmissionTurnState,
    getThreadDiff: ({ threadId, fromTurnCount, toTurnCount }) =>
      (fromTurnCount === undefined
        ? checkpointDiffQuery.getFullThreadDiff({ threadId, toTurnCount })
        : checkpointDiffQuery.getTurnDiff({ threadId, fromTurnCount, toTurnCount })
      ).pipe(
        Effect.map((result) => result.diff),
        Effect.mapError(toAgentBridgeHostError),
      ),
    getQueueSnapshot: getSubmissionQueueSnapshot,
    getSubmission: getTurnSubmission,
    queueChanges: submissionQueueChanges,
    domainEvents: submissionDomainEvents,
    listProviderInstances: providerAdvisoryProjection.getProviders,
    getSettings: serverSettings.getSettings.pipe(Effect.mapError(toAgentBridgeHostError)),
    getProjectGitBranch: (cwd) =>
      git.status({ cwd }).pipe(
        Effect.flatMap((status) =>
          status.branch
            ? Effect.succeed(status.branch)
            : git
                .listBranches({ cwd })
                .pipe(
                  Effect.map((result) => result.branches.find((b) => b.isDefault)?.name ?? null),
                ),
        ),
        Effect.orElseSucceed(() => null),
      ),
    submitTurnSubmission: (body, options) =>
      turnSubmissions(body, options).pipe(
        Effect.mapError(toAgentBridgeHostError),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    dispatch: (command) =>
      awaitOrchestrationRuntimeForRoute.pipe(
        Effect.flatMap(({ orchestrationEngine }) => orchestrationEngine.dispatch(command)),
        Effect.asVoid,
        Effect.mapError(toAgentBridgeHostError),
      ),
  };
  const scheduledTaskStore = yield* makeScheduledTaskStore.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  let notificationWake: Effect.Effect<void> = Effect.void;
  const scheduleTextGeneration = yield* Effect.serviceOption(TextGeneration);
  const scheduledTasks = yield* makeScheduledTaskService({
    naturalLanguage: (input, now) =>
      Effect.gen(function* () {
        if (Option.isNone(scheduleTextGeneration))
          return yield* new RouteRequestError({ message: "Text generation is unavailable." });
        const project = (yield* agentBridgeHost.readSnapshot).projects.find(
          (p) => p.id === input.projectId && p.deletedAt === null,
        );
        if (!project)
          return yield* new RouteRequestError({
            message: "Choose a project for schedule conversion.",
          });
        const effective = yield* readProjectSettings(yield* serverSettings.getSettings, project);
        const selection = effective.settings.textGenerationModelSelection;
        const providers = yield* agentBridgeHost.listProviderInstances;
        return yield* parseNaturalLanguageSchedule({
          preview: input,
          now,
          cwd: project.workspaceRoot,
          modelSelection: selection,
          isCodex: providers.some(
            (p) => p.instanceId === selection.instanceId && p.driver === "codex",
          ),
          textGeneration: scheduleTextGeneration.value,
        });
      }).pipe(
        Effect.mapError((error) => scheduleError("natural_language_unavailable", error.message)),
      ),
    store: scheduledTaskStore,
    wakeQueue: (threadId) =>
      awaitOrchestrationRuntimeForRoute.pipe(
        Effect.flatMap((runtime) =>
          runtime.nextTurnQueueDispatcher
            .notify(threadId)
            .pipe(
              Effect.andThen(
                runtime.providerTurnDeliveryWorker.wakeScheduled?.(threadId) ?? Effect.void,
              ),
            ),
        ),
        Effect.ignore,
      ),
    usageAccounts: awaitOrchestrationRuntimeForRoute.pipe(
      Effect.flatMap((runtime) => runtime.usageService.getAccounts({ refresh: "none" })),
      Effect.orElseSucceed(() => []),
    ),
    host: agentBridgeHost,
    settings: serverSettings,
    publish: (payload) =>
      pushBus
        .publishAll(WS_CHANNELS.scheduledTasksChanged, payload)
        .pipe(Effect.andThen(Effect.suspend(() => notificationWake))),
  });
  yield* scheduledTasks.start.pipe(
    Effect.catchCause((cause) => Effect.logError("scheduledTasks.start", cause)),
    Effect.forkScoped,
  );
  if (Option.isSome(computerAutomationBroker)) {
    const delivery = yield* makeScheduledNotificationDelivery({
      host: computerAutomationBroker.value.host,
      service: scheduledTasks,
      store: scheduledTaskStore,
      changed: () =>
        scheduledTaskStore.readRevision.pipe(
          Effect.flatMap((revision) =>
            pushBus.publishAll(WS_CHANNELS.scheduledTasksChanged, {
              revision,
              taskIds: [],
              runIds: [],
            }),
          ),
          Effect.ignore,
        ),
    });
    notificationWake = delivery.wake;
    yield* delivery.start;
  }
  const agentBridge = yield* makeAgentBridgeService({
    schedules: scheduledTasks,
    host: agentBridgeHost,
    store: makeAgentBridgeStore(sql),
    tasks: makeBotTaskStore(sql),
    settingsChanges: yield* serverSettings.subscribeChanges,
    stateDir: serverConfig.stateDir,
    serverVersion: serverPackageVersion,
    stdio: agentBridgeStdioSetups({
      profileId: serverConfig.profile?.id,
      isDefaultProfile: serverConfig.profile?.isDefault ?? true,
      defaultStateDir: serverConfig.defaultStateDir,
    }),
    publish: (payload) => pushBus.publishAll(AGENT_BRIDGE_WS_CHANNELS.stateChanged, payload),
  });

  const upstreamGitService = yield* Effect.serviceOption(GitService);
  const upstreamGitHubCli = yield* Effect.serviceOption(GitHubCli);
  const upstreamTextGeneration = yield* Effect.serviceOption(TextGeneration);
  const asHostError = (error: unknown) =>
    error instanceof UpstreamPortsError
      ? error
      : new UpstreamPortsError({
          code: "internal",
          message: String((error as { message?: unknown })?.message ?? error),
        });
  const upstreamPorts = Option.isNone(upstreamGitService)
    ? null
    : yield* makeUpstreamPortsService({
        host: {
          readModel: awaitOrchestrationRuntimeForRoute.pipe(
            Effect.flatMap(({ orchestrationEngine }) => orchestrationEngine.getReadModel()),
            Effect.mapError(asHostError),
          ),
          checkedInConfig: (projectId) =>
            Effect.tryPromise({
              try: () => checkedInProjectFileService.load(projectId),
              catch: asHostError,
            }),
          getSettings: serverSettings.getSettings.pipe(Effect.mapError(asHostError)),
          listProviders: providerAdvisoryProjection.getProviders,
          usageAccounts: awaitOrchestrationRuntimeForRoute.pipe(
            Effect.flatMap((runtime) => runtime.usageService.getAccounts({ refresh: "none" })),
          ),
          getThreadDetails: getSubmissionThreadDetails,
          getTurnState: getSubmissionTurnState,
          getQueueSnapshot: getSubmissionQueueSnapshot,
          getSubmission: getTurnSubmission,
          queueChanges: submissionQueueChanges,
          domainEvents: submissionDomainEvents,
          cancelQueuedSubmission: (submissionId) =>
            cancelQueuedSubmission(
              nextTurnQueueStore,
              (threadId) =>
                awaitOrchestrationRuntimeForRoute.pipe(
                  Effect.flatMap((runtime) => runtime.nextTurnQueueDispatcher.notify(threadId)),
                ),
              submissionId,
            ).pipe(Effect.mapError(asHostError)),
          createCodeReviewWorkflow: (input, workflowId) =>
            awaitOrchestrationRuntimeForRoute.pipe(
              Effect.flatMap(({ codeReviewWorkflowService }) =>
                codeReviewWorkflowService.createWorkflow(input, { workflowId }),
              ),
            ),
          archiveCodeReviewWorkflow: (workflowId) =>
            awaitOrchestrationRuntimeForRoute.pipe(
              Effect.flatMap(({ codeReviewWorkflowService }) =>
                codeReviewWorkflowService.archiveWorkflow(workflowId),
              ),
            ),
          submitTurn: (body, source) =>
            // A background retry must preserve any hold the user set meanwhile.
            submitTurnSubmission(body, { submissionSource: source, resumeQueue: false }).pipe(
              Effect.mapError((error) => ({
                message: error.message,
                ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
              })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          publish: (payload) => pushBus.publishAll(UPSTREAM_PORTS_WS_CHANNELS.changed, payload),
          generateTriageBatch: Option.isSome(upstreamTextGeneration)
            ? (input) =>
                upstreamTextGeneration.value.generateStructuredJson({
                  ...input,
                  outputSchema: UpstreamTriageBatchResult,
                })
            : null,
          readDefaultBranch: (cwd) => git.readDefaultBranch(cwd),
          resolveAvailableBranchName: (cwd, name) => git.resolveAvailableBranchName(cwd, name),
          resolveCommonDir: (cwd) => git.resolveCommonDir(cwd),
          withRepositoryLock: (commonDir, mode, effect) =>
            withRepositoryLifecycleLock(serverConfig.baseDir, commonDir, effect, { mode }),
        },
        store: makeUpstreamStore(sql),
        sql,
        git: makeUpstreamGit(upstreamGitService.value.execute),
        github: Option.isSome(upstreamGitHubCli)
          ? makeUpstreamGitHub(upstreamGitHubCli.value)
          : null,
        baseDir: serverConfig.baseDir,
        writer: {
          profileId: serverConfig.profile?.id ?? "default",
          stateDir: serverConfig.stateDir,
        },
      });
  if (upstreamPorts !== null)
    wakeUpstreamPorts = (threadId) => upstreamPorts.wakePortQueue(undefined, threadId);
  if (upstreamPorts !== null)
    yield* Deferred.await(orchestrationRuntime).pipe(
      Effect.andThen(Scope.provide(upstreamPorts.start, subscriptionsScope)),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(subscriptionsScope),
    );

  const ownedPreviewUrls = new OwnedPreviewUrls();
  const unsubscribeTerminalEvents = yield* terminalManager.subscribe((event) => {
    if (event.type === "output")
      ownedPreviewUrls.append(`terminal:${event.threadId}:${event.terminalId}`, event.data);
    void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.terminalEvent, event));
  });
  yield* Stream.runForEach(providerService.streamEvents, (event) =>
    Effect.sync(() => {
      if (event.type === "content.delta" && event.payload.streamKind === "command_output")
        ownedPreviewUrls.append(`provider:${event.threadId}:${event.itemId}`, event.payload.delta);
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  const unsubscribePreviewEvents = previewManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.previewEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribePreviewEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  if (process.env.F5_UPDATE_TRIAL === "1") yield* Deferred.await(orchestrationPrepared);
  yield* Effect.tryPromise(() => awaitActivation()).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "updateActivation", cause })),
  );
  if (process.env.F5_UPDATE_TRIAL === "1") yield* awaitOrchestrationRuntimeForBootstrap;
  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.tapError((cause) => {
      if (!serverConfig.profilesRoot) return Effect.void;
      process.exitCode = 78;
      return fileSystem
        .writeFileString(
          path.join(serverConfig.profilesRoot, `last-startup-error-${activeProfile.id}.json`),
          JSON.stringify({
            message: `Could not listen on port ${port}. Another F5 profile or program may own it. Change this profile's port in Settings > Profiles.`,
            detail: String(cause),
          }),
        )
        .pipe(Effect.ignoreCause({ log: true }));
    }),
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;
  yield* prHub.startMonitoring;
  yield* Effect.sync(reportActive);

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
            threadCommandExecutionQuery,
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

  const readStartupSnapshot = (
    body: OrchestrationGetStartupSnapshotInput,
    transport: "ws" | "http",
  ) =>
    withWsThreadOpenTiming({
      method: ORCHESTRATION_WS_METHODS.getStartupSnapshot,
      threadId: body.detailThreadId ?? null,
      effect: Effect.gen(function* () {
        if (body.detailThreadId) {
          yield* reconcileThreadSnapshotsInBackground({
            threadId: body.detailThreadId,
            reason: transport + ":getStartupSnapshot",
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

  const resolveMcpAccount = async <
    T extends {
      binaryPath?: string | undefined;
      homePath?: string | undefined;
      instanceId?: import("@t3tools/contracts").ProviderInstanceId | undefined;
      provider?: string | undefined;
    },
  >(
    body: T,
  ): Promise<
    T & {
      provider: import("@t3tools/contracts").ProviderKind;
      instanceId: import("@t3tools/contracts").ProviderInstanceId;
    }
  > => {
    if (body.binaryPath !== undefined || body.homePath !== undefined)
      throw new Error(
        "Client-supplied provider executable and home paths are not accepted. Select a provider instance.",
      );
    const { ProviderInstanceId, isKnownProviderKind } = await import("@t3tools/contracts");
    const configured = deriveProviderInstanceConfigMap(
      await Effect.runPromise(serverSettings.getSettings),
    );
    const candidates = Object.entries(configured).filter(
      ([, instance]) => instance.driver === (body.provider ?? "codex"),
    );
    const defaultId = body.provider === "claudeAgent" ? "claudeAgent" : "codex";
    const selected =
      body.instanceId ??
      (candidates.some(([id]) => id === defaultId)
        ? defaultId
        : candidates.length === 1
          ? candidates[0]![0]
          : undefined);
    if (!selected) throw new Error("Select a provider instance for this MCP account operation.");
    const account = await accountService.resolve(ProviderInstanceId.make(selected));
    if (body.provider && body.provider !== account.instance.driver)
      throw new Error("Provider instance does not match the requested provider.");
    const provider = account.instance.driver;
    if (!isKnownProviderKind(provider))
      throw new Error("This provider does not support MCP account operations.");
    return {
      ...body,
      provider,
      instanceId: ProviderInstanceId.make(selected),
      ...(account.config.binaryPath ? { binaryPath: account.config.binaryPath } : {}),
      ...(account.config.homePath ? { homePath: account.config.homePath } : {}),
    };
  };

  const preparationReceipts = yield* Effect.service(WorktreePreparations).pipe(
    Effect.provide(WorktreePreparationsLive),
  );
  const prepareWorktree = yield* makeWorktreePreparation({
    scope: subscriptionsScope,
    git,
    receipts: preparationReceipts,
    createWorktree: (input) =>
      createConfiguredWorktree({
        ...input,
        preparation: {
          owner: `thread:${input.threadId}`,
          projectCwd: input.projectCwd,
          requestedBase: input.branch,
          operationId: input.operationId,
          runSetupScript: input.runSetupScript ?? true,
          setupIdentity: input.setupIdentity ?? null,
        },
      }),
    runSetup: (input) =>
      Effect.gen(function* () {
        const { orchestrationEngine, worktreePreparation } =
          yield* awaitOrchestrationRuntimeForRoute;
        const model = yield* orchestrationEngine.getReadModel();
        const project = model.projects.find(
          (p) => p.workspaceRoot === input.projectCwd && p.deletedAt === null,
        );
        if (!project || !input.worktreePath) return { status: "no-script" as const };
        const receipt = yield* preparationReceipts.latest(
          yield* Effect.promise(() => canonicalWorktreePath(input.worktreePath!)),
        );
        if (receipt)
          yield* worktreePreparation.prepare({
            threadId: input.threadId,
            projectId: project.id,
            worktreePath: input.worktreePath,
            branch: receipt.branch,
            retry: input.retry === true,
          });
        return { status: "no-script" as const };
      }),
  });

  const reviewRepositoryCache = makeWorkspaceRepositoryReadCache();
  const switchGitWorkspace =
    (threadId?: ThreadId, operationId?: string): GitWorkspaceSwitchHandler =>
    (input) =>
      Effect.gen(function* () {
        const { orchestrationEngine, workspaceTransition } =
          yield* awaitOrchestrationRuntimeForRoute;
        const readClaims = (cwd: string) =>
          withClaimServices(
            readWorktreeClaims(cwd).pipe(
              Effect.provideService(OrchestrationEngineService, orchestrationEngine),
              Effect.provideService(ProviderService, providerService),
              Effect.provideService(TerminalManager, terminalManager),
              Effect.provideService(NextTurnQueueStore, nextTurnQueueStore),
            ),
          );
        let parentWorkspace: string | undefined;
        let validateMember: Effect.Effect<void, Error> | undefined;
        if (threadId) {
          const model = yield* orchestrationEngine.getReadModel();
          const thread = model.threads.find(
            (entry) => entry.id === threadId && entry.deletedAt === null,
          );
          const project = model.projects.find((entry) => entry.id === thread?.projectId);
          const workspace = threadWorkspaceCwd(thread, project);
          if (!thread || !project || isScratchProject(project) || !workspace)
            return yield* Effect.fail(
              new Error("The checkout does not match this conversation's workspace."),
            );
          const target = yield* Effect.tryPromise(() => canonicalWorktreePath(input.cwd));
          const root = yield* Effect.tryPromise(() => canonicalWorktreePath(workspace));
          if (target !== root) {
            parentWorkspace = root;
            validateMember = Effect.gen(function* () {
              const current = (yield* orchestrationEngine.getReadModel()).threads.find(
                (entry) => entry.id === threadId && entry.deletedAt === null,
              );
              if (!current || threadWorkspaceCwd(current, project) !== workspace)
                return yield* Effect.fail(new Error("The conversation's workspace changed."));
              const repositories = yield* listWorkspaceRepositories(project, workspace, git).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              );
              const member = repositories.find((repository) => repository.path === input.cwd);
              if (
                !member ||
                member.relativePath === "." ||
                target !==
                  (member.externalSource === member.path
                    ? member.path
                    : path.resolve(root, member.relativePath)) ||
                (yield* Effect.tryPromise(() => canonicalWorktreePath(input.cwd))) !== target
              )
                return yield* Effect.fail(
                  new Error("The checkout does not match this conversation's workspace."),
                );
              const usage = yield* readClaims(root);
              if (
                usage.unknown ||
                usage.pendingTurnsChecked === false ||
                usage.activeThreadIds.length ||
                usage.queuedThreadIds.length ||
                usage.setupThreadIds.length ||
                usage.transitionThreadIds.length ||
                usage.sessions.some((session) => session.live)
              )
                return yield* Effect.fail(
                  new WorkspaceRequiresNewWorktreeError(
                    "Finish the active work in this workspace before switching a repository branch.",
                  ),
                );
            });
          } else {
            const result = yield* workspaceTransition.switchWorkspace({
              operationId: operationId ?? crypto.randomUUID(),
              threadId,
              intent: input.create ? "create_branch_and_checkout" : "checkout_branch",
              branch: input.branch,
              expected: {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                sessionUpdatedAt: thread.session?.updatedAt ?? null,
              },
            });
            if (result.phase !== "completed") {
              if (result.checkoutConflict)
                return yield* new GitCommandError({
                  operation: "GitCore.checkoutBranch.checkout",
                  cwd: input.cwd,
                  command: "git checkout",
                  detail: result.error ?? "Local changes block branch switching.",
                  checkoutConflict: result.checkoutConflict,
                });
              // Keep the code so clients can offer "Start a new worktree" here too.
              if (result.errorCode === "WorkspaceRequiresNewWorktree")
                return yield* Effect.fail(
                  new WorkspaceRequiresNewWorktreeError(
                    result.error ?? "Start a new worktree instead.",
                  ),
                );
              return yield* Effect.fail(
                new Error(result.error ?? "Inspect and resolve the workspace transition."),
              );
            }
            return;
          }
        }
        const switchCheckout = Effect.gen(function* () {
          const checkout = yield* git.inspectCheckoutIdentity(input.cwd);
          yield* withWorktreeLifecycleLock(
            checkout.canonicalRoot,
            withRepositoryLifecycleLock(
              serverConfig.baseDir,
              checkout.commonDir,
              Effect.gen(function* () {
                const current = yield* git.inspectCheckoutIdentity(input.cwd);
                if (
                  current.canonicalRoot !== checkout.canonicalRoot ||
                  current.commonDir !== checkout.commonDir ||
                  current.branch !== checkout.branch
                )
                  return yield* Effect.fail(
                    new Error(
                      "The checkout identity changed. Inspect it before switching branches.",
                    ),
                  );
                const usage = yield* readClaims(checkout.canonicalRoot);
                const model = yield* orchestrationEngine.getReadModel();
                const blockers = inPlaceSwitchBlockers(usage, {
                  requester: null,
                  projectCheckout: yield* isProjectCheckout(model, checkout.canonicalRoot),
                });
                if (blockers.length)
                  return yield* Effect.fail(
                    new WorkspaceRequiresNewWorktreeError(
                      formatInPlaceSwitchBlockers(
                        blockers,
                        (id) => model.threads.find((thread) => thread.id === id)?.title ?? null,
                      ),
                    ),
                  );
                yield* Effect.tryPromise(() =>
                  assertExclusiveProfileCheckout(serverConfig, checkout.canonicalRoot),
                ).pipe(
                  Effect.mapError((error) => (error.cause instanceof Error ? error.cause : error)),
                );
                if (input.create) yield* git.createBranch({ cwd: input.cwd, branch: input.branch });
                yield* Effect.scoped(
                  git.checkoutBranch(
                    { cwd: input.cwd, branch: input.branch },
                    { refreshUpstream: false },
                  ),
                );
              }),
            ),
          );
        });
        return yield* parentWorkspace && validateMember
          ? withWorktreeLifecycleLock(
              parentWorkspace,
              validateMember.pipe(Effect.andThen(switchCheckout)),
            )
          : switchCheckout;
      });

  // Routes that live in their own modules. `routeRequest` answers from here
  // before its switch; see `wsServer/routes/routeTable.ts`.
  const routeTable = routeTables(
    githubAccountRoutes({
      login: githubLogin,
      account: githubAccount,
      cliImport: githubCliImport,
    }),
  )
    .and(providerAccountRoutes(accountService))
    .and(
      profileRoutes({
        store: profilesStore,
        list: readProfiles,
        defaultStateDir: defaultProfileStateDir,
        activeProfileId: activeProfile.id,
        ...(serverConfig.guestProfileId ? { mutationRefusal: GUEST_PROFILE_MUTATION_REFUSAL } : {}),
      }),
    )
    .and(
      scheduledTaskRoutes({
        schedules: scheduledTasks,
        desktopShowsNotifications: () =>
          Option.isSome(computerAutomationBroker) &&
          computerAutomationBroker.value.host.notificationsCapable(),
      }),
    )
    .and(upstreamPortRoutes(upstreamPorts))
    .and(agentBridgeRoutes(agentBridge))
    .and(terminalRoutes({ terminals: terminalManager, startingShellFor: withTerminalThreadAccess }))
    .and(
      gitRoutes({
        git,
        gitManager,
        observeStatus: (cwd, branch) =>
          runtimeReadiness.state === "ready"
            ? awaitOrchestrationRuntimeForRoute.pipe(
                Effect.flatMap(({ orchestrationEngine }) =>
                  observeWorktreeBranch(orchestrationEngine, cwd, branch),
                ),
                Effect.ignore,
              )
            : Effect.void,
        switchWorkspace: switchGitWorkspace,
        publishActionProgress: (ws, event) =>
          pushBus.publishClient(ws, WS_CHANNELS.gitActionProgress, event).pipe(Effect.asVoid),
        createWorktree: createConfiguredWorktree,
        prepareWorktree,
        runtime: Effect.map(
          awaitOrchestrationRuntimeForRoute,
          ({ orchestrationEngine, worktreeManager }) => ({
            liveProjects: Effect.map(orchestrationEngine.getReadModel(), (model) =>
              model.projects.filter((project) => project.deletedAt === null),
            ),
            worktrees: worktreeManager,
          }),
        ),
      }),
    )
    .and(
      storageRoutes({
        stateDir: serverConfig.stateDir,
        path,
        sql,
        diskSpaceMonitor,
        runtime: awaitOrchestrationRuntimeForRoute,
      }),
    )
    .and(
      worktreeRoutes({
        runtime: awaitOrchestrationRuntimeForRoute,
        publishNextTurnQueueSnapshot,
      }),
    )
    .and(
      workflowRoutes({
        runtime: awaitOrchestrationRuntimeForRoute,
      }),
    )
    .and(
      prHubRoutes({
        prHub,
        prHubAdvisory,
        prHubReviewGuide,
        forgeAccounts,
        prHubExtensions,
        runtime: awaitOrchestrationRuntimeForRoute,
      }),
    )
    .and(
      mcpRoutes({
        projectMcpConfigService,
        mcpRuntimeService,
        codexMcpEventBus,
        providerService,
        profileSecrets,
        storeMcpSecret,
        resolveMcpFeatureExecution,
        resolveMcpAccount,
        runtime: awaitOrchestrationRuntimeForRoute,
      }),
    )
    .and(
      previewRoutes({
        stateDir: serverConfig.stateDir,
        fileSystem,
        path,
        previewManager,
        previewAutomationBroker,
        htmlPreviewBroker,
        computerAutomationBroker,
        ownedPreviewUrls,
        pushBus,
        providerService,
        providerInstanceRegistry,
        serverSettings,
        previewAutomationClientIdsByWs,
        previewAutomationHostIdByWs,
        getPreviewAutomationHostId,
        getServerPreviewAutomationClientId,
        authorizedPreviewAutomationClientIds,
      }),
    )
    .and(
      serverMetaRoutes({
        serverConfig,
        cwd,
        keybindingsConfigPath,
        availableEditors,
        sql,
        clientDiagnosticsReporter,
        currentRuntimeReadiness,
        keybindingsManager,
        providerAdvisoryProjection,
        providerInstanceRegistry,
        providerRegistry,
        providerUpdateAdvisor,
        harnessValidation,
        serverSettings,
        projectionProjects,
        computerAutomationBroker,
        getProjectSkillSyncServiceIfReady: Effect.gen(function* () {
          const ready = yield* Deferred.isDone(orchestrationRuntime);
          if (!ready) return Option.none();
          const resolved = yield* Deferred.await(orchestrationRuntime).pipe(Effect.option);
          return Option.map(resolved, (rt) => rt.projectSkillSyncService);
        }),
        runtime: awaitOrchestrationRuntimeForRoute,
      }),
    ).table;

  const routeRequest = Effect.fnUntraced(function* (ws: WebSocket, request: WebSocketRequest) {
    const requestCwd = (request.body as { readonly cwd?: unknown }).cwd;
    if (typeof requestCwd === "string") {
      const refusal = scratchWorkspaceRefusal({
        scratchRoot: scratchRootFor(serverConfig.stateDir),
        method: request.body._tag,
        cwd: requestCwd,
      });
      if (refusal) return yield* new RouteRequestError({ message: refusal });
    }
    if (tableAnswers(routeTable, request.body)) {
      return yield* answerFromTable(routeTable, request.body, ws);
    }
    switch (request.body._tag) {
      case AGENTS_WS_METHODS.getSnapshot: {
        const { threadBackgroundWork } = yield* awaitOrchestrationRuntimeForRoute;
        const { threadId } = stripRequestTag(request.body);
        return yield* (
          threadId === undefined
            ? threadBackgroundWork.getSnapshot
            : threadBackgroundWork.getThreadSnapshot(threadId)
        ).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: `Unable to load background work: ${error.message}`,
              }),
          ),
        );
      }

      case AGENTS_WS_METHODS.readTranscript: {
        const { threadBackgroundWork, providerSessionDirectory } =
          yield* awaitOrchestrationRuntimeForRoute;
        const input = stripRequestTag(request.body);
        const workspace = yield* projectionWorkspaceQuery
          .getThreadWorkspace(input.threadId)
          .pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({ message: "Unable to resolve the transcript workspace." }),
            ),
          );
        return yield* readAgentTranscript(input, {
          stateDir: serverConfig.stateDir,
          work: threadBackgroundWork,
          directory: providerSessionDirectory,
          service: providerService,
          resolveAccount: (id) => accountService.resolve(id),
          ...(Option.isSome(workspace) ? { cwd: workspace.value.workspaceRoot } : {}),
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.logWarning("Agent transcript read failed", {
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new RouteRequestError({
                        message:
                          "Unable to read this agent transcript. Retry or check the provider configuration.",
                      }),
                    ),
                  ),
                ),
          ),
        );
      }

      case AGENTS_WS_METHODS.dismiss: {
        const { threadBackgroundWork } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* threadBackgroundWork.dismiss(stripRequestTag(request.body)).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: `Unable to dismiss background work: ${error.message}`,
              }),
          ),
        );
      }

      case USAGE_WS_METHODS.consumeResetCredit: {
        const { usageService, nextTurnQueueDispatcher, orchestrationEngine } =
          yield* awaitOrchestrationRuntimeForRoute;
        const body = stripRequestTag(request.body);
        const after = new Date().toISOString();
        const result = yield* usageService
          .consumeResetCredit(body)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
        const limitKeys = new Map(
          (yield* orchestrationEngine.getReadModel()).threads
            .filter(
              (thread) =>
                thread.session?.usageLimit?.providerInstanceId === body.providerInstanceId,
            )
            .map((thread) => [thread.id, usageLimitKey(thread.session)]),
        );
        const refreshResumes = (attempt = 0): Effect.Effect<void> =>
          Effect.gen(function* () {
            const refreshed = yield* usageService.refreshAccount(body.providerInstanceId);
            if (!refreshed.fresh || !refreshed.snapshot) {
              const retryAt = Date.parse(refreshed.nextAllowedAt ?? "");
              if (
                (result.outcome === "reset" || result.outcome === "alreadyRedeemed") &&
                Number.isFinite(retryAt) &&
                attempt < 3
              )
                // The hint can elapse between the capability's refusal and this
                // check. Retry through its real throttle instead of dropping it.
                yield* Effect.sleep(Math.max(50, retryAt - Date.now())).pipe(
                  Effect.andThen(Effect.suspend(() => refreshResumes(attempt + 1))),
                  Effect.forkIn(subscriptionsScope),
                );
              return;
            }
            if (result.outcome !== "reset" && result.outcome !== "alreadyRedeemed") return;
            for (const thread of (yield* orchestrationEngine.getReadModel()).threads) {
              const limit = thread.session?.usageLimit;
              const key = usageLimitKey(thread.session);
              if (
                !limit ||
                !key ||
                limitKeys.get(thread.id) !== key ||
                limit.providerInstanceId !== body.providerInstanceId
              )
                continue;
              const snapshot = yield* nextTurnQueueDispatcher.getSnapshot(thread.id);
              const target = usageResumeTargetAfterCredit(
                limit,
                refreshed.snapshot,
                after,
                Date.now(),
              );
              if (!target) continue;
              const current = (yield* orchestrationEngine.getReadModel()).threads.find(
                (entry) => entry.id === thread.id,
              );
              if (usageLimitKey(current?.session) !== key) continue;
              const changed = yield* nextTurnQueueStore.rescheduleByInstance(
                body.providerInstanceId,
                target,
                { limitKey: key, revision: snapshot.revision },
              );
              for (const id of changed) yield* nextTurnQueueDispatcher.notify(id);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to update usage resumes after reset credit", { cause }),
            ),
          );
        yield* refreshResumes();
        yield* wakeUpstreamPorts();
        return result;
      }
      case USAGE_WS_METHODS.getAccounts: {
        const { usageService } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* usageService.getAccounts(stripRequestTag(request.body)).pipe(
          Effect.tap(() => wakeUpstreamPorts()),
          Effect.mapError(
            () => new RouteRequestError({ message: "Unable to load account usage." }),
          ),
        );
      }

      case NATIVE_OPERATION_WS_METHODS.fork: {
        const input = stripRequestTag(request.body);
        const {
          orchestrationEngine,
          providerSessionDirectory,
          worktreePreparation,
          providerHandoffStates,
        } = yield* awaitOrchestrationRuntimeForRoute;
        const snapshot = yield* orchestrationEngine.getReadModel();
        const source = snapshot.threads.find(
          (entry) => entry.id === input.threadId && entry.deletedAt === null,
        );
        const project = snapshot.projects.find((entry) => entry.id === source?.projectId);
        // A fork gets its own Git worktree, which a thread without a project cannot have.
        if (
          !source ||
          !project ||
          (isScratchProject(project) && !input.sideChat) ||
          (!input.sideChat && !providerService.nativeOperations?.executeWithApply)
        )
          return yield* new RouteRequestError({ message: "This conversation cannot be forked." });
        if (!/^[0-9a-f-]{36}$/i.test(input.operationId))
          return yield* new RouteRequestError({ message: "Invalid fork identifier." });
        const targetId = NativeForkThreadId.makeUnsafe(`fork-${input.operationId}`);
        if (input.sideChat && source.sideChatOf)
          return yield* new RouteRequestError({
            message: "Open a side chat from the main thread.",
          });
        if (input.sideChat) {
          const at = new Date().toISOString();
          const existing = snapshot.threads.find((thread) => thread.id === targetId);
          if (existing && (existing.sideChatOf !== source.id || existing.deletedAt !== null))
            return yield* new RouteRequestError({
              message: "This side-chat identifier is already in use.",
            });
          if (!existing) {
            if (!providerHandoffStates)
              return yield* new RouteRequestError({
                message: "Side-chat context storage is unavailable.",
              });
            const generation = source.session?.capabilities?.generation;
            if (generation !== undefined && generation !== input.generation)
              return yield* new RouteRequestError({
                message: "The main thread session changed. Retry opening the side chat.",
              });
            const binding = Option.getOrUndefined(
              yield* providerSessionDirectory
                .getBinding(source.id)
                .pipe(
                  Effect.mapError((error) => new RouteRequestError({ message: String(error) })),
                ),
            );
            const instanceId =
              source.modelSelection?.instanceId ??
              binding?.providerInstanceId ??
              source.session?.providerInstanceId;
            const provider = binding?.provider ?? source.session?.providerName;
            if (!instanceId || !provider || !isKnownProviderKind(provider))
              return yield* new RouteRequestError({
                message: "Start a provider session before opening a side chat.",
              });
            const details = yield* projectionReadModelQuery
              .getThreadDetails({ threadId: source.id })
              .pipe(Effect.mapError((error) => new RouteRequestError({ message: String(error) })));
            const captured = captureSideChatContext({
              messages: details.messages,
              compaction: source.compaction,
            });
            const seed = {
              id: "side-chat:" + targetId,
              mode: "full" as const,
              targetInstanceId: instanceId,
              fromProvider: provider,
              fromInstanceId: instanceId,
              fromModel: source.model,
              sinceMessageId: null,
              expectedNativeIdentity: null,
              createdAt: at,
              sourceContext: captured,
            };
            // Persist the fork context before publishing its thread, so a first send cannot race it.
            yield* providerHandoffStates
              .compareAndSet({
                threadId: targetId,
                expectedRevision: null,
                pending: seed,
                parked: {},
              })
              .pipe(Effect.mapError((error) => new RouteRequestError({ message: String(error) })));
            yield* orchestrationEngine
              .dispatch({
                type: "thread.create",
                commandId: CommandId.makeUnsafe("side-chat-create:" + input.operationId),
                threadId: targetId,
                projectId: project.id,
                title: "Side chat · " + source.title,
                model: source.model,
                modelSelection: {
                  ...(source.modelSelection ?? {}),
                  instanceId,
                  model: source.model,
                },
                runtimeMode: source.runtimeMode,
                interactionMode: source.interactionMode,
                branch: source.branch,
                worktreePath: source.worktreePath,
                sideChatOf: source.id,
                sharedFilesystemConfirmed: true,
                threadReferences: [{ threadId: source.id, relation: "source", createdAt: at }],
                createdAt: at,
              })
              .pipe(Effect.mapError((error) => new RouteRequestError({ message: String(error) })));
          }
          return {
            ...input,
            command: {
              kind: "fork",
              targetThreadId: targetId,
              cwd: threadWorkspaceCwd(source, project) ?? project.workspaceRoot,
            },
            state: "completed",
            createdAt: at,
            updatedAt: at,
          };
        }
        if (!providerService.nativeOperations?.executeWithApply)
          return yield* new RouteRequestError({
            message: "Native forks are unavailable for this provider.",
          });
        const branch = yield* resolveTemporaryWorktreeBranch(
          git,
          project.workspaceRoot,
          `t3code/${input.operationId.slice(0, 8)}`,
        );
        const cwd = yield* git.allocateWorktreePath({ cwd: project.workspaceRoot, branch });
        const binding = yield* providerSessionDirectory
          .getBinding(input.threadId)
          .pipe(Effect.mapError((cause) => new RouteRequestError({ message: String(cause) })));
        if (Option.isNone(binding))
          return yield* new RouteRequestError({
            message: "The source provider session is unavailable.",
          });
        const validation = (cause: unknown) =>
          new ProviderValidationError({
            operation: "nativeFork",
            issue: cause instanceof Error ? cause.message : String(cause),
          });
        return yield* providerService.nativeOperations
          .executeWithApply(
            {
              threadId: input.threadId,
              operationId: input.operationId,
              generation: input.generation,
              command: {
                kind: "fork",
                targetThreadId: targetId,
                cwd,
                ...(input.beforeTurnId ? { beforeTurnId: input.beforeTurnId } : {}),
              },
            },
            (result) =>
              Effect.gen(function* () {
                if (!result || typeof result !== "object" || !("resumeCursor" in result))
                  return yield* validation("Native fork returned no resume cursor.");
                const at = new Date().toISOString();
                yield* orchestrationEngine
                  .dispatch({
                    type: "thread.create",
                    commandId: CommandId.makeUnsafe(`fork-create:${input.operationId}`),
                    threadId: targetId,
                    projectId: project.id,
                    title: `Fork of ${source.title}`,
                    model: source.model,
                    ...(source.modelSelection ? { modelSelection: source.modelSelection } : {}),
                    runtimeMode: source.runtimeMode,
                    interactionMode: source.interactionMode,
                    branch,
                    worktreePath: cwd,
                    threadReferences: [{ threadId: source.id, relation: "source", createdAt: at }],
                    createdAt: at,
                  })
                  .pipe(Effect.mapError(validation));
                yield* providerSessionDirectory.upsert({
                  ...binding.value,
                  threadId: targetId,
                  resumeCursor: result.resumeCursor,
                  launchFingerprint: null,
                  status: "stopped",
                  runtimePayload: {
                    ...(typeof binding.value.runtimePayload === "object"
                      ? binding.value.runtimePayload
                      : {}),
                    cwd,
                  },
                });
                yield* worktreePreparation
                  .prepare({
                    threadId: targetId,
                    projectId: project.id,
                    worktreePath: cwd,
                    branch: branch!,
                  })
                  .pipe(Effect.mapError(validation));
              }),
            createConfiguredWorktree({
              cwd: threadWorkspaceCwd(source, project) ?? project.workspaceRoot,
              branch: source.branch ?? "HEAD",
              baseRefName: source.branch ?? "HEAD",
              newBranch: branch!,
              preparation: { owner: `thread:${targetId}`, runSetupScript: true },
              path: cwd,
            }).pipe(Effect.asVoid, Effect.mapError(validation)),
            { background: true },
          )
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }
      case NATIVE_OPERATION_WS_METHODS.historyRecovery:
      case NATIVE_OPERATION_WS_METHODS.markRead:
      case NATIVE_OPERATION_WS_METHODS.resolve:
      case NATIVE_OPERATION_WS_METHODS.execute:
      case NATIVE_OPERATION_WS_METHODS.list:
      case NATIVE_OPERATION_WS_METHODS.inspect: {
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        const input = stripRequestTag(request.body);
        const snapshot = yield* orchestrationEngine.getReadModel();
        const thread = snapshot.threads.find(
          (entry) => entry.id === input.threadId && entry.deletedAt === null,
        );
        if (!thread || !providerService.nativeOperations)
          return yield* new RouteRequestError({
            message: "Native operations are unavailable for this conversation.",
          });
        if (request.body._tag === NATIVE_OPERATION_WS_METHODS.historyRecovery) {
          if (!providerService.nativeOperations.historyRecovery)
            return yield* new RouteRequestError({ message: "History recovery is unavailable." });
          const recovery = stripRequestTag(request.body);
          const result = yield* providerService.nativeOperations
            .historyRecovery(recovery)
            .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
          // Accepting the history releases its fence: the warning kept for it goes too.
          if (recovery.action === "acknowledge" && recovery.expected) {
            const cleared = makeHistoryRecoveredSessionSet({
              thread: (yield* orchestrationEngine.getReadModel()).threads.find(
                (entry) => entry.id === recovery.threadId,
              ),
              markerId: recovery.expected.eventId,
              commandId: CommandId.makeUnsafe(
                `server:history-accepted:${recovery.threadId}:${timeOrderedUuid()}`,
              ),
              createdAt: new Date().toISOString(),
            });
            if (cleared) yield* orchestrationEngine.dispatch(cleared);
          }
          return result;
        }
        if (request.body._tag === NATIVE_OPERATION_WS_METHODS.markRead) {
          yield* providerService.nativeOperations.markRead?.(input.threadId) ?? Effect.void;
          return;
        }
        if (request.body._tag === NATIVE_OPERATION_WS_METHODS.resolve) {
          if (!providerService.nativeOperations.resolve)
            return yield* new RouteRequestError({
              message: "Native outcome resolution is unavailable.",
            });
          const resolution = stripRequestTag(request.body);
          const record = yield* providerService.nativeOperations
            .resolve(resolution)
            .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
          if (resolution.action === "acknowledge")
            yield* finishAcknowledgedNativeRewind(record, sql, orchestrationEngine).pipe(
              Effect.mapError((error) => new RouteRequestError({ message: error.message })),
            );
          return record;
        }
        if (request.body._tag === NATIVE_OPERATION_WS_METHODS.execute) {
          const operation = stripRequestTag(request.body);
          if (["fork", "revertFiles", "compact"].includes(operation.command.kind))
            return yield* new RouteRequestError({
              message:
                "Use the conversation fork, checkpoint or compaction action for this operation.",
            });
          return yield* providerService.nativeOperations
            .execute(operation)
            .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
        }
        if (request.body._tag === NATIVE_OPERATION_WS_METHODS.inspect)
          return yield* providerService.nativeOperations
            .inspect(stripRequestTag(request.body))
            .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
        return yield* providerService.nativeOperations
          .list(input.threadId)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }
      case ELICITATION_WS_METHODS.submit: {
        // The connection is authenticated at upgrade; the submission itself
        // authorizes against the thread's open request, its generation and
        // receipt state. Values are never logged, traced or persisted.
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* submitElicitation(
          { orchestrationEngine, providerService, inFlight: elicitationSubmissionsInFlight },
          stripRequestTag(request.body),
        ).pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
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

      case USAGE_WS_METHODS.getQuotaHistory: {
        const { usageService } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* usageService.getQuotaHistory.pipe(
          Effect.mapError((error) => new RouteRequestError({ message: error.message })),
        );
      }

      case USAGE_WS_METHODS.getThreadTurns: {
        const { usageService } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* usageService
          .getThreadTurns(stripRequestTag(request.body))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }

      case USAGE_WS_METHODS.analyzeClaudeUsage: {
        const { usageService } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* usageService
          .analyzeClaudeUsage(stripRequestTag(request.body))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }

      case ORCHESTRATION_WS_METHODS.getLatestSequence: {
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        const response = {
          latestSequence: (yield* orchestrationEngine.getReadModel()).snapshotSequence,
          backendIncarnation: BACKEND_INCARNATION,
        };
        const resume = request.body.resume;
        if (resume?.backendIncarnation !== BACKEND_INCARNATION) return response;
        const snapshotRequired = { ...response, snapshotRequired: true as const };
        const gap = response.latestSequence - resume.afterSequence;
        if (gap < 0 || gap > MAX_RECONNECT_REPLAY_EVENTS) return snapshotRequired;
        if (gap === 0) return { ...response, events: [] };

        const events = yield* orchestrationEngine
          .readEvents(resume.afterSequence, { limit: gap })
          .pipe(
            Stream.runCollect,
            Effect.orElseSucceed(() => []),
          );
        if (events.length !== gap) return snapshotRequired;
        let bytes = 0;
        for (const [index, event] of events.entries()) {
          if (event.sequence !== resume.afterSequence + index + 1) return snapshotRequired;
          bytes += Buffer.byteLength(JSON.stringify(event));
          if (bytes > MAX_RECONNECT_REPLAY_BYTES) return snapshotRequired;
        }
        return { ...response, events };
      }
      case ORCHESTRATION_WS_METHODS.getSnapshot: {
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* orchestrationEngine.getReadModel();
      }

      case ORCHESTRATION_WS_METHODS.getStartupSnapshot:
        return yield* readStartupSnapshot(stripRequestTag(request.body), "ws");

      case ORCHESTRATION_WS_METHODS.getRewindDrafts: {
        const body = stripRequestTag(request.body);
        return yield* projectionReadModelQuery.getRewindDrafts(body);
      }

      case ORCHESTRATION_WS_METHODS.getThreadPeek: {
        const body = stripRequestTag(request.body);
        return yield* readThreadPeek(sql, body.threadId);
      }

      case ORCHESTRATION_WS_METHODS.getThreadPeeks: {
        const body = stripRequestTag(request.body);
        return { peeks: yield* readThreadPeeks(sql, body.threadIds) };
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
            const details = yield* projectionReadModelQuery.getThreadTailDetails(body);
            const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
            const model = yield* orchestrationEngine.getReadModel();
            const thread = model.threads.find((thread) => thread.id === body.threadId);
            // Keep the response bounded even when the runtime retains full history.
            return {
              ...details,
              thread: thread
                ? { ...thread, messages: [], activities: [], checkpoints: [], proposedPlans: [] }
                : null,
            };
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

      case ORCHESTRATION_WS_METHODS.searchThread: {
        return yield* projectionReadModelQuery.searchThread(stripRequestTag(request.body));
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
        const { orchestrationEngine, projectSetupScriptRunner, workspaceTransition } =
          yield* awaitOrchestrationRuntimeForRoute;
        const rawCommand = request.body.command;
        const command =
          rawCommand.type === "thread.meta.update"
            ? { ...rawCommand, titleOrigin: "host" as const }
            : rawCommand;
        if (command.type === "thread.turn.start" && command.bootstrap) {
          const dispatched = yield* runBootstrapTurnStart({
            command,
            orchestrationEngine,
            projectSetupScriptRunner,
            submissionSource: "human",
          });
          yield* releaseSentUploads(command.threadId, command.message.attachments);
          return dispatched;
        }
        if (
          command.type === "thread.meta.update" &&
          (command.branch !== undefined || command.worktreePath !== undefined)
        ) {
          const thread = (yield* orchestrationEngine.getReadModel()).threads.find(
            (entry) => entry.id === command.threadId && entry.deletedAt === null,
          );
          if (!thread) return yield* new RouteRequestError({ message: "Unknown conversation." });
          if (
            (command.expectedBranch !== undefined && command.expectedBranch !== thread.branch) ||
            (command.expectedWorktreePath !== undefined &&
              command.expectedWorktreePath !== thread.worktreePath)
          )
            return yield* new RouteRequestError({
              message: "The conversation workspace changed. Refresh and try again.",
            });
          const path =
            command.worktreePath === undefined ? thread.worktreePath : command.worktreePath;
          const branch = command.branch === undefined ? thread.branch : command.branch;
          if (path !== thread.worktreePath || branch !== thread.branch) {
            const project = (yield* orchestrationEngine.getReadModel()).projects.find(
              (entry) => entry.id === thread.projectId,
            );
            if (!project) return yield* new RouteRequestError({ message: "Unknown project." });
            const result = yield* workspaceTransition
              .switchWorkspace({
                operationId: command.commandId,
                threadId: thread.id,
                intent: "attach_existing",
                targetPath: path ?? project.workspaceRoot,
                ...(branch ? { branch } : {}),
                expected: {
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                  sessionUpdatedAt: thread.session?.updatedAt ?? null,
                },
              })
              .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
            if (result.phase !== "completed")
              return yield* new RouteRequestError({
                message: result.error ?? "Resolve the workspace transition before continuing.",
              });
          }
          const {
            branch: _branch,
            worktreePath: _path,
            expectedBranch: _expectedBranch,
            expectedWorktreePath: _expectedPath,
            ...metadata
          } = command;
          return yield* orchestrationEngine.dispatch(metadata);
        }
        const normalizedCommand = yield* normalizeDispatchCommand({
          command,
          submissionSource: "human",
        });
        if (normalizedCommand.type === "thread.turn.start") {
          yield* removePersistedTurnAttachments(normalizedCommand);
          return yield* new RouteRequestError({
            code: "NextTurnQueueAdmissionRequired",
            message:
              "Established-thread turns must be submitted through nextTurnQueue.submit so ordering is enforced by the server.",
          });
        }
        const result = yield* dispatchWithCreationAttachment(
          orchestrationEngine,
          normalizedCommand,
        ).pipe(
          Effect.tapError(() =>
            normalizedCommand.type === "thread.user-input.respond"
              ? discardAttachmentIngress({
                  attachments: normalizedCommand.attachments ?? [],
                  attachmentsDir: serverConfig.attachmentsDir,
                  commandId: normalizedCommand.commandId,
                })
              : Effect.void,
          ),
        );
        if (command.type === "thread.user-input.respond")
          yield* releaseSentUploads(command.threadId, command.attachments ?? []);
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

      case WS_METHODS.projectsClone: {
        return yield* projectClones.start(stripRequestTag(request.body)).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error instanceof Error ? error.message : "Could not start clone.",
              }),
          ),
        );
      }
      case WS_METHODS.projectsCloneList:
        return projectClones.list();
      case WS_METHODS.projectsScanAgentSessions: {
        return yield* agentSessionSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
            const settings = yield* serverSettings.getSettings;
            const homes = yield* resolveAgentSessionHomes(settings, serverConfig);
            const model = yield* orchestrationEngine.getReadModel();
            return yield* Effect.tryPromise({
              try: (signal) =>
                agentSessionScanner.scan(
                  homes,
                  model.projects
                    .filter((project) => project.deletedAt === null)
                    .map((project) => project.workspaceRoot),
                  serverConfig.worktreesDir,
                  signal,
                ),
              catch: () =>
                new RouteRequestError({ message: "Could not scan agent history. Try again." }),
            });
          }),
        );
      }
      case WS_METHODS.projectsImportAgentSessions: {
        const body = stripRequestTag(request.body);
        return yield* agentSessionSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const { orchestrationEngine, providerSessionDirectory } =
              yield* awaitOrchestrationRuntimeForRoute;
            const settings = yield* serverSettings.getSettings;
            const homes = yield* resolveAgentSessionHomes(settings, serverConfig);
            return yield* importAgentSessionProject({
              request: body,
              scanner: agentSessionScanner,
              homes,
              engine: orchestrationEngine,
              directory: providerSessionDirectory,
            }).pipe(
              Effect.mapError(
                () =>
                  new RouteRequestError({
                    message: "Could not import agent history. Scan for projects again and retry.",
                  }),
              ),
            );
          }),
        );
      }
      case WS_METHODS.projectsEnsureScratch: {
        return yield* scratchProjectSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
            const findLive = orchestrationEngine
              .getReadModel()
              .pipe(
                Effect.map((model) =>
                  model.projects.find((project) => isScratchProject(project) && !project.deletedAt),
                ),
              );
            const existing = yield* findLive;
            if (existing) return { projectId: existing.id };
            const workspaceRoot = yield* Effect.tryPromise({
              try: () => prepareScratchRoot(serverConfig.stateDir),
              catch: (cause) =>
                new RouteRequestError({
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "Could not create the folder for threads without a project.",
                }),
            });
            // The id and command id depend only on the profile, so racing or retried creates
            // converge on one project: a duplicate either replays the receipt or is refused.
            const projectId = ProjectId.makeUnsafe(scratchProjectIdFor(activeProfile.id));
            yield* orchestrationEngine
              .dispatch({
                type: "project.scratch.create",
                commandId: CommandId.makeUnsafe(`scratch-project-create:${projectId}`),
                projectId,
                workspaceRoot,
                createdAt: new Date().toISOString(),
              })
              .pipe(
                Effect.catch((error) =>
                  findLive.pipe(
                    Effect.flatMap((raced) =>
                      raced
                        ? Effect.void
                        : Effect.fail(new RouteRequestError({ message: String(error) })),
                    ),
                  ),
                ),
              );
            const created = yield* findLive;
            if (!created)
              return yield* new RouteRequestError({
                message: "Could not create the home for threads without a project.",
              });
            return { projectId: created.id };
          }),
        );
      }
      case WS_METHODS.projectsCreateNew: {
        const body = stripRequestTag(request.body);
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () => new RouteRequestError({ message: "Could not read the projects folder setting." }),
          ),
        );
        const created = yield* Effect.tryPromise({
          try: async () => {
            const root = resolveProjectsRoot({
              setting: settings.projectsRoot,
              profileId: activeProfile.id,
              isDefaultProfile: serverConfig.profile?.isDefault ?? true,
            });
            const folder = await reserveProjectFolder(root, projectFolderSlug(body.name));
            const { warning } = await initializeNewProject({
              folder,
              name: body.name,
              authorName: settings.gitAuthorName,
              authorEmail: settings.gitAuthorEmail,
            });
            return { folder, warning };
          },
          catch: (cause) =>
            new RouteRequestError({
              message: `Could not create the project: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        const projectId = ProjectId.makeUnsafe(randomUUID());
        yield* orchestrationEngine
          .dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe(`project-create-new:${projectId}`),
            projectId,
            title: body.name,
            workspaceRoot: created.folder,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
            createdAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new RouteRequestError({
                  message: `The folder ${created.folder} was created but could not be added as a project: ${String(error)}`,
                }),
            ),
          );
        return { projectId, workspaceRoot: created.folder, warning: created.warning };
      }
      case WS_METHODS.projectsFindByRepository: {
        const body = stripRequestTag(request.body);
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        const model = yield* orchestrationEngine.getReadModel();
        const owner = body.owner.toLowerCase();
        const name = body.name.toLowerCase().replace(/\.git$/, "");
        // Bounded concurrency and a per-project deadline keep one slow or unmounted
        // volume from stalling the link; such a project simply does not match.
        const candidates = model.projects.filter(
          (project) => project.deletedAt === null && !isScratchProject(project),
        );
        const matched = yield* Effect.forEach(
          candidates,
          (project) =>
            git.listRemotes(project.workspaceRoot).pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.map(Option.getOrElse(() => [])),
              Effect.orElseSucceed(() => []),
              Effect.map((remotes) =>
                discoverSourceControlProviderIdentities(remotes, {
                  githubHosts: ["github.com"],
                }).some(
                  (identity) =>
                    identity.kind === "github" &&
                    identity.host?.toLowerCase() === "github.com" &&
                    identity.owner?.toLowerCase() === owner &&
                    identity.repository?.toLowerCase() === name,
                ),
              ),
            ),
          { concurrency: 6 },
        );
        return candidates
          .filter((_, index) => matched[index])
          .map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          }));
      }
      case WS_METHODS.projectsCloneCancel: {
        yield* projectClones.cancel(request.body.operationId);
        return undefined;
      }
      case WS_METHODS.projectsListDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceDirectory(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list workspace directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsListEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceEntries(body),
          catch: (cause) => workspaceSearchRouteError(cause, "Failed to list workspace entries"),
        });
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) => workspaceSearchRouteError(cause, "Failed to search workspace entries"),
        });
      }

      case WS_METHODS.projectsGetCheckedInConfig: {
        const body = stripRequestTag(request.body);
        const projectWorkspace = yield* projectionWorkspaceQuery.getProjectWorkspace(
          body.projectId,
        );
        if (Option.isNone(projectWorkspace)) {
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

      case WS_METHODS.projectsSetRepository: {
        const body = stripRequestTag(request.body);
        const project = yield* projectionWorkspaceQuery.getProjectWorkspace(body.projectId);
        if (
          Option.isNone(project) ||
          isScratchProject(project.value) ||
          !git.setProjectRepositoryRoot
        )
          return yield* new RouteRequestError({
            message: "Project repository settings are unavailable.",
          });
        yield* git.setProjectRepositoryRoot({
          ...body,
          projectRoot: project.value.workspaceRoot,
        });
        reviewRepositoryCache.clear();
        return;
      }

      case WS_METHODS.projectsListRepositories: {
        const body = stripRequestTag(request.body);
        const project = yield* projectionWorkspaceQuery.getProjectWorkspace(body.projectId);
        if (Option.isNone(project) || isScratchProject(project.value)) return [];
        const thread = body.threadId
          ? yield* projectionWorkspaceQuery.getThreadWorkspace(body.threadId)
          : Option.none();
        if (body.threadId && (Option.isNone(thread) || thread.value.projectId !== body.projectId)) {
          return yield* new RouteRequestError({
            message: "Thread is unavailable for this project.",
          });
        }
        return yield* listWorkspaceRepositories(
          { id: body.projectId, workspaceRoot: project.value.workspaceRoot },
          Option.getOrUndefined(thread)?.workspaceRoot,
          git,
        ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      }

      case WS_METHODS.projectsSearchContents: {
        const body = stripRequestTag(request.body);
        const projectWorkspace = yield* projectionWorkspaceQuery.getProjectWorkspace(
          body.projectId,
        );
        if (Option.isNone(projectWorkspace)) {
          return yield* new RouteRequestError({
            message: "Project content search target is unavailable.",
          });
        }
        const threadWorkspace = body.threadId
          ? yield* projectionWorkspaceQuery.getThreadWorkspace(body.threadId)
          : Option.none();
        if (
          body.threadId &&
          (Option.isNone(threadWorkspace) || threadWorkspace.value.projectId !== body.projectId)
        ) {
          return yield* new RouteRequestError({
            message: "Project content search target is unavailable.",
          });
        }
        const workspaceRoot = Option.match(threadWorkspace, {
          onNone: () => projectWorkspace.value.workspaceRoot,
          onSome: (thread) => thread.workspaceRoot,
        });
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
          catch: (cause) => {
            const error = workspaceSearchRouteError(cause, "Project content search failed");
            if (!(cause instanceof WorkspaceSearchRestrictedError)) {
              logger.warn("Project content search request failed", {
                projectId: body.projectId,
                threadId: body.threadId ?? null,
                detail: error.message,
              });
            }
            return error;
          },
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
        const result = yield* Effect.tryPromise({
          try: () =>
            writeWorkspaceFile(
              body,
              NodePath.join(
                serverConfig.profilesRoot ?? NodePath.dirname(serverConfig.stateDir),
                "locks",
              ),
            ),
          catch: (cause) =>
            new RouteRequestError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (!("conflict" in result))
          clearWorkspaceIndexCache(body.cwd, {
            destroySearchIndex: body.condition.type === "create",
          });
        return result;
      }

      case WS_METHODS.attachmentsCloneToUpload: {
        const body = stripRequestTag(request.body);
        return yield* attachmentUploads
          .cloneToUpload(body.threadId, body.source)
          .pipe(
            Effect.mapError(
              () => new RouteRequestError({ message: "Unable to copy attachment to draft." }),
            ),
          );
      }
      case WS_METHODS.attachmentsGetUploads: {
        const body = stripRequestTag(request.body);
        return yield* attachmentUploads
          .getUploads(body.threadId, body.uploadIds)
          .pipe(
            Effect.mapError(
              () => new RouteRequestError({ message: "Unable to renew draft uploads." }),
            ),
          );
      }
      case WS_METHODS.attachmentsMaterializeUploads: {
        const body = stripRequestTag(request.body);
        return yield* attachmentUploads
          .materialize(body.threadId, body.uploadIds, workflowAttachmentsDir)
          .pipe(
            Effect.mapError(
              (cause) => new RouteRequestError({ message: materializeErrorMessage(cause) }),
            ),
          );
      }
      case WS_METHODS.attachmentsDiscardMaterialized: {
        const body = stripRequestTag(request.body);
        yield* attachmentUploads
          .discardMaterialized(body.uploadIds, workflowAttachmentsDir)
          .pipe(
            Effect.mapError(
              () => new RouteRequestError({ message: "Unable to remove saved attachments." }),
            ),
          );
        return {};
      }
      case WS_METHODS.attachmentsReleaseUploads: {
        const body = stripRequestTag(request.body);
        yield* attachmentUploads
          .releaseUploads(body.threadId, body.uploadIds)
          .pipe(
            Effect.mapError(
              () => new RouteRequestError({ message: "Unable to release draft uploads." }),
            ),
          );
        return {};
      }
      case WS_METHODS.projectsOpenHtmlPreview: {
        if (mode !== "desktop")
          return yield* new RouteRequestError({
            message: "Active file previews require the desktop app.",
          });
        const body = stripRequestTag(request.body);
        const url = yield* Effect.tryPromise({
          try: () => {
            const stored =
              body.identity.kind === "attachments"
                ? resolveAttachmentPathById({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachmentId: body.relativePath,
                  })
                : null;
            return previewFileServer.issue(
              body.identity,
              stored ? path.basename(stored) : body.relativePath,
            );
          },
          catch: () => new RouteRequestError({ message: "Unable to open HTML preview." }),
        });
        return { url };
      }
      case WS_METHODS.projectsIssueAssetUrl: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: async () => {
            const reader =
              body.identity.kind === "project"
                ? await workspaceAssetAuthorizer.forProject(body.identity.projectId)
                : body.identity.kind === "thread"
                  ? await workspaceAssetAuthorizer.forThread(body.identity.threadId)
                  : await workspaceAssetAuthorizer.forAttachments();
            // One unreadable path (missing, symlinked, or invented by an agent) must
            // not make the rest of the batch unavailable, so each file settles alone.
            const settled = await Promise.allSettled(
              body.files.map(async (entry) => {
                // Check readability and containment before handing out the capability.
                const stored =
                  body.identity.kind === "attachments"
                    ? resolveAttachmentPathById({
                        attachmentsDir: serverConfig.attachmentsDir,
                        attachmentId: entry.relativePath,
                      })
                    : null;
                const relativePath = stored ? path.basename(stored) : entry.relativePath;
                const file = await reader.openFile(relativePath);
                let dimensions;
                let fileRevision: string | undefined;
                try {
                  if (path.extname(relativePath).toLowerCase() === ".pdf") {
                    const stat = await file.stat({ bigint: true });
                    fileRevision = createHash("sha256")
                      .update([stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":"))
                      .digest("hex");
                  } else {
                    dimensions = await readAssetImageDimensions(file);
                  }
                } finally {
                  await file.close();
                }
                const issued = reader.issueFileHandle({ ...entry, relativePath });
                const name = path.basename(relativePath);
                return {
                  relativePath: entry.relativePath,
                  url: `/api/workspace-assets/${issued.handle}/${encodeURIComponent(name)}`,
                  expiresAt: issued.expiresAt,
                  ...(fileRevision === undefined ? {} : { fileRevision }),
                  ...dimensions,
                };
              }),
            );
            return settled.map((result) => (result.status === "fulfilled" ? result.value : null));
          },
          catch: () => new RouteRequestError({ message: "Unable to authorize workspace asset." }),
        });
      }

      case WS_METHODS.projectsSetWatchedPaths: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await workspaceWatchRegistry.setWatchedPaths(ws, body);
            // A request still queued when the socket closed must not outlive it.
            if (ws.readyState !== ws.OPEN) workspaceWatchRegistry.releaseSubscriber(ws);
            return result;
          },
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to watch workspace paths: ${String(cause)}`,
            }),
        });
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
          workspaceIdentity: yield* fileSystem.realPath(body.cwd),
          fileIdentity: target.absolutePath,
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
        // External previews may choose a local directory, as projects.readFile
        // already permits. Ownership checks do not make that directory project-scoped.
        if (
          body.cwd !== undefined &&
          (!path.isAbsolute(body.cwd) || body.kind !== "file" || /[\\/]/u.test(body.relativePath))
        ) {
          return yield* new RouteRequestError({
            message: "External file reveals require an absolute directory and a single file name.",
          });
        }
        const workspaceRoot = yield* Effect.gen(function* () {
          const projectWorkspace = yield* projectionWorkspaceQuery.getProjectWorkspace(
            body.projectId,
          );
          if (Option.isNone(projectWorkspace)) {
            return yield* new RouteRequestError({ message: "Project not found." });
          }
          const threadProjectId = yield* projectionWorkspaceQuery.getThreadProjectId(body.threadId);
          if (Option.isSome(threadProjectId) && threadProjectId.value !== body.projectId) {
            return yield* new RouteRequestError({
              message: "Thread does not belong to the selected project.",
            });
          }
          const threadWorkspace = yield* projectionWorkspaceQuery.getThreadWorkspace(body.threadId);
          return (
            body.cwd ??
            Option.match(threadWorkspace, {
              onNone: () => projectWorkspace.value.workspaceRoot,
              onSome: (thread) => thread.workspaceRoot,
            })
          );
        });
        const target = yield* resolveWorkspaceReadPath({
          workspaceRoot,
          relativePath: body.relativePath,
          allowWorkspaceRoot: true,
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
        const kind = stat.type === "Directory" ? ("directory" as const) : ("file" as const);
        if (
          (stat.type !== "File" && stat.type !== "Directory") ||
          (body.kind && body.kind !== kind)
        ) {
          return yield* new RouteRequestError({
            message: `Workspace entry changed: ${target.relativePath}`,
          });
        }
        return yield* revealInFileManager(target.absolutePath);
      }

      case WS_METHODS.reviewPreviewDiff: {
        const body = stripRequestTag(request.body);
        const { orchestrationEngine } = yield* awaitOrchestrationRuntimeForRoute;
        const readModel = yield* orchestrationEngine.getReadModel();
        let repositoryCwd: string | undefined;
        if (body.repositoryPath !== undefined) {
          const thread = readModel.threads.find((entry) => entry.id === body.threadId);
          const project =
            thread && readModel.projects.find((entry) => entry.id === thread.projectId);
          if (thread && project && !isScratchProject(project)) {
            const workspace = threadWorkspaceCwd(thread, project);
            const repositories = yield* reviewRepositoryCache
              .list(project, workspace, git)
              .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
            const repository = repositories.find(
              (repository) => repository.relativePath === body.repositoryPath,
            );
            if (repository && workspace) {
              const target = yield* fileSystem.realPath(repository.path).pipe(Effect.option);
              const root = yield* fileSystem.realPath(workspace).pipe(Effect.option);
              if (
                Option.isSome(target) &&
                Option.isSome(root) &&
                target.value ===
                  (repository.externalSource === repository.path
                    ? repository.path
                    : path.resolve(root.value, repository.relativePath))
              )
                repositoryCwd = repository.path;
            }
          }
          if (repositoryCwd === undefined) {
            return {
              kind: "error",
              code: "workspace_invalid",
              message: "Repository is unavailable for this thread.",
              retryable: false,
            } as const;
          }
        }
        return yield* getReviewPreviewDiff({
          request: body,
          readModel,
          ...(repositoryCwd ? { repositoryCwd } : {}),
        });
      }

      case THREAD_SETTLEMENT_WS_METHODS.settleProjectIdle:
        return yield* (yield* awaitOrchestrationRuntimeForRoute).threadSettlement.settleProjectIdle(
          request.body.projectId,
        );

      case WS_METHODS.nextTurnQueueList: {
        const body = stripRequestTag(request.body);
        return yield* getNextTurnQueueSnapshot(body.threadId).pipe(
          Effect.mapError(mapNextTurnQueueRouteError),
        );
      }

      case WS_METHODS.nextTurnQueueSummary:
        return yield* nextTurnQueueStore.summary.pipe(Effect.mapError(mapNextTurnQueueRouteError));

      case WS_METHODS.nextTurnQueueSubmit:
        return yield* submitTurnSubmission(stripRequestTag(request.body), {
          submissionSource: "human",
        });

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

      case WS_METHODS.nextTurnQueueSteer: {
        const body = stripRequestTag(request.body);
        const item = yield* nextTurnQueueStore
          .getItem(body.itemId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        if (!item)
          return yield* new RouteRequestError({ message: "That queued turn no longer exists." });
        const runtime = yield* awaitOrchestrationRuntimeForRoute;
        const thread = (yield* runtime.orchestrationEngine.getReadModel()).threads.find(
          (entry) => entry.id === item.threadId,
        );
        if (
          !thread?.session?.activeTurnId ||
          thread.runtimeMode !== item.command.runtimeMode ||
          thread.interactionMode !== item.command.interactionMode
        )
          return yield* new RouteRequestError({
            message:
              "Steering requires an active turn with the same Build/Plan and permission modes.",
          });
        // Re-check the routed session generation and executable support; a
        // restart later changes the active turn id, which dispatch rejects.
        yield* providerService
          .assertSessionAction({
            threadId: item.threadId,
            action: "steer",
            ...(body.expectedSessionGeneration !== undefined
              ? { expectedGeneration: body.expectedSessionGeneration }
              : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new RouteRequestError({
                  message:
                    error._tag === "ProviderSessionActionUnavailableError"
                      ? error.reason.message
                      : error.message,
                }),
            ),
          );
        yield* nextTurnQueueStore
          .setSteer(item.itemId, body.expectedRevision, thread.session.activeTurnId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        yield* runtime.nextTurnQueueDispatcher.notify(item.threadId);
        return yield* runtime.nextTurnQueueDispatcher
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

      case WS_METHODS.nextTurnQueueScheduleUsageLimitResume: {
        const body = stripRequestTag(request.body);
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* nextTurnQueueDispatcher
          .scheduleUsageLimitResume({ ...body, source: "manual" })
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }
      case WS_METHODS.nextTurnQueueResendAuthFailedTurn: {
        const body = stripRequestTag(request.body);
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* nextTurnQueueDispatcher
          .resendAuthFailedTurn(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }
      case WS_METHODS.nextTurnQueueCancelUsageLimitResume: {
        const body = stripRequestTag(request.body);
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* nextTurnQueueDispatcher
          .cancelUsageLimitResume(body)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }
      case WS_METHODS.nextTurnQueueRefreshUsageLimitResume: {
        const body = stripRequestTag(request.body);
        const { nextTurnQueueDispatcher } = yield* awaitOrchestrationRuntimeForRoute;
        return yield* nextTurnQueueDispatcher
          .refreshUsageLimitResume(body)
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

      case WS_METHODS.serverGetClaudeTranscriptRepair:
      case WS_METHODS.serverRepairClaudeTranscript:
      case WS_METHODS.serverUndoClaudeTranscriptRepair: {
        const body = stripRequestTag(request.body);
        const { providerSessionDirectory } = yield* awaitOrchestrationRuntimeForRoute;
        const input = {
          threadId: body.threadId,
          directory: providerSessionDirectory,
          service: providerService,
          resolveAccount: (id: ProviderInstanceId) => accountService.resolve(id),
          providerLogsDir: serverConfig.providerLogsDir,
        };
        const mapMaintenanceError = <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.catchCause((cause) => {
              const reason = Cause.squash(cause);
              return Effect.logWarning("Claude transcript maintenance failed", {
                threadId: body.threadId,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new RouteRequestError({
                      code: "TranscriptRepairError",
                      message: claudeMaintenanceErrorMessage(reason),
                    }),
                  ),
                ),
              );
            }),
          );
        const operation: Effect.Effect<unknown, RouteRequestError> =
          request.body._tag === WS_METHODS.serverGetClaudeTranscriptRepair
            ? mapMaintenanceError(getClaudeTranscriptMaintenance(input))
            : mapMaintenanceError(
                runClaudeTranscriptMaintenance(
                  input,
                  "backupId" in body ? String(body.backupId) : undefined,
                ),
              );
        return yield* operation;
      }

      case WS_METHODS.nextTurnQueueRecheckDelivery: {
        const body = stripRequestTag(request.body);
        const { providerTurnDeliveryWorker, nextTurnQueueDispatcher } =
          yield* awaitOrchestrationRuntimeForRoute;
        // Recheck the delivery that paused the queue, not the thread's latest
        // delivery: a newer accepted send can supersede the paused one.
        const blocking = yield* nextTurnQueueDispatcher
          .getBlockingDelivery(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        const rechecked = blocking
          ? yield* providerTurnDeliveryWorker
              .recheckWithReason(body.threadId, blocking.deliveryId)
              .pipe(Effect.mapError(toDeliveryRecoveryError))
          : null;
        const delivery = rechecked?.delivery ?? null;
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
          yield* providerTurnDeliveryWorker
            .acknowledgeOutcome(delivery.deliveryId)
            .pipe(Effect.mapError(toDeliveryRecoveryError));
        }
        yield* nextTurnQueueDispatcher
          .reconcileDeliveryPause(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        // Otherwise Recheck looks like it did nothing while history is unreadable.
        if (delivery?.state === "ambiguous" && rechecked?.historyError)
          return yield* new RouteRequestError({
            code: "NextTurnQueueDeliveryRecoveryError",
            message: `Couldn't read provider history: ${rechecked.historyError}`,
          });
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueRetryDelivery: {
        const body = stripRequestTag(request.body);
        const { providerTurnDeliveryWorker, nextTurnQueueDispatcher } =
          yield* awaitOrchestrationRuntimeForRoute;
        const blocking = yield* nextTurnQueueDispatcher
          .getBlockingDelivery(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        if (blocking) {
          const delivery = yield* providerTurnDeliveryWorker
            .retry({ ...body, deliveryId: blocking.deliveryId })
            .pipe(Effect.mapError(toDeliveryRecoveryError));
          yield* nextTurnQueueStore
            .retryDelivery({ commandId: delivery.commandId })
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          yield* nextTurnQueueStore
            .setPaused({ threadId: body.threadId, paused: false })
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          yield* nextTurnQueueDispatcher.notify(body.threadId);
        } else {
          // Nothing left to retry; release a pause left by a superseded delivery.
          yield* nextTurnQueueDispatcher
            .reconcileDeliveryPause(body.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        }
        return yield* nextTurnQueueDispatcher
          .getSnapshot(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      }

      case WS_METHODS.nextTurnQueueDiscardDelivery: {
        const body = stripRequestTag(request.body);
        const { providerTurnDeliveryWorker, nextTurnQueueDispatcher } =
          yield* awaitOrchestrationRuntimeForRoute;
        const blocking = yield* nextTurnQueueDispatcher
          .getBlockingDelivery(body.threadId)
          .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        if (blocking) {
          const delivery = yield* providerTurnDeliveryWorker
            .discard(body.threadId, blocking.deliveryId)
            .pipe(Effect.mapError(toDeliveryRecoveryError));
          yield* nextTurnQueueStore
            .discardDelivery({ commandId: delivery.commandId })
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          // Discard keeps the queue paused. With no other failed delivery left it
          // becomes a manual pause the user can resume; otherwise the pause
          // describes the delivery that still needs recovery.
          const remaining = yield* nextTurnQueueDispatcher
            .getBlockingDelivery(body.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          yield* nextTurnQueueStore
            .setPaused(
              remaining
                ? {
                    threadId: body.threadId,
                    paused: true,
                    reasonCode:
                      remaining.state === "ambiguous" ? "delivery_ambiguous" : "delivery_rejected",
                    detail: remaining.errorDetail ?? "The provider did not confirm this turn.",
                  }
                : { threadId: body.threadId, paused: true, reasonCode: "manual_pause" },
            )
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        } else {
          yield* nextTurnQueueDispatcher
            .reconcileDeliveryPause(body.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        }
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

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const rpcAdmissions = new WeakMap<WebSocket, RpcAdmission>();
  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    if (shuttingDown) {
      ws.close(1012, "Server shutting down");
      return;
    }
    const sendWsResponse = (response: WebSocketResponse, method?: string) =>
      encodeWsResponse(response).pipe(
        Effect.catch((cause) =>
          // The cause can quote the response payload, so only its kind is logged.
          Effect.logWarning("rpc response could not be encoded", {
            method: method ?? "unknown",
            error: cause instanceof Error ? cause.name : typeof cause,
          }).pipe(Effect.as(encodeResponseEncodeFailure(response.id))),
        ),
        Effect.tap((encodedResponse) => {
          const bytes = Buffer.byteLength(encodedResponse);
          return bytes >= LARGE_RPC_RESPONSE_LOG_BYTES
            ? Effect.logInfo("large rpc response", { method: method ?? "unknown", bytes })
            : Effect.void;
        }),
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
      const formattedFailure = formatSchemaError(request.failure);
      const boundedFailure =
        formattedFailure.length > 190
          ? `${formattedFailure.slice(0, 187).trimEnd()}...`
          : formattedFailure;
      return yield* sendWsResponse({
        // Echo the caller's id when recoverable so it fails immediately instead of timing out.
        id: readWebSocketRequestId(messageText) ?? "unknown",
        error: { message: `Invalid request format: ${boundedFailure}` },
      });
    }

    const method = request.success.body._tag;
    const lane = rpcLane(request.success.body);
    // Pre-execution, like `RpcBusy`: nothing runs and no slot is held. The
    // client holds the request until the runtime reports ready.
    const starting = serverStartingRejection(request.success.body, runtimeReadiness);
    if (starting) {
      yield* increment(rpcServerStartingTotal, { method });
      return yield* sendWsResponse({ id: request.success.id, error: starting }, method);
    }
    const admission = rpcAdmissions.get(ws) ?? new RpcAdmission();
    rpcAdmissions.set(ws, admission);
    const release = admission.claim(lane, Buffer.byteLength(messageText));
    if (!release) {
      yield* increment(rpcBusyTotal, { lane, method });
      return yield* sendWsResponse(
        {
          id: request.success.id,
          error: {
            code: "RpcBusy",
            retryable: true,
            retryAfterMs: 250,
            message: "This request lane is busy. Retry shortly.",
          },
        },
        method,
      );
    }
    const routeStartedAt = Date.now();
    const result = yield* Effect.exit(
      observeRpcEffect(
        method,
        routeRequest(ws, request.success).pipe(
          Effect.provideService(CurrentRpcMethod, method),
          Effect.ensuring(Effect.sync(release)),
        ),
        rpcTraceAttributesForRequest(request.success),
      ).pipe(
        Effect.withSpan(`rpc.${method}`, {
          kind: "server",
        }),
      ),
    );
    const routeMs = Date.now() - routeStartedAt;
    if (routeMs >= SLOW_RPC_ROUTE_MS) {
      recordSlowRpcRoute(method, routeMs, lane);
      yield* Effect.logInfo("slow rpc route", {
        method,
        lane,
        durationMs: routeMs,
        admission: admission.snapshot(),
      });
    }
    if (Exit.isFailure(result)) {
      // The client is told the message only, so a defect's trace is kept here.
      if (Cause.hasDies(result.cause))
        yield* Effect.logError("rpc route defect", {
          method,
          cause: Cause.pretty(result.cause),
        });
      return yield* sendWsResponse(
        {
          id: request.success.id,
          error: formatRouteFailure(result.cause, method),
        },
        method,
      );
    }

    return yield* sendWsResponse(
      {
        id: request.success.id,
        result: result.value,
      },
      method,
    );
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (shuttingDown) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://localhost:${port}`);
    } catch {
      rejectUpgrade(socket, 400, "Invalid WebSocket URL");
      return;
    }

    if (!serverAuth.isRequestHostAllowed(request)) {
      rejectUpgrade(socket, 403, REQUEST_HOST_NOT_ALLOWED_MESSAGE);
      return;
    }

    if (!serverAuth.isWebSocketOriginAllowed(request)) {
      // The usual cause behind a TLS proxy on another host: its X-Forwarded-Proto is not
      // believed, so the https Origin does not match. Say so instead of a bare refusal.
      const ignoredPeer = serverAuth.ignoredForwardedProtoPeer(request);
      rejectUpgrade(
        socket,
        403,
        ignoredPeer === null
          ? "WebSocket origin is not allowed"
          : `WebSocket origin is not allowed. X-Forwarded-Proto from ${ignoredPeer} was ignored; ` +
              "if that is your reverse proxy, start F5 with --trusted-proxy.",
      );
      return;
    }

    if (!serverAuth.isWebSocketRequestAuthenticated(request, url)) {
      // A locked-out client is told to wait, so it does not take its token for a wrong one.
      const retryAfter = serverAuth.bearerRetryAfterSeconds(request);
      if (retryAfter === null) rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
      else
        rejectUpgrade(socket, 429, AUTH_RATE_LIMITED_MESSAGE, { "Retry-After": `${retryAfter}` });
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (
        url.searchParams.getAll(F5_PROTOCOL_QUERY).length !== 1 ||
        !protocolMatches(url.searchParams.get(F5_PROTOCOL_QUERY))
      ) {
        ws.on("error", () => {});
        ws.close(F5_UPGRADE_REQUIRED_CLOSE_CODE, JSON.stringify(UPGRADE_REQUIRED));
        return;
      }
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    let disconnectRecorded = false;
    socketLiveness.add(ws);
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

    let welcomeRuntime: ServerRuntimeReadiness | null = null;
    const welcomeData = {
      backendIncarnation: BACKEND_INCARNATION,
      bootstrap: SERVER_BOOTSTRAP,
      cwd,
      projectName,
      ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
      ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
    };
    // Send welcome before adding to broadcast set so publishAll calls
    // cannot reach this client before the welcome arrives.
    void runPromise(
      (autoBootstrapProjectFromCwd ? readiness.awaitServerReady : readiness.awaitClientReady).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (logWebSocketEvents) logger.event("welcome readiness reached");
          }),
        ),
        Effect.flatMap(() => profileCall(readProfiles)),
        Effect.flatMap((snapshot) =>
          pushBus.publishClient(ws, WS_CHANNELS.serverWelcome, {
            ...welcomeData,
            runtime: (welcomeRuntime = currentRuntimeReadiness()),
            profile: snapshot.profiles.find((profile) => profile.isActive) ?? welcomeFallback(),
            ...(snapshot.diagnostic ? { profileDiagnostic: snapshot.diagnostic } : {}),
            ...(getDatabaseDamage() ? { databaseDamage: getDatabaseDamage()! } : {}),
          }),
        ),
        Effect.tap((delivered) =>
          Effect.sync(() => {
            if (logWebSocketEvents) logger.event("welcome delivery settled", { delivered });
          }),
        ),
        Effect.flatMap((delivered) =>
          delivered
            ? Ref.modify(clients, (clients) =>
                ws.readyState === ws.OPEN && !disconnectRecorded
                  ? [true, clients.add(ws)]
                  : [false, clients],
              )
            : Effect.succeed(false),
        ),
        Effect.flatMap((joined) =>
          joined
            ? Effect.void.pipe(
                // Readiness that changed between the welcome and joining the
                // broadcast set would otherwise be lost for this client.
                Effect.andThen(
                  Effect.suspend(() =>
                    welcomeRuntime !== null && runtimeReadiness.revision !== welcomeRuntime.revision
                      ? pushBus.publishClient(ws, WS_CHANNELS.serverRuntimeReadiness, {
                          ...runtimeReadiness,
                          backendIncarnation: BACKEND_INCARNATION,
                        })
                      : Effect.void,
                  ),
                ),
                Effect.andThen(registerPreviewAutomationHost(ws)),
                Effect.andThen(
                  Effect.suspend(() => {
                    if (Option.isSome(computerAutomationBroker)) {
                      const computer = computerAutomationBroker.value;
                      const snapshot = computer.snapshot();
                      return Effect.all([
                        pushBus.publishClient(
                          ws,
                          WS_CHANNELS.agentComputerUseChanged,
                          agentComputerUsePush(snapshot.computerUse),
                        ),
                        ...snapshot.pausedThreads.map((threadId) =>
                          pushBus.publishClient(ws, WS_CHANNELS.previewAutomationPauseChanged, {
                            threadId: ThreadId.makeUnsafe(threadId),
                            paused: true,
                          }),
                        ),
                        ...snapshot.pending.map((request) =>
                          pushBus.publishClient(ws, WS_CHANNELS.computerAccessRequested, request),
                        ),
                        ...snapshot.grants.map((grants) =>
                          pushBus.publishClient(
                            ws,
                            WS_CHANNELS.computerAccessGrantsChanged,
                            grants,
                          ),
                        ),
                      ]).pipe(Effect.asVoid);
                    }
                    const holder = computerUseLease.current();
                    return holder === null
                      ? Effect.void
                      : pushBus.publishClient(ws, WS_CHANNELS.agentComputerUseChanged, {
                          holders: [
                            {
                              threadId: ThreadId.makeUnsafe(holder),
                              delivery: "foreground",
                              state: "active",
                            },
                          ],
                        });
                  }),
                ),
              )
            : Effect.void,
        ),
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
    });

    const recordDisconnect = () => {
      if (disconnectRecorded) {
        return;
      }
      disconnectRecorded = true;
      rpcAdmissions.delete(ws);
      workspaceWatchRegistry.releaseSubscriber(ws);
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
              const hostId = previewAutomationHostIdByWs.get(ws);
              if (hostId) {
                htmlPreviewBroker.unregister(hostId);
                yield* previewAutomationBroker.unregisterHost(hostId);
              }
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

    ws.on("close", () => {
      void accountService.disconnect(ws).catch(() => {});
    });
    ws.on("close", recordDisconnect);
    ws.on("error", recordDisconnect);
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
