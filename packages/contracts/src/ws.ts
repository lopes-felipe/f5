import { Schema, Struct } from "effect";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

import {
  OrchestrationArchiveCodeReviewWorkflowInput,
  OrchestrationArchiveWorkflowInput,
  ClientOrchestrationCommand,
  OrchestrationCreateWorkflowInput,
  OrchestrationCreateCodeReviewWorkflowInput,
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
  OrchestrationReplayEventsInput,
  OrchestrationRetryWorkflowInput,
  OrchestrationRetryCodeReviewWorkflowInput,
  OrchestrationStartImplementationInput,
  OrchestrationUnarchiveCodeReviewWorkflowInput,
  OrchestrationUnarchiveWorkflowInput,
} from "./orchestration";
import {
  McpApplyToLiveSessionsRequest,
  McpGetCommonConfigRequest,
  McpGetCodexStatusRequest,
  McpGetEffectiveConfigRequest,
  McpGetProjectConfigRequest,
  McpOauthLoginStatusRequest,
  McpReloadProjectRequest,
  McpReplaceCommonConfigRequest,
  McpReplaceProjectConfigRequest,
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
import { ProjectReadFileInput, ProjectSearchEntriesInput, ProjectWriteFileInput } from "./project";
import { FilesystemBrowseInput } from "./filesystem";
import { OpenInEditorInput } from "./editor";
import { ServerConfigUpdatedPayload, ServerValidateHarnessesInput } from "./server";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsReadFile: "projects.readFile",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

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

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverValidateHarnesses: "server.validateHarnesses",
  serverUpsertKeybinding: "server.upsertKeybinding",
  mcpGetCommonConfig: "mcp.getCommonConfig",
  mcpReplaceCommonConfig: "mcp.replaceCommonConfig",
  mcpGetProjectConfig: "mcp.getProjectConfig",
  mcpReplaceProjectConfig: "mcp.replaceProjectConfig",
  mcpGetEffectiveConfig: "mcp.getEffectiveConfig",
  mcpGetCodexStatus: "mcp.getCodexStatus",
  mcpReloadProject: "mcp.reloadProject",
  mcpApplyToLiveSessions: "mcp.applyToLiveSessions",
  mcpStartOAuthLogin: "mcp.startOAuthLogin",
  mcpGetOAuthStatus: "mcp.getOAuthStatus",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  gitActionProgress: "git.actionProgress",
  terminalEvent: "terminal.event",
  serverWelcome: "server.welcome",
  serverConfigUpdated: "server.configUpdated",
  mcpStatusUpdated: "mcp.statusUpdated",
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
  tagRequestBody(ORCHESTRATION_WS_METHODS.replayEvents, OrchestrationReplayEventsInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.createWorkflow, OrchestrationCreateWorkflowInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.archiveWorkflow, OrchestrationArchiveWorkflowInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.unarchiveWorkflow, OrchestrationUnarchiveWorkflowInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow,
    OrchestrationCreateCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow,
    OrchestrationArchiveCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow,
    OrchestrationUnarchiveCodeReviewWorkflowInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.deleteWorkflow, OrchestrationDeleteWorkflowInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow,
    OrchestrationDeleteCodeReviewWorkflowInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.retryWorkflow, OrchestrationRetryWorkflowInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow,
    OrchestrationRetryCodeReviewWorkflowInput,
  ),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.startImplementation,
    OrchestrationStartImplementationInput,
  ),

  // Project Search
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),
  tagRequestBody(WS_METHODS.projectsReadFile, ProjectReadFileInput),

  // Filesystem methods
  tagRequestBody(WS_METHODS.filesystemBrowse, FilesystemBrowseInput),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),

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

  // Terminal methods
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  tagRequestBody(WS_METHODS.terminalWrite, TerminalWriteInput),
  tagRequestBody(WS_METHODS.terminalResize, TerminalResizeInput),
  tagRequestBody(WS_METHODS.terminalClear, TerminalClearInput),
  tagRequestBody(WS_METHODS.terminalRestart, TerminalRestartInput),
  tagRequestBody(WS_METHODS.terminalClose, TerminalCloseInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverValidateHarnesses, ServerValidateHarnessesInput),
  tagRequestBody(WS_METHODS.serverUpsertKeybinding, KeybindingRule),
  tagRequestBody(WS_METHODS.mcpGetCommonConfig, McpGetCommonConfigRequest),
  tagRequestBody(WS_METHODS.mcpReplaceCommonConfig, McpReplaceCommonConfigRequest),
  tagRequestBody(WS_METHODS.mcpGetProjectConfig, McpGetProjectConfigRequest),
  tagRequestBody(WS_METHODS.mcpReplaceProjectConfig, McpReplaceProjectConfigRequest),
  tagRequestBody(WS_METHODS.mcpGetEffectiveConfig, McpGetEffectiveConfigRequest),
  tagRequestBody(WS_METHODS.mcpGetCodexStatus, McpGetCodexStatusRequest),
  tagRequestBody(WS_METHODS.mcpReloadProject, McpReloadProjectRequest),
  tagRequestBody(WS_METHODS.mcpApplyToLiveSessions, McpApplyToLiveSessionsRequest),
  tagRequestBody(WS_METHODS.mcpStartOAuthLogin, McpStartOauthLoginRequest),
  tagRequestBody(WS_METHODS.mcpGetOAuthStatus, McpOauthLoginStatusRequest),
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
  readonly [WS_CHANNELS.gitActionProgress]: typeof GitActionProgressEvent.Type;
  readonly [WS_CHANNELS.terminalEvent]: typeof TerminalEvent.Type;
  readonly [WS_CHANNELS.mcpStatusUpdated]: McpStatusUpdatedPayload;
  readonly [ORCHESTRATION_WS_CHANNELS.domainEvent]: OrchestrationEvent;
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
export const WsPushGitActionProgress = makeWsPushSchema(
  WS_CHANNELS.gitActionProgress,
  GitActionProgressEvent,
);
export const WsPushTerminalEvent = makeWsPushSchema(WS_CHANNELS.terminalEvent, TerminalEvent);
export const WsPushMcpStatusUpdated = makeWsPushSchema(
  WS_CHANNELS.mcpStatusUpdated,
  McpStatusUpdatedPayload,
);
export const WsPushOrchestrationDomainEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  OrchestrationEvent,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.gitActionProgress,
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.terminalEvent,
  WS_CHANNELS.mcpStatusUpdated,
  ORCHESTRATION_WS_CHANNELS.domainEvent,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushServerWelcome,
  WsPushServerConfigUpdated,
  WsPushGitActionProgress,
  WsPushTerminalEvent,
  WsPushMcpStatusUpdated,
  WsPushOrchestrationDomainEvent,
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
