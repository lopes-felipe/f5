import type {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInvalidatedPayload,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import type {
  ServerConfig,
  ServerHarnessValidationResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import type { ProviderStartOptions } from "./orchestration";
import type {
  McpApplyToLiveSessionsRequest,
  McpApplyToLiveSessionsResult,
  McpCodexStatusResult,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpGetCommonConfigRequest,
  McpGetLoginStatusRequest,
  McpGetProviderStatusRequest,
  McpGetCodexStatusRequest,
  McpGetEffectiveConfigRequest,
  McpGetProjectConfigRequest,
  McpGetServerStatusesRequest,
  McpLoginStatusResult,
  McpOauthLoginStatusRequest,
  McpOauthLoginStatusResult,
  McpProviderStatusResult,
  McpProjectConfigResult,
  McpReloadProjectRequest,
  McpReplaceCommonConfigRequest,
  McpReplaceProjectConfigRequest,
  McpServerStatusesResult,
  McpStartLoginRequest,
  McpStartOauthLoginRequest,
  McpStatusUpdatedPayload,
} from "./mcp";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type {
  OrchestrationArchiveCodeReviewWorkflowInput,
  OrchestrationArchiveWorkflowInput,
  ClientOrchestrationCommand,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationCreateCodeReviewWorkflowResult,
  OrchestrationCreateWorkflowInput,
  OrchestrationCreateWorkflowResult,
  OrchestrationDeleteCodeReviewWorkflowInput,
  OrchestrationDeleteWorkflowInput,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetStartupSnapshotInput,
  OrchestrationGetStartupSnapshotResult,
  OrchestrationGetThreadCommandExecutionInput,
  OrchestrationGetThreadCommandExecutionResult,
  OrchestrationGetThreadCommandExecutionsInput,
  OrchestrationGetThreadCommandExecutionsResult,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetThreadDetailsInput,
  OrchestrationGetThreadDetailsResult,
  OrchestrationGetThreadFileChangeInput,
  OrchestrationGetThreadFileChangeResult,
  OrchestrationGetThreadFileChangesInput,
  OrchestrationGetThreadFileChangesResult,
  OrchestrationGetThreadTailDetailsInput,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadTailDetails,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationRetryCodeReviewWorkflowInput,
  OrchestrationRetryWorkflowInput,
  OrchestrationStartImplementationInput,
  OrchestrationUnarchiveCodeReviewWorkflowInput,
  OrchestrationUnarchiveWorkflowInput,
} from "./orchestration";
import { EditorId } from "./editor";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getPathForFile?: (file: File) => string | null;
  resolveRealPath?: (pathValue: string) => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
    onActionProgress: (callback: (event: GitActionProgressEvent) => void) => () => void;
    onStatusInvalidated: (callback: (event: GitStatusInvalidatedPayload) => void) => () => void;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    validateHarnesses: (input?: {
      providerOptions?: ProviderStartOptions;
    }) => Promise<{ results: ReadonlyArray<ServerHarnessValidationResult> }>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
  };
  mcp: {
    getCommonConfig: (input: McpGetCommonConfigRequest) => Promise<McpCommonConfigResult>;
    replaceCommonConfig: (input: McpReplaceCommonConfigRequest) => Promise<McpCommonConfigResult>;
    getProjectConfig: (input: McpGetProjectConfigRequest) => Promise<McpProjectConfigResult>;
    replaceProjectConfig: (
      input: McpReplaceProjectConfigRequest,
    ) => Promise<McpProjectConfigResult>;
    getEffectiveConfig: (input: McpGetEffectiveConfigRequest) => Promise<McpEffectiveConfigResult>;
    getProviderStatus: (input: McpGetProviderStatusRequest) => Promise<McpProviderStatusResult>;
    getServerStatuses: (input: McpGetServerStatusesRequest) => Promise<McpServerStatusesResult>;
    startLogin: (input: McpStartLoginRequest) => Promise<McpLoginStatusResult>;
    getLoginStatus: (input: McpGetLoginStatusRequest) => Promise<McpLoginStatusResult>;
    getCodexStatus: (input: McpGetCodexStatusRequest) => Promise<McpCodexStatusResult>;
    reloadProject: (input: McpReloadProjectRequest) => Promise<McpCodexStatusResult>;
    applyToLiveSessions: (
      input: McpApplyToLiveSessionsRequest,
    ) => Promise<McpApplyToLiveSessionsResult>;
    startOAuthLogin: (input: McpStartOauthLoginRequest) => Promise<McpOauthLoginStatusResult>;
    getOAuthStatus: (input: McpOauthLoginStatusRequest) => Promise<McpOauthLoginStatusResult>;
    onStatusUpdated: (callback: (payload: McpStatusUpdatedPayload) => void) => () => void;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    getStartupSnapshot: (
      input?: OrchestrationGetStartupSnapshotInput,
    ) => Promise<OrchestrationGetStartupSnapshotResult>;
    getThreadTailDetails: (
      input: OrchestrationGetThreadTailDetailsInput,
    ) => Promise<OrchestrationThreadTailDetails>;
    getThreadHistoryPage: (
      input: OrchestrationGetThreadHistoryPageInput,
    ) => Promise<OrchestrationThreadHistoryPage>;
    getThreadDetails: (
      input: OrchestrationGetThreadDetailsInput,
    ) => Promise<OrchestrationGetThreadDetailsResult>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getThreadCommandExecutions: (
      input: OrchestrationGetThreadCommandExecutionsInput,
    ) => Promise<OrchestrationGetThreadCommandExecutionsResult>;
    getThreadCommandExecution: (
      input: OrchestrationGetThreadCommandExecutionInput,
    ) => Promise<OrchestrationGetThreadCommandExecutionResult>;
    getThreadFileChanges: (
      input: OrchestrationGetThreadFileChangesInput,
    ) => Promise<OrchestrationGetThreadFileChangesResult>;
    getThreadFileChange: (
      input: OrchestrationGetThreadFileChangeInput,
    ) => Promise<OrchestrationGetThreadFileChangeResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    createWorkflow: (
      input: OrchestrationCreateWorkflowInput,
    ) => Promise<OrchestrationCreateWorkflowResult>;
    archiveWorkflow: (input: OrchestrationArchiveWorkflowInput) => Promise<void>;
    unarchiveWorkflow: (input: OrchestrationUnarchiveWorkflowInput) => Promise<void>;
    createCodeReviewWorkflow: (
      input: OrchestrationCreateCodeReviewWorkflowInput,
    ) => Promise<OrchestrationCreateCodeReviewWorkflowResult>;
    archiveCodeReviewWorkflow: (
      input: OrchestrationArchiveCodeReviewWorkflowInput,
    ) => Promise<void>;
    unarchiveCodeReviewWorkflow: (
      input: OrchestrationUnarchiveCodeReviewWorkflowInput,
    ) => Promise<void>;
    deleteWorkflow: (input: OrchestrationDeleteWorkflowInput) => Promise<void>;
    deleteCodeReviewWorkflow: (input: OrchestrationDeleteCodeReviewWorkflowInput) => Promise<void>;
    retryWorkflow: (input: OrchestrationRetryWorkflowInput) => Promise<void>;
    retryCodeReviewWorkflow: (input: OrchestrationRetryCodeReviewWorkflowInput) => Promise<void>;
    startImplementation: (input: OrchestrationStartImplementationInput) => Promise<void>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
