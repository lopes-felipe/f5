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
  ProjectCancelContentSearchInput,
  ProjectCancelContentSearchResult,
  ProjectAuthorizeEntryInput,
  ProjectAuthorizeEntryResult,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import type {
  ServerConfig,
  ServerAddKeybindingInput,
  ServerHarnessValidationResult,
  ServerKeybindingMutationResult,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingInput,
  ServerResetKeybindingsInput,
  ServerUpdateKeybindingInput,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import type { ServerSettings, ServerSettingsPatch } from "./settings";
import type { ReviewPreviewDiffInput, ReviewPreviewDiffResult } from "./review";
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
  DiscoveredLocalServerList,
  PreviewAnnotationPayload,
  PreviewCloseInput,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewListLocalServersInput,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewRecordingMetricsInput,
  PreviewReportStatusInput,
  PreviewSessionSnapshot,
} from "./preview";
import type {
  PreviewAutomationClickInput,
  PreviewAutomationClearOwnerInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationOwner,
  PreviewAutomationRegistration,
  PreviewAutomationPressInput,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewArtifact,
  PreviewViewportSize,
} from "./previewAutomation";
import type {
  StorageCancelCleanupRequest,
  StorageCleanupProgressPayload,
  StorageCleanupRequest,
  StorageCleanupResult,
  StorageGetUsageRequest,
  StorageInvalidatedPayload,
  StorageUsageReport,
} from "./storage";
import type {
  NextTurnQueueCancelInput,
  NextTurnQueueClearInput,
  NextTurnQueueDuplicateInput,
  NextTurnQueueListInput,
  NextTurnQueueMutationResult,
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
  NextTurnQueueUpdateInput,
  TurnSubmissionResult,
} from "./nextTurnQueue";
import type { GlobalSearchQueryInput, GlobalSearchQueryResult } from "./globalSearch";
import type {
  WorkflowPlatformCreateRunInput,
  WorkflowPlatformCreateRunResult,
  WorkflowPlatformInspectRunInput,
  WorkflowPlatformInspectRunResult,
  WorkflowPlatformListTemplatesResult,
} from "./workflowPlatform";
import type {
  PrHubAdvisorySnapshot,
  PrHubAnalyzeAdvisoriesInput,
  PrHubClearDataInput,
  PrHubCommentInput,
  PrHubGetAdvisoriesInput,
  PrHubIgnoreInput,
  PrHubLocalCandidatesInput,
  PrHubLocalCheckoutCandidate,
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
import type {
  OrchestrationArchiveInvestigationWorkflowInput,
  OrchestrationArchiveCodeReviewWorkflowInput,
  OrchestrationArchiveWorkflowInput,
  ClientOrchestrationCommand,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationCreateCodeReviewWorkflowResult,
  OrchestrationCreateInvestigationWorkflowInput,
  OrchestrationCreateInvestigationWorkflowResult,
  OrchestrationCreateWorkflowInput,
  OrchestrationCreateWorkflowResult,
  OrchestrationDeleteCodeReviewWorkflowInput,
  OrchestrationDeleteInvestigationWorkflowInput,
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
  OrchestrationRetryInvestigationWorkflowInput,
  OrchestrationRetryWorkflowInput,
  OrchestrationRetryWorkflowResult,
  OrchestrationStartImplementationInput,
  OrchestrationUnarchiveInvestigationWorkflowInput,
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

export type DesktopPreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  viewport?: PreviewViewportSize;
  updatedAt: string;
}

export interface DesktopPreviewWebviewConfig {
  partition: string;
  webPreferences: string;
}

export interface DesktopPreviewRecordingStartResult {
  recordingId: string;
  tabId: string;
  startedAt: string;
}

export interface DesktopPreviewRecordingFrame {
  recordingId: string;
  tabId: string;
  data: string;
  width: number;
  height: number;
}

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

export interface DesktopImageDownloadResult {
  savedPath: string;
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
  copyImage?: (pngBytes: Uint8Array) => Promise<void>;
  downloadImage?: (bytes: Uint8Array, filename: string) => Promise<DesktopImageDownloadResult>;
  openExternal: (url: string) => Promise<boolean>;
  openThreadInNewWindow?: (threadId: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  preview?: DesktopPreviewBridge;
}

export interface DesktopPreviewBridge {
  getPreviewConfig: () => Promise<DesktopPreviewWebviewConfig>;
  createTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  hardReload: (tabId: string) => Promise<void>;
  openDevTools: (tabId: string) => Promise<void>;
  pickElement: (tabId: string) => Promise<PreviewAnnotationPayload | null>;
  cancelPickElement: (tabId: string) => Promise<void>;
  setViewport: (tabId: string, viewport: PreviewViewportSize) => Promise<boolean>;
  captureScreenshot: (tabId: string) => Promise<PreviewArtifact>;
  recording?: {
    start: (tabId: string) => Promise<DesktopPreviewRecordingStartResult>;
    appendChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<void>;
    stop: (recordingId: string) => Promise<PreviewArtifact>;
    discard: (recordingId: string) => Promise<void>;
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  automation?: {
    status: (tabId: string) => Promise<PreviewAutomationStatus>;
    snapshot: (tabId: string) => Promise<PreviewAutomationSnapshot>;
    click: (tabId: string, input: PreviewAutomationClickInput) => Promise<void>;
    type: (tabId: string, input: PreviewAutomationTypeInput) => Promise<void>;
    press: (tabId: string, input: PreviewAutomationPressInput) => Promise<void>;
    scroll: (tabId: string, input: PreviewAutomationScrollInput) => Promise<void>;
    evaluate: (tabId: string, input: PreviewAutomationEvaluateInput) => Promise<unknown>;
    waitFor: (tabId: string, input: PreviewAutomationWaitForInput) => Promise<void>;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
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
  preview: {
    open: (input: PreviewOpenInput) => Promise<PreviewSessionSnapshot>;
    navigate: (input: PreviewNavigateInput) => Promise<PreviewSessionSnapshot>;
    reportStatus: (input: PreviewReportStatusInput) => Promise<void>;
    reportRecordingMetrics: (input: PreviewRecordingMetricsInput) => Promise<void>;
    refresh: (input: PreviewRefreshInput) => Promise<void>;
    close: (input: PreviewCloseInput) => Promise<void>;
    list: (input: PreviewListInput) => Promise<PreviewListResult>;
    listLocalServers: (input?: PreviewListLocalServersInput) => Promise<DiscoveredLocalServerList>;
    automation: {
      respond: (response: PreviewAutomationResponse) => Promise<void>;
      reportOwner: (owner: PreviewAutomationOwner) => Promise<PreviewAutomationRegistration>;
      clearOwner: (input: PreviewAutomationClearOwnerInput) => Promise<void>;
      onRequest: (callback: (request: PreviewAutomationRequest) => void) => () => void;
    };
    onEvent: (callback: (event: PreviewEvent) => void) => () => void;
    onLocalServersUpdated: (callback: (event: DiscoveredLocalServerList) => void) => () => void;
  };
  projects: {
    authorizeEntry: (input: ProjectAuthorizeEntryInput) => Promise<ProjectAuthorizeEntryResult>;
    listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    searchContents: (input: ProjectSearchContentsInput) => Promise<ProjectSearchContentsResult>;
    cancelContentSearch: (
      input: ProjectCancelContentSearchInput,
    ) => Promise<ProjectCancelContentSearchResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    revealInFileManager: (path: string) => Promise<void>;
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
  review: {
    previewDiff: (input: ReviewPreviewDiffInput) => Promise<ReviewPreviewDiffResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    updateSettings: (input: ServerSettingsPatch) => Promise<ServerSettings>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    validateHarnesses: (input?: {
      providerOptions?: ProviderStartOptions;
    }) => Promise<{ results: ReadonlyArray<ServerHarnessValidationResult> }>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    addKeybinding: (input: ServerAddKeybindingInput) => Promise<ServerKeybindingMutationResult>;
    updateKeybinding: (
      input: ServerUpdateKeybindingInput,
    ) => Promise<ServerKeybindingMutationResult>;
    removeKeybinding: (
      input: ServerRemoveKeybindingInput,
    ) => Promise<ServerKeybindingMutationResult>;
    resetKeybindings: (
      input?: ServerResetKeybindingsInput,
    ) => Promise<ServerKeybindingMutationResult>;
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
  storage: {
    getUsage: (input?: StorageGetUsageRequest) => Promise<StorageUsageReport>;
    cleanup: (input: StorageCleanupRequest) => Promise<StorageCleanupResult>;
    cancelCleanup: (input: StorageCancelCleanupRequest) => Promise<void>;
    onInvalidated: (callback: (payload: StorageInvalidatedPayload) => void) => () => void;
    onCleanupProgress: (callback: (payload: StorageCleanupProgressPayload) => void) => () => void;
  };
  nextTurnQueue: {
    list: (input: NextTurnQueueListInput) => Promise<NextTurnQueueSnapshot>;
    submit: (input: NextTurnQueueSubmitInput) => Promise<TurnSubmissionResult>;
    summary: () => Promise<NextTurnQueueSummary>;
    update: (input: NextTurnQueueUpdateInput) => Promise<NextTurnQueueSnapshot>;
    cancel: (input: NextTurnQueueCancelInput) => Promise<NextTurnQueueMutationResult>;
    reorder: (input: NextTurnQueueReorderInput) => Promise<NextTurnQueueSnapshot>;
    retry: (input: NextTurnQueueRetryInput) => Promise<NextTurnQueueSnapshot>;
    promote: (input: NextTurnQueuePromoteInput) => Promise<NextTurnQueueSnapshot>;
    setPaused: (input: NextTurnQueueSetPausedInput) => Promise<NextTurnQueueSnapshot>;
    duplicate: (input: NextTurnQueueDuplicateInput) => Promise<NextTurnQueueSnapshot>;
    refreshGate: (input: NextTurnQueueRefreshGateInput) => Promise<NextTurnQueueSnapshot>;
    clear: (input: NextTurnQueueClearInput) => Promise<NextTurnQueueMutationResult>;
    restore: (input: NextTurnQueueRestoreInput) => Promise<NextTurnQueueMutationResult>;
    recheckDelivery: (input: NextTurnQueueRecheckDeliveryInput) => Promise<NextTurnQueueSnapshot>;
    retryDelivery: (input: NextTurnQueueRetryDeliveryInput) => Promise<NextTurnQueueSnapshot>;
    discardDelivery: (input: NextTurnQueueDiscardDeliveryInput) => Promise<NextTurnQueueSnapshot>;
    onUpdated: (callback: (payload: NextTurnQueueSnapshot) => void) => () => void;
    onSummaryUpdated: (callback: (payload: NextTurnQueueSummary) => void) => () => void;
  };
  globalSearch: {
    query: (input: GlobalSearchQueryInput) => Promise<GlobalSearchQueryResult>;
  };
  workflowPlatform: {
    listTemplates: () => Promise<WorkflowPlatformListTemplatesResult>;
    createRun: (input: WorkflowPlatformCreateRunInput) => Promise<WorkflowPlatformCreateRunResult>;
    inspectRun: (
      input: WorkflowPlatformInspectRunInput,
    ) => Promise<WorkflowPlatformInspectRunResult>;
  };
  prHub: {
    getSnapshot: () => Promise<PrHubSnapshot>;
    refresh: (input: PrHubRefreshInput) => Promise<PrHubSnapshot>;
    approve: (input: PrHubReviewInput) => Promise<PrHubSnapshot>;
    requestChanges: (input: PrHubRequestChangesInput) => Promise<PrHubSnapshot>;
    comment: (input: PrHubCommentInput) => Promise<PrHubSnapshot>;
    merge: (input: PrHubMergeInput) => Promise<PrHubSnapshot>;
    markReady: (input: PrHubMarkReadyInput) => Promise<PrHubSnapshot>;
    reRequestReview: (input: PrHubReRequestInput) => Promise<PrHubSnapshot>;
    snooze: (input: PrHubSnoozeInput) => Promise<PrHubSnapshot>;
    unsnooze: (input: PrHubUnsnoozeInput) => Promise<PrHubSnapshot>;
    ignore: (input: PrHubIgnoreInput) => Promise<PrHubSnapshot>;
    markSeen: (input: PrHubMarkSeenInput) => Promise<PrHubSnapshot>;
    markNotified: (input: PrHubMarkNotifiedInput) => Promise<PrHubSnapshot>;
    analyzeAdvisories: (input?: PrHubAnalyzeAdvisoriesInput) => Promise<PrHubAdvisorySnapshot>;
    getAdvisories: (input?: PrHubGetAdvisoriesInput) => Promise<PrHubAdvisorySnapshot>;
    listLocalCheckoutCandidates: (
      input: PrHubLocalCandidatesInput,
    ) => Promise<PrHubLocalCheckoutCandidate[]>;
    clearData: (input?: PrHubClearDataInput) => Promise<PrHubSnapshot>;
    onSnapshotUpdated: (callback: (snapshot: PrHubSnapshot) => void) => () => void;
    onAdvisoriesUpdated: (callback: (snapshot: PrHubAdvisorySnapshot) => void) => () => void;
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
    createWorkflow: (
      input: OrchestrationCreateWorkflowInput,
    ) => Promise<OrchestrationCreateWorkflowResult>;
    archiveWorkflow: (input: OrchestrationArchiveWorkflowInput) => Promise<void>;
    unarchiveWorkflow: (input: OrchestrationUnarchiveWorkflowInput) => Promise<void>;
    createCodeReviewWorkflow: (
      input: OrchestrationCreateCodeReviewWorkflowInput,
    ) => Promise<OrchestrationCreateCodeReviewWorkflowResult>;
    createInvestigationWorkflow: (
      input: OrchestrationCreateInvestigationWorkflowInput,
    ) => Promise<OrchestrationCreateInvestigationWorkflowResult>;
    archiveCodeReviewWorkflow: (
      input: OrchestrationArchiveCodeReviewWorkflowInput,
    ) => Promise<void>;
    archiveInvestigationWorkflow: (
      input: OrchestrationArchiveInvestigationWorkflowInput,
    ) => Promise<void>;
    unarchiveCodeReviewWorkflow: (
      input: OrchestrationUnarchiveCodeReviewWorkflowInput,
    ) => Promise<void>;
    unarchiveInvestigationWorkflow: (
      input: OrchestrationUnarchiveInvestigationWorkflowInput,
    ) => Promise<void>;
    deleteWorkflow: (input: OrchestrationDeleteWorkflowInput) => Promise<void>;
    deleteCodeReviewWorkflow: (input: OrchestrationDeleteCodeReviewWorkflowInput) => Promise<void>;
    deleteInvestigationWorkflow: (
      input: OrchestrationDeleteInvestigationWorkflowInput,
    ) => Promise<void>;
    retryWorkflow: (
      input: OrchestrationRetryWorkflowInput,
    ) => Promise<OrchestrationRetryWorkflowResult>;
    retryCodeReviewWorkflow: (input: OrchestrationRetryCodeReviewWorkflowInput) => Promise<void>;
    retryInvestigationWorkflow: (
      input: OrchestrationRetryInvestigationWorkflowInput,
    ) => Promise<void>;
    startImplementation: (input: OrchestrationStartImplementationInput) => Promise<void>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
