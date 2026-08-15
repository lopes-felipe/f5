import { Schema, Struct, Tuple } from "effect";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

import {
  OrchestrationArchiveInvestigationWorkflowInput,
  OrchestrationArchiveCodeReviewWorkflowInput,
  OrchestrationArchiveWorkflowInput,
  ClientOrchestrationCommand,
  OrchestrationCreateInvestigationWorkflowInput,
  OrchestrationCreateWorkflowInput,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationDeleteInvestigationWorkflowInput,
  OrchestrationDeleteWorkflowInput,
  OrchestrationDeleteCodeReviewWorkflowInput,
  OrchestrationEvent,
  ORCHESTRATION_WS_CHANNELS,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetThreadCommandExecutionInput,
  OrchestrationGetThreadFileChangeInput,
  OrchestrationGetThreadFileChangesInput,
  OrchestrationGetThreadCommandExecutionsInput,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetThreadDetailsInput,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotInput,
  OrchestrationGetStartupSnapshotInput,
  OrchestrationGetThreadTailDetailsInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationRetryWorkflowInput,
  OrchestrationRetryInvestigationWorkflowInput,
  OrchestrationRetryCodeReviewWorkflowInput,
  OrchestrationStartImplementationInput,
  OrchestrationUnarchiveInvestigationWorkflowInput,
  OrchestrationUnarchiveCodeReviewWorkflowInput,
  OrchestrationUnarchiveWorkflowInput,
} from "./orchestration";
import {
  McpApplyToLiveSessionsRequest,
  McpGetCommonConfigRequest,
  McpGetLoginStatusRequest,
  McpGetProviderStatusRequest,
  McpGetCodexStatusRequest,
  McpGetEffectiveConfigRequest,
  McpGetProjectConfigRequest,
  McpGetServerStatusesRequest,
  McpOauthLoginStatusRequest,
  McpReloadProjectRequest,
  McpReplaceCommonConfigRequest,
  McpReplaceProjectConfigRequest,
  McpStartLoginRequest,
  McpStartOauthLoginRequest,
  McpStatusUpdatedPayload,
} from "./mcp";
import {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitCreateWorktreeInput,
  GitInitInput,
  GitListBranchesInput,
  GitPullInput,
  GitPullRequestRefInput,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitStatusInvalidatedPayload,
  GitStatusInput,
} from "./git";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import { KeybindingRule } from "./keybindings";
import {
  ProjectCancelContentSearchInput,
  ProjectAuthorizeEntryInput,
  ProjectListEntriesInput,
  ProjectReadFileInput,
  ProjectSearchEntriesInput,
  ProjectSearchContentsInput,
  ProjectWriteFileInput,
} from "./project";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewEvent,
  PreviewListInput,
  PreviewListLocalServersInput,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewRecordingMetricsInput,
  PreviewReportStatusInput,
} from "./preview";
import {
  PreviewAutomationClearOwnerInput,
  PreviewAutomationOwner,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
} from "./previewAutomation";
import { FilesystemBrowseInput } from "./filesystem";
import { OpenInEditorInput, RevealInFileManagerInput } from "./editor";
import {
  ServerProviderAdvisoriesUpdatedPayload,
  ServerAddKeybindingInput,
  ServerConfigUpdatedPayload,
  ServerRemoveKeybindingInput,
  ServerResetKeybindingsInput,
  ServerUpdateKeybindingInput,
  ServerValidateHarnessesInput,
} from "./server";
import { ServerSettingsPatch } from "./settings";
import {
  StorageCancelCleanupRequest,
  StorageCleanupProgressPayload,
  StorageCleanupRequest,
  StorageGetUsageRequest,
  StorageInvalidatedPayload,
} from "./storage";
import {
  PR_HUB_WS_CHANNELS,
  PR_HUB_WS_METHODS,
  PrHubAdvisorySnapshot,
  PrHubAnalyzeAdvisoriesInput,
  PrHubClearDataInput,
  PrHubCommentInput,
  PrHubGetAdvisoriesInput,
  PrHubIgnoreInput,
  PrHubLocalCandidatesInput,
  PrHubMarkNotifiedInput,
  PrHubMarkReadyInput,
  PrHubMarkSeenInput,
  PrHubMergeInput,
  PrHubRefreshInput,
  PrHubRequestChangesInput,
  PrHubReRequestInput,
  PrHubReviewInput,
  PrHubSnapshot,
  PrHubSnoozeInput,
  PrHubUnsnoozeInput,
} from "./prHub";
import {
  NextTurnQueueCancelInput,
  NextTurnQueueClearInput,
  NextTurnQueueDuplicateInput,
  NextTurnQueueListInput,
  NextTurnQueuePromoteInput,
  NextTurnQueueRefreshGateInput,
  NextTurnQueueReorderInput,
  NextTurnQueueRestoreInput,
  NextTurnQueueRecheckDeliveryInput,
  NextTurnQueueRetryDeliveryInput,
  NextTurnQueueDiscardDeliveryInput,
  NextTurnQueueRetryInput,
  NextTurnQueueSetPausedInput,
  NextTurnQueueSnapshot,
  NextTurnQueueSubmitInput,
  NextTurnQueueSummary,
  NextTurnQueueSummaryInput,
  NextTurnQueueUpdateInput,
} from "./nextTurnQueue";
import { GlobalSearchQueryInput } from "./globalSearch";
import { ReviewPreviewDiffInput } from "./review";
import {
  WorkflowPlatformCreateRunInput,
  WorkflowPlatformInspectRunInput,
} from "./workflowPlatform";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsSearchEntries: "projects.searchEntries",
  projectsSearchContents: "projects.searchContents",
  projectsCancelContentSearch: "projects.cancelContentSearch",
  projectsWriteFile: "projects.writeFile",
  projectsReadFile: "projects.readFile",
  projectsAuthorizeEntry: "projects.authorizeEntry",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",
  shellRevealInFileManager: "shell.revealInFileManager",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  reviewPreviewDiff: "review.previewDiff",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewReportStatus: "preview.reportStatus",
  previewReportRecordingMetrics: "preview.reportRecordingMetrics",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewListLocalServers: "preview.listLocalServers",
  previewAutomationRespond: "preview.automation.respond",
  previewAutomationReportOwner: "preview.automation.reportOwner",
  previewAutomationClearOwner: "preview.automation.clearOwner",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverUpdateSettings: "server.updateSettings",
  serverRefreshProviders: "server.refreshProviders",
  serverValidateHarnesses: "server.validateHarnesses",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverAddKeybinding: "server.addKeybinding",
  serverUpdateKeybinding: "server.updateKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverResetKeybindings: "server.resetKeybindings",

  // Storage maintenance
  storageGetUsage: "storage.getUsage",
  storageCleanup: "storage.cleanup",
  storageCancelCleanup: "storage.cancelCleanup",

  // Durable per-thread next-turn queue
  nextTurnQueueList: "nextTurnQueue.list",
  nextTurnQueueSubmit: "nextTurnQueue.submit",
  nextTurnQueueSummary: "nextTurnQueue.summary",
  nextTurnQueueUpdate: "nextTurnQueue.update",
  nextTurnQueueCancel: "nextTurnQueue.cancel",
  nextTurnQueueReorder: "nextTurnQueue.reorder",
  nextTurnQueueRetry: "nextTurnQueue.retry",
  nextTurnQueuePromote: "nextTurnQueue.promote",
  nextTurnQueueSetPaused: "nextTurnQueue.setPaused",
  nextTurnQueueDuplicate: "nextTurnQueue.duplicate",
  nextTurnQueueRefreshGate: "nextTurnQueue.refreshGate",
  nextTurnQueueClear: "nextTurnQueue.clear",
  nextTurnQueueRestore: "nextTurnQueue.restore",
  nextTurnQueueRecheckDelivery: "nextTurnQueue.recheckDelivery",
  nextTurnQueueRetryDelivery: "nextTurnQueue.retryDelivery",
  nextTurnQueueDiscardDelivery: "nextTurnQueue.discardDelivery",

  // Cross-project full-text search
  globalSearchQuery: "globalSearch.query",

  // Versioned declarative workflow platform
  workflowPlatformListTemplates: "workflowPlatform.listTemplates",
  workflowPlatformCreateRun: "workflowPlatform.createRun",
  workflowPlatformInspectRun: "workflowPlatform.inspectRun",

  mcpGetCommonConfig: "mcp.getCommonConfig",
  mcpReplaceCommonConfig: "mcp.replaceCommonConfig",
  mcpGetProjectConfig: "mcp.getProjectConfig",
  mcpReplaceProjectConfig: "mcp.replaceProjectConfig",
  mcpGetEffectiveConfig: "mcp.getEffectiveConfig",
  mcpGetProviderStatus: "mcp.getProviderStatus",
  mcpGetServerStatuses: "mcp.getServerStatuses",
  mcpStartLogin: "mcp.startLogin",
  mcpGetLoginStatus: "mcp.getLoginStatus",
  mcpGetCodexStatus: "mcp.getCodexStatus",
  mcpReloadProject: "mcp.reloadProject",
  mcpApplyToLiveSessions: "mcp.applyToLiveSessions",
  mcpStartOAuthLogin: "mcp.startOAuthLogin",
  mcpGetOAuthStatus: "mcp.getOAuthStatus",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  gitActionProgress: "git.actionProgress",
  gitStatusInvalidated: "git.status.invalidate",
  terminalEvent: "terminal.event",
  previewEvent: "preview.event",
  previewLocalServersUpdated: "preview.localServersUpdated",
  previewAutomationRequest: "preview.automation.request",
  serverWelcome: "server.welcome",
  serverConfigUpdated: "server.configUpdated",
  providerAdvisoriesUpdated: "provider.advisoriesUpdated",
  mcpStatusUpdated: "mcp.statusUpdated",
  storageInvalidated: "storage.invalidated",
  storageCleanupProgress: "storage.cleanupProgress",
  nextTurnQueueUpdated: "nextTurnQueue.updated",
  nextTurnQueueSummaryUpdated: "nextTurnQueue.summaryUpdated",
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    // PreserveChecks is safe here. No existing schema should have checks depending on the tag
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  // Orchestration methods
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    Schema.Struct({ command: ClientOrchestrationCommand }),
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getStartupSnapshot, OrchestrationGetStartupSnapshotInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadTailDetails,
    OrchestrationGetThreadTailDetailsInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
    OrchestrationGetThreadHistoryPageInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getThreadDetails, OrchestrationGetThreadDetailsInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getTurnDiff, OrchestrationGetTurnDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getFullThreadDiff, OrchestrationGetFullThreadDiffInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadCommandExecutions,
    OrchestrationGetThreadCommandExecutionsInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadCommandExecution,
    OrchestrationGetThreadCommandExecutionInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadFileChanges,
    OrchestrationGetThreadFileChangesInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadFileChange,
    OrchestrationGetThreadFileChangeInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.createWorkflow, OrchestrationCreateWorkflowInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.archiveWorkflow, OrchestrationArchiveWorkflowInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.unarchiveWorkflow, OrchestrationUnarchiveWorkflowInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow,
    OrchestrationCreateCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.createInvestigationWorkflow,
    OrchestrationCreateInvestigationWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow,
    OrchestrationArchiveCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.archiveInvestigationWorkflow,
    OrchestrationArchiveInvestigationWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow,
    OrchestrationUnarchiveCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.unarchiveInvestigationWorkflow,
    OrchestrationUnarchiveInvestigationWorkflowInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.deleteWorkflow, OrchestrationDeleteWorkflowInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow,
    OrchestrationDeleteCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.deleteInvestigationWorkflow,
    OrchestrationDeleteInvestigationWorkflowInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.retryWorkflow, OrchestrationRetryWorkflowInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow,
    OrchestrationRetryCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.retryInvestigationWorkflow,
    OrchestrationRetryInvestigationWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.startImplementation,
    OrchestrationStartImplementationInput,
  ),

  // Project Search
  tagRequestBody(WS_METHODS.projectsListEntries, ProjectListEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchContents, ProjectSearchContentsInput),
  tagRequestBody(WS_METHODS.projectsCancelContentSearch, ProjectCancelContentSearchInput),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),
  tagRequestBody(WS_METHODS.projectsReadFile, ProjectReadFileInput),
  tagRequestBody(WS_METHODS.projectsAuthorizeEntry, ProjectAuthorizeEntryInput),

  // Filesystem methods
  tagRequestBody(WS_METHODS.filesystemBrowse, FilesystemBrowseInput),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),
  tagRequestBody(WS_METHODS.shellRevealInFileManager, RevealInFileManagerInput),

  // Git methods
  tagRequestBody(WS_METHODS.gitPull, GitPullInput),
  tagRequestBody(WS_METHODS.gitStatus, GitStatusInput),
  tagRequestBody(WS_METHODS.gitRunStackedAction, GitRunStackedActionInput),
  tagRequestBody(WS_METHODS.gitListBranches, GitListBranchesInput),
  tagRequestBody(WS_METHODS.gitCreateWorktree, GitCreateWorktreeInput),
  tagRequestBody(WS_METHODS.gitRemoveWorktree, GitRemoveWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateBranch, GitCreateBranchInput),
  tagRequestBody(WS_METHODS.gitCheckout, GitCheckoutInput),
  tagRequestBody(WS_METHODS.gitInit, GitInitInput),
  tagRequestBody(WS_METHODS.gitResolvePullRequest, GitPullRequestRefInput),
  tagRequestBody(WS_METHODS.gitPreparePullRequestThread, GitPreparePullRequestThreadInput),
  tagRequestBody(WS_METHODS.reviewPreviewDiff, ReviewPreviewDiffInput),

  // Terminal methods
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  tagRequestBody(WS_METHODS.terminalWrite, TerminalWriteInput),
  tagRequestBody(WS_METHODS.terminalResize, TerminalResizeInput),
  tagRequestBody(WS_METHODS.terminalClear, TerminalClearInput),
  tagRequestBody(WS_METHODS.terminalRestart, TerminalRestartInput),
  tagRequestBody(WS_METHODS.terminalClose, TerminalCloseInput),

  // Preview methods
  tagRequestBody(WS_METHODS.previewOpen, PreviewOpenInput),
  tagRequestBody(WS_METHODS.previewNavigate, PreviewNavigateInput),
  tagRequestBody(WS_METHODS.previewReportStatus, PreviewReportStatusInput),
  tagRequestBody(WS_METHODS.previewReportRecordingMetrics, PreviewRecordingMetricsInput),
  tagRequestBody(WS_METHODS.previewRefresh, PreviewRefreshInput),
  tagRequestBody(WS_METHODS.previewClose, PreviewCloseInput),
  tagRequestBody(WS_METHODS.previewList, PreviewListInput),
  tagRequestBody(WS_METHODS.previewListLocalServers, PreviewListLocalServersInput),
  tagRequestBody(WS_METHODS.previewAutomationRespond, PreviewAutomationResponse),
  tagRequestBody(WS_METHODS.previewAutomationReportOwner, PreviewAutomationOwner),
  tagRequestBody(WS_METHODS.previewAutomationClearOwner, PreviewAutomationClearOwnerInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverProbe, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverUpdateSettings, ServerSettingsPatch),
  tagRequestBody(WS_METHODS.serverRefreshProviders, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverValidateHarnesses, ServerValidateHarnessesInput),
  tagRequestBody(WS_METHODS.serverUpsertKeybinding, KeybindingRule),
  tagRequestBody(WS_METHODS.serverAddKeybinding, ServerAddKeybindingInput),
  tagRequestBody(WS_METHODS.serverUpdateKeybinding, ServerUpdateKeybindingInput),
  tagRequestBody(WS_METHODS.serverRemoveKeybinding, ServerRemoveKeybindingInput),
  tagRequestBody(WS_METHODS.serverResetKeybindings, ServerResetKeybindingsInput),
  tagRequestBody(WS_METHODS.storageGetUsage, StorageGetUsageRequest),
  tagRequestBody(WS_METHODS.storageCleanup, StorageCleanupRequest),
  tagRequestBody(WS_METHODS.storageCancelCleanup, StorageCancelCleanupRequest),
  tagRequestBody(WS_METHODS.nextTurnQueueList, NextTurnQueueListInput),
  tagRequestBody(WS_METHODS.nextTurnQueueSubmit, NextTurnQueueSubmitInput),
  tagRequestBody(WS_METHODS.nextTurnQueueSummary, NextTurnQueueSummaryInput),
  tagRequestBody(WS_METHODS.nextTurnQueueUpdate, NextTurnQueueUpdateInput),
  tagRequestBody(WS_METHODS.nextTurnQueueCancel, NextTurnQueueCancelInput),
  tagRequestBody(WS_METHODS.nextTurnQueueReorder, NextTurnQueueReorderInput),
  tagRequestBody(WS_METHODS.nextTurnQueueRetry, NextTurnQueueRetryInput),
  tagRequestBody(WS_METHODS.nextTurnQueuePromote, NextTurnQueuePromoteInput),
  tagRequestBody(WS_METHODS.nextTurnQueueSetPaused, NextTurnQueueSetPausedInput),
  tagRequestBody(WS_METHODS.nextTurnQueueDuplicate, NextTurnQueueDuplicateInput),
  tagRequestBody(WS_METHODS.nextTurnQueueRefreshGate, NextTurnQueueRefreshGateInput),
  tagRequestBody(WS_METHODS.nextTurnQueueClear, NextTurnQueueClearInput),
  tagRequestBody(WS_METHODS.nextTurnQueueRestore, NextTurnQueueRestoreInput),
  tagRequestBody(WS_METHODS.nextTurnQueueRecheckDelivery, NextTurnQueueRecheckDeliveryInput),
  tagRequestBody(WS_METHODS.nextTurnQueueRetryDelivery, NextTurnQueueRetryDeliveryInput),
  tagRequestBody(WS_METHODS.nextTurnQueueDiscardDelivery, NextTurnQueueDiscardDeliveryInput),
  tagRequestBody(WS_METHODS.globalSearchQuery, GlobalSearchQueryInput),
  tagRequestBody(WS_METHODS.workflowPlatformListTemplates, Schema.Struct({})),
  WorkflowPlatformCreateRunInput.mapMembers(
    Tuple.map(Schema.fieldsAssign({ _tag: Schema.tag(WS_METHODS.workflowPlatformCreateRun) })),
  ),
  tagRequestBody(WS_METHODS.workflowPlatformInspectRun, WorkflowPlatformInspectRunInput),
  tagRequestBody(WS_METHODS.mcpGetCommonConfig, McpGetCommonConfigRequest),
  tagRequestBody(WS_METHODS.mcpReplaceCommonConfig, McpReplaceCommonConfigRequest),
  tagRequestBody(WS_METHODS.mcpGetProjectConfig, McpGetProjectConfigRequest),
  tagRequestBody(WS_METHODS.mcpReplaceProjectConfig, McpReplaceProjectConfigRequest),
  tagRequestBody(WS_METHODS.mcpGetEffectiveConfig, McpGetEffectiveConfigRequest),
  tagRequestBody(WS_METHODS.mcpGetProviderStatus, McpGetProviderStatusRequest),
  tagRequestBody(WS_METHODS.mcpGetServerStatuses, McpGetServerStatusesRequest),
  tagRequestBody(WS_METHODS.mcpStartLogin, McpStartLoginRequest),
  tagRequestBody(WS_METHODS.mcpGetLoginStatus, McpGetLoginStatusRequest),
  tagRequestBody(WS_METHODS.mcpGetCodexStatus, McpGetCodexStatusRequest),
  tagRequestBody(WS_METHODS.mcpReloadProject, McpReloadProjectRequest),
  tagRequestBody(WS_METHODS.mcpApplyToLiveSessions, McpApplyToLiveSessionsRequest),
  tagRequestBody(WS_METHODS.mcpStartOAuthLogin, McpStartOauthLoginRequest),
  tagRequestBody(WS_METHODS.mcpGetOAuthStatus, McpOauthLoginStatusRequest),

  // PR Hub methods
  tagRequestBody(PR_HUB_WS_METHODS.getSnapshot, Schema.Struct({})),
  tagRequestBody(PR_HUB_WS_METHODS.refresh, PrHubRefreshInput),
  tagRequestBody(PR_HUB_WS_METHODS.approve, PrHubReviewInput),
  tagRequestBody(PR_HUB_WS_METHODS.requestChanges, PrHubRequestChangesInput),
  tagRequestBody(PR_HUB_WS_METHODS.comment, PrHubCommentInput),
  tagRequestBody(PR_HUB_WS_METHODS.merge, PrHubMergeInput),
  tagRequestBody(PR_HUB_WS_METHODS.markReady, PrHubMarkReadyInput),
  tagRequestBody(PR_HUB_WS_METHODS.reRequestReview, PrHubReRequestInput),
  tagRequestBody(PR_HUB_WS_METHODS.snooze, PrHubSnoozeInput),
  tagRequestBody(PR_HUB_WS_METHODS.unsnooze, PrHubUnsnoozeInput),
  tagRequestBody(PR_HUB_WS_METHODS.ignore, PrHubIgnoreInput),
  tagRequestBody(PR_HUB_WS_METHODS.markSeen, PrHubMarkSeenInput),
  tagRequestBody(PR_HUB_WS_METHODS.markNotified, PrHubMarkNotifiedInput),
  tagRequestBody(PR_HUB_WS_METHODS.analyzeAdvisories, PrHubAnalyzeAdvisoriesInput),
  tagRequestBody(PR_HUB_WS_METHODS.getAdvisories, PrHubGetAdvisoriesInput),
  tagRequestBody(PR_HUB_WS_METHODS.listLocalCheckoutCandidates, PrHubLocalCandidatesInput),
  tagRequestBody(PR_HUB_WS_METHODS.clearData, PrHubClearDataInput),
]);

export const WebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.String),
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPushSequence = NonNegativeInt;
export type WsPushSequence = typeof WsPushSequence.Type;

export const WsWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;

export interface WsPushPayloadByChannel {
  readonly [WS_CHANNELS.serverWelcome]: WsWelcomePayload;
  readonly [WS_CHANNELS.serverConfigUpdated]: typeof ServerConfigUpdatedPayload.Type;
  readonly [WS_CHANNELS.providerAdvisoriesUpdated]: typeof ServerProviderAdvisoriesUpdatedPayload.Type;
  readonly [WS_CHANNELS.gitActionProgress]: typeof GitActionProgressEvent.Type;
  readonly [WS_CHANNELS.gitStatusInvalidated]: typeof GitStatusInvalidatedPayload.Type;
  readonly [WS_CHANNELS.terminalEvent]: typeof TerminalEvent.Type;
  readonly [WS_CHANNELS.previewEvent]: PreviewEvent;
  readonly [WS_CHANNELS.previewLocalServersUpdated]: DiscoveredLocalServerList;
  readonly [WS_CHANNELS.previewAutomationRequest]: typeof PreviewAutomationRequest.Type;
  readonly [WS_CHANNELS.mcpStatusUpdated]: McpStatusUpdatedPayload;
  readonly [WS_CHANNELS.storageInvalidated]: StorageInvalidatedPayload;
  readonly [WS_CHANNELS.storageCleanupProgress]: StorageCleanupProgressPayload;
  readonly [WS_CHANNELS.nextTurnQueueUpdated]: typeof NextTurnQueueSnapshot.Type;
  readonly [WS_CHANNELS.nextTurnQueueSummaryUpdated]: typeof NextTurnQueueSummary.Type;
  readonly [ORCHESTRATION_WS_CHANNELS.domainEvent]: OrchestrationEvent;
  readonly [PR_HUB_WS_CHANNELS.snapshotUpdated]: typeof PrHubSnapshot.Type;
  readonly [PR_HUB_WS_CHANNELS.advisoriesUpdated]: typeof PrHubAdvisorySnapshot.Type;
}

export type WsPushChannel = keyof WsPushPayloadByChannel;
export type WsPushData<C extends WsPushChannel> = WsPushPayloadByChannel[C];

const makeWsPushSchema = <const Channel extends string, Payload extends Schema.Schema<any>>(
  channel: Channel,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal("push"),
    sequence: WsPushSequence,
    channel: Schema.Literal(channel),
    data: payload,
  });

export const WsPushServerWelcome = makeWsPushSchema(WS_CHANNELS.serverWelcome, WsWelcomePayload);
export const WsPushServerConfigUpdated = makeWsPushSchema(
  WS_CHANNELS.serverConfigUpdated,
  ServerConfigUpdatedPayload,
);
export const WsPushProviderAdvisoriesUpdated = makeWsPushSchema(
  WS_CHANNELS.providerAdvisoriesUpdated,
  ServerProviderAdvisoriesUpdatedPayload,
);
export const WsPushGitActionProgress = makeWsPushSchema(
  WS_CHANNELS.gitActionProgress,
  GitActionProgressEvent,
);
export const WsPushGitStatusInvalidated = makeWsPushSchema(
  WS_CHANNELS.gitStatusInvalidated,
  GitStatusInvalidatedPayload,
);
export const WsPushTerminalEvent = makeWsPushSchema(WS_CHANNELS.terminalEvent, TerminalEvent);
export const WsPushPreviewEvent = makeWsPushSchema(WS_CHANNELS.previewEvent, PreviewEvent);
export const WsPushPreviewLocalServersUpdated = makeWsPushSchema(
  WS_CHANNELS.previewLocalServersUpdated,
  DiscoveredLocalServerList,
);
export const WsPushPreviewAutomationRequest = makeWsPushSchema(
  WS_CHANNELS.previewAutomationRequest,
  PreviewAutomationRequest,
);
export const WsPushMcpStatusUpdated = makeWsPushSchema(
  WS_CHANNELS.mcpStatusUpdated,
  McpStatusUpdatedPayload,
);
export const WsPushStorageInvalidated = makeWsPushSchema(
  WS_CHANNELS.storageInvalidated,
  StorageInvalidatedPayload,
);
export const WsPushStorageCleanupProgress = makeWsPushSchema(
  WS_CHANNELS.storageCleanupProgress,
  StorageCleanupProgressPayload,
);
export const WsPushNextTurnQueueUpdated = makeWsPushSchema(
  WS_CHANNELS.nextTurnQueueUpdated,
  NextTurnQueueSnapshot,
);
export const WsPushNextTurnQueueSummaryUpdated = makeWsPushSchema(
  WS_CHANNELS.nextTurnQueueSummaryUpdated,
  NextTurnQueueSummary,
);
export const WsPushOrchestrationDomainEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  OrchestrationEvent,
);
export const WsPushPrHubSnapshotUpdated = makeWsPushSchema(
  PR_HUB_WS_CHANNELS.snapshotUpdated,
  PrHubSnapshot,
);
export const WsPushPrHubAdvisoriesUpdated = makeWsPushSchema(
  PR_HUB_WS_CHANNELS.advisoriesUpdated,
  PrHubAdvisorySnapshot,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.gitActionProgress,
  WS_CHANNELS.gitStatusInvalidated,
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.providerAdvisoriesUpdated,
  WS_CHANNELS.terminalEvent,
  WS_CHANNELS.previewEvent,
  WS_CHANNELS.previewLocalServersUpdated,
  WS_CHANNELS.previewAutomationRequest,
  WS_CHANNELS.mcpStatusUpdated,
  WS_CHANNELS.storageInvalidated,
  WS_CHANNELS.storageCleanupProgress,
  WS_CHANNELS.nextTurnQueueUpdated,
  WS_CHANNELS.nextTurnQueueSummaryUpdated,
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  PR_HUB_WS_CHANNELS.snapshotUpdated,
  PR_HUB_WS_CHANNELS.advisoriesUpdated,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushServerWelcome,
  WsPushServerConfigUpdated,
  WsPushProviderAdvisoriesUpdated,
  WsPushGitActionProgress,
  WsPushGitStatusInvalidated,
  WsPushTerminalEvent,
  WsPushPreviewEvent,
  WsPushPreviewLocalServersUpdated,
  WsPushPreviewAutomationRequest,
  WsPushMcpStatusUpdated,
  WsPushStorageInvalidated,
  WsPushStorageCleanupProgress,
  WsPushNextTurnQueueUpdated,
  WsPushNextTurnQueueSummaryUpdated,
  WsPushOrchestrationDomainEvent,
  WsPushPrHubSnapshotUpdated,
  WsPushPrHubAdvisoriesUpdated,
]);
export type WsPush = typeof WsPush.Type;

export type WsPushMessage<C extends WsPushChannel> = Extract<WsPush, { channel: C }>;

export const WsPushEnvelopeBase = Schema.Struct({
  type: Schema.Literal("push"),
  sequence: WsPushSequence,
  channel: WsPushChannelSchema,
  data: Schema.Unknown,
});
export type WsPushEnvelopeBase = typeof WsPushEnvelopeBase.Type;

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;
