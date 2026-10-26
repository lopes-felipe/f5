import type { ThreadSearchInput, ThreadSearchResult } from "./threadSearch";
import type {
  McpAppCallToolInput,
  McpAppReadResourceInput,
  McpAppToolInfoInput,
  McpAppToolInfo,
  McpAppToolResult,
  McpAppUpdateModelContextInput,
} from "./mcpApps";
import type {
  PullRequestWatchEntry,
  PullRequestWatchInput,
  PullRequestWatchChanged,
} from "./pullRequestWatch";
import type {
  HtmlPreviewRequest,
  HtmlPreviewHostRequest,
  HtmlPreviewResult,
  HtmlPreviewResponse,
} from "./threadTools";
import type { ReportClientDiagnosticsInput } from "./server";
import type {
  WorktreesMoveThreadInput,
  WorktreesMoveThreadResult,
  WorktreesDiscardMovedChangesInput,
  WorktreesDiscardMovedChangesResult,
  WorktreesSwitchWorkspaceInput,
  WorktreesGetTransitionInput,
  WorktreesPreviewTransitionRecoveryInput,
  WorktreesResolveTransitionInput,
  WorkspaceTransitionSnapshot,
  WorkspaceTransitionRecoveryPreview,
  WorktreesListInput,
  WorktreesListResult,
  WorktreesInspectInput,
  WorktreesInspectResult,
  WorktreesRemoveInput,
  WorktreesRemoveResult,
  WorktreesThreadStateInput,
  WorktreesThreadStateResult,
  WorktreesRecoverInput,
  WorktreesRecoverResult,
} from "./worktrees";
import type {
  ComputerAccessPush,
  ComputerAccessSettled,
  ComputerGrantsChanged,
  AgentComputerUseChanged,
} from "./ws";
import type {
  ComputerGrant,
  ComputerActivity,
  ChromeNativeHostTransactionSummary,
  ChromeNativeHostRestoreResult,
  ChromeReadiness,
} from "./computerAutomation";
import type {
  NativeOperationInput,
  NativeOperationResolutionInput,
  NativeHistoryRecoveryInput,
  NativeHistoryRecovery,
  NativeOperationInspectInput,
  NativeOperationRecord,
  NativeForkInput,
} from "./nativeOperation";
import type { ThreadId } from "./baseSchemas";
import type {
  AgentBridgeCreateTaskInput,
  AgentBridgeGetTaskActivitiesInput,
  AgentBridgeGetTaskActivitiesResult,
  AgentBridgeGetTasksInput,
  AgentBridgeGetTasksResult,
  AgentBridgeReplyToTaskInput,
  AgentBridgeState,
  AgentBridgeStateChanged,
  AgentBridgeTaskControlInput,
  BotTask,
} from "./agentBridge";
import type { DesktopComputerAutomationBridge } from "./computerAutomation";
import type {
  UpstreamAcceptSuggestionsInput,
  UpstreamDecideInput,
  UpstreamDecideResult,
  UpstreamGetPortPromptInput,
  UpstreamGetPortPromptResult,
  UpstreamGetTopicInput,
  UpstreamListTopicsInput,
  UpstreamListTopicsResult,
  UpstreamOverview,
  UpstreamPortsChanged,
  UpstreamPortsListProjectsResult,
  UpstreamPortsProjectInput,
  UpstreamResolvePublicationInput,
  UpstreamRevisionResult,
  UpstreamRunInput,
  UpstreamRunResult,
  UpstreamStartPortInput,
  UpstreamStartPortResult,
  UpstreamTopicDetail,
  UpstreamUnlinkPortInput,
} from "./upstreamPorts";
import type { PullRequestKey } from "./prHub";
import type {
  ForgeAccount,
  ForgeAccountInput,
  ForgeAccountRouting,
  PrHubPeek,
  PrHubPeekInput,
  PrHubStack,
  PrHubStackInput,
  PrHubViewedFilesInput,
  PrHubSetViewedFileInput,
  ForgePrepareOperationInput,
  ForgeOperationInput,
  ForgeOperation,
} from "./prHubExtensions";
import type { ThreadPullRequestLink } from "./orchestration";
import type {
  AttachmentUpload,
  AttachmentUploadsInput,
  AttachmentCloneToUploadInput,
} from "./attachmentUpload";
import type { ProjectId } from "./baseSchemas";
import type {
  ProfileId,
  ProfileSummary,
  ProfileCreateInput,
  ProfileUpdateInput,
  ProfileListResult,
} from "./profile";
import type {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitPrepareWorktreeInput,
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
  ProjectCloneInput,
  ProjectCloneCancelInput,
  ProjectCloneJob,
  ProjectEnsureScratchResult,
  ProjectCreateNewInput,
  ProjectCreateNewResult,
  ProjectFindByRepositoryInput,
  ProjectFindByRepositoryResult,
  ProjectListDirectoryInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectSetWatchedPathsInput,
  ProjectSetWatchedPathsResult,
  ProjectWatchedPathsChangedPayload,
  ProjectIssueAssetUrlInput,
  ProjectOpenHtmlPreviewInput,
  ProjectIssueAssetUrlResult,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  ProjectCheckedInConfig,
  ProjectGetCheckedInConfigInput,
} from "./checkedInProjectFile";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import type {
  ProviderInstanceInventory,
  ServerGetProviderInventoryInput,
} from "./providerInventory";
import type {
  ServerConfig,
  ServerAddKeybindingInput,
  ServerHarnessValidationResult,
  ServerKeybindingMutationResult,
  ServerProviderUpdatedPayload,
  ServerCheckProviderUpdatesInput,
  ServerRunProviderUpdateInput,
  ServerRunProviderUpdateResult,
  ServerRemoveKeybindingInput,
  ServerResetKeybindingsInput,
  ServerUpdateKeybindingInput,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import type {
  MigrateClientSettingInput,
  MigrateClientSettingResult,
  ProjectSettingsResult,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings";
import type { ReviewPreviewDiffInput, ReviewPreviewDiffResult } from "./review";
import type {
  UsageConsumeResetCreditInput,
  UsageConsumeResetCreditResult,
  UsageGetAccountsInput,
  UsageAccounts,
  UsageGetSummaryInput,
  UsageSummary,
  UsageQuotaHistory,
} from "./usage";
import type { ElicitationSubmitInput, ElicitationSubmitResult } from "./elicitation";
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
  McpListImportCandidatesRequest,
  McpProbeServerRequest,
  McpStoreSecretRequest,
  McpInspectServerRequest,
  McpListImportCandidatesResult,
  McpProbeServerResult,
  McpStoreSecretResult,
  McpInspectServerResult,
  McpReconnectServerRequest,
  McpReconnectServerResult,
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
  TerminalSnapshotInput,
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
  PreviewAutomationActionGeometry,
  PreviewAutomationOwnerReleased,
  PreviewAutomationOwnerRequested,
  PreviewAutomationPauseChanged,
  PreviewAutomationSetPausedInput,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewArtifact,
  PreviewViewportSize,
} from "./previewAutomation";
import type {
  StorageAutomationAuditInput,
  StorageAutomationAuditResult,
  StorageAutomationDryRunResult,
  StorageCancelCleanupRequest,
  StorageStatus,
  StorageCleanupStatus,
  StorageGetUsageResult,
  StorageGetTargetsRequest,
  StorageGetTargetsResult,
  StorageGetOperationRequest,
  StorageGetOperationResult,
  StorageCleanupRequest,
  StorageGetDiskSpaceRequest,
  StorageGetUsageRequest,
  StorageInvalidatedPayload,
  DiskSpaceStatus,
} from "./storage";
import type {
  NextTurnQueueCancelInput,
  NextTurnQueueClearInput,
  NextTurnQueueDuplicateInput,
  NextTurnQueueListInput,
  NextTurnQueueMutationResult,
  NextTurnQueuePromoteInput,
  NextTurnQueueSteerInput,
  NextTurnQueueRefreshGateInput,
  NextTurnQueueReorderInput,
  NextTurnQueueRestoreInput,
  NextTurnQueueRecheckDeliveryInput,
  NextTurnQueueRetryDeliveryInput,
  NextTurnQueueDiscardDeliveryInput,
  NextTurnQueueRetryInput,
  NextTurnQueueSetPausedInput,
  NextTurnQueueScheduleUsageLimitResumeInput,
  NextTurnQueueCancelUsageLimitResumeInput,
  NextTurnQueueRefreshUsageLimitResumeInput,
  NextTurnQueueSnapshot,
  NextTurnQueueSubmitInput,
  NextTurnQueueSummary,
  NextTurnQueueUpdateInput,
  TurnSubmissionResult,
} from "./nextTurnQueue";
import type {
  WorktreeSetupActionInput,
  WorktreeSetupActionResult,
  WorktreeSetupSubscribeResult,
  WorktreeSetupThreadInput,
  WorktreeSetupUpdatedPayload,
} from "./worktreeSetup";
import type { GlobalSearchQueryInput, GlobalSearchQueryResult } from "./globalSearch";
import type {
  AgentsDismissInput,
  AgentsDismissResult,
  AgentsGetSnapshotInput,
  AgentsSnapshot,
} from "./backgroundWork";
import type {
  WorkflowPlatformCreateRunInput,
  WorkflowPlatformCreateRunResult,
  WorkflowPlatformInspectRunInput,
  WorkflowPlatformInspectRunResult,
  WorkflowPlatformListTemplatesResult,
} from "./workflowPlatform";
import type {
  PrHubAdvisorySnapshot,
  PrHubAdvisoriesChanged,
  PrHubAnalyzeAdvisoriesInput,
  PrHubClearDataInput,
  PrHubChangeReviewersInput,
  PrHubCommentInput,
  PrHubClaimNotificationsInput,
  PrHubAcknowledgeNotificationsInput,
  PrHubNotificationBatch,
  PrHubDetailInput,
  PrHubDetailMutationResult,
  PrHubDetailResult,
  PrHubFilesInput,
  PrHubFilesPage,
  PrHubThreadsInput,
  PrHubReplyInput,
  PrHubRecoverReplyInput,
  PrHubReplyDraft,
  PrHubReplyDraftResult,
  PrHubSaveReplyDraftInput,
  PrHubReplyOperation,
  PrHubThreadsPage,
  PrHubThreadStateInput,
  PrHubReviewThread,
  PrHubSaveReviewDraftInput,
  PrHubPrepareReviewInput,
  PrHubPrepareQuickReviewInput,
  PrHubPrepareCommentInput,
  PrHubCommentOperationInput,
  PrHubCommentReadInput,
  PrHubRecoverCommentInput,
  PrHubCommentOperation,
  PrHubReviewOperationInput,
  PrHubRecoverReviewInput,
  PrHubReviewOperation,
  PrHubReviewDraftResult,
  PrHubUnresolvedThreadsResult,
  PrHubGetAdvisoriesInput,
  PrHubReviewGuideInput,
  PullRequestReviewGuideResult,
  PrHubIgnoreInput,
  PrHubLocalCandidatesInput,
  PrHubResolveCheckoutInput,
  PrHubLocalCheckoutCandidate,
  PrHubResolvedCheckout,
  PrHubMarkNotifiedInput,
  PrHubMarkReadyInput,
  PrHubMarkSeenInput,
  PrHubAcknowledgeAttentionInput,
  PrHubMergeInput,
  PrHubRefreshInput,
  PrHubRequestChangesInput,
  PrHubReRequestInput,
  PrHubReviewInput,
  PrHubTrackInput,
  TrackedPullRequest,
  PrHubOverview,
  PrHubOverviewInput,
  PrHubListInput,
  PrHubListPage,
  PrHubChanged,
  PrHubSetReactionInput,
  PrHubSnoozeInput,
  PrHubTimelineInput,
  PrHubTimelinePage,
  PrHubUnsnoozeInput,
  PrHubUpdateBranchInput,
  PrHubUpdateCommentInput,
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
  OrchestrationGetLatestSequenceResult,
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
  OrchestrationGetRewindDraftsInput,
  OrchestrationGetRewindDraftsResult,
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
  ProviderStartOptions,
  OrchestrationSkipDocumentReaderPassInput,
  OrchestrationSkipDocumentReaderPassResult,
} from "./orchestration";
import { EditorId, type RevealInFileManagerInput } from "./editor";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export type DesktopUpdateChannel = "stable" | "beta";

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "preparing"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopPreviewColorScheme = "system" | "light" | "dark";

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
  muted?: boolean;
  colorScheme: DesktopPreviewColorScheme;
  faviconDataUrl?: string | null;
  viewport?: PreviewViewportSize;
  updatedAt: string;
}

export interface DesktopBrowserProfile {
  selected?: boolean;
  id: string;
  name: string;
  persistent: boolean;
}
export interface DesktopBrowserImportSource {
  id: string;
  name: string;
  profiles: Array<{ id: string; name: string }>;
  available: boolean;
  remediation?: string;
}
export interface DesktopBrowserImportProgress {
  id: string;
  status: "reading" | "writing" | "completed" | "canceled" | "failed";
  imported: number;
  skipped: number;
  failed: number;
  profileId?: string;
  error?: string;
}
export interface DesktopSnapShotResult {
  image: { name: string; mimeType: string; bytes: Uint8Array };
  context: { name: string; mimeType: string; bytes: Uint8Array };
}
export interface DesktopPreviewWebviewConfig {
  partition: string;
  webPreferences: string;
  preload?: string;
  profileId?: string;
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
  channel: DesktopUpdateChannel;
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  /** Sanitized plain-text notes supplied by the update provider. */
  releaseNotes?: string | null;
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

export type QuitShortcutMode = "hold" | "double-click" | "direct";
export type QuitShortcutHintEvent =
  | { state: "up" }
  | { state: "down"; mode: Exclude<QuitShortcutMode, "direct"> };

export interface DesktopCliCommandState {
  readonly supported: boolean;
  readonly installedPaths: Readonly<Record<"f5" | "t3", string | null>>;
  readonly onPath: boolean;
  readonly shadowedBy?: string;
}

export interface DesktopBridge {
  htmlPreview?: (input: HtmlPreviewRequest) => Promise<HtmlPreviewResult>;
  cliCommand?: {
    state: () => Promise<DesktopCliCommandState>;
    install: () => Promise<DesktopCliCommandState>;
  };
  /** F5-native computer control; reports why it is unavailable until certified. */
  computerAutomation?: DesktopComputerAutomationBridge;
  setQuitShortcutMode?: (mode: QuitShortcutMode) => Promise<void>;
  onQuitShortcut?: (listener: (event: QuitShortcutHintEvent) => void) => () => void;
  setAttentionBadge?: (count: number) => Promise<void>;
  getSystemLocale?: () => string | null;
  getProfileId?: () => string | null;
  switchProfile?: (profileId: string) => Promise<boolean>;
  stopProfile?: (profileId: string) => Promise<boolean>;
  onProfilesChanged?: (listener: () => void) => () => void;
  /** Takes the prompt links the OS opened F5 with, oldest first. */
  takePromptLinks?: () => Promise<{
    readonly links: readonly string[];
    /** The profile the links opened in, when there is more than one to choose from. */
    readonly profileName: string | null;
  }>;
  onPromptLinksAvailable?: (listener: () => void) => () => void;
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
  readClipboardText?: (source: "clipboard" | "selection") => Promise<string>;
  copyImage?: (pngBytes: Uint8Array) => Promise<void>;
  downloadImage?: (bytes: Uint8Array, filename: string) => Promise<DesktopImageDownloadResult>;
  openExternal: (url: string) => Promise<boolean>;
  openThreadInNewWindow?: (threadId: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  checkForUpdates?: () => Promise<DesktopUpdateActionResult>;
  setUpdateChannel?: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateActionResult>;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  snapShot?: {
    permissions: () => Promise<{ supported: boolean; screen: boolean; accessibility: boolean }>;
    capture: () => Promise<DesktopSnapShotResult>;
    configure: (shortcut: string, enabled: boolean) => Promise<void>;
    openPermissions: () => Promise<void>;
    onCapture: (listener: (result: DesktopSnapShotResult) => void) => () => void;
  };
  preview?: DesktopPreviewBridge;
}

export interface DesktopPreviewBridge {
  getPreviewConfig: () => Promise<DesktopPreviewWebviewConfig>;
  profiles?: {
    list: () => Promise<DesktopBrowserProfile[]>;
    create: (name: string, persistent: boolean) => Promise<DesktopBrowserProfile>;
    select: (id: string) => Promise<void>;
    delete: (id: string) => Promise<void>;
  };
  browserImport?: {
    openPermissions?: () => Promise<void>;
    sources: () => Promise<DesktopBrowserImportSource[]>;
    start: (source: string, profile: string, name: string) => Promise<string>;
    cancel: (id: string) => Promise<void>;
    status: (id: string) => Promise<DesktopBrowserImportProgress>;
  };
  setLinkOpenTarget?: (target: "system" | "preview") => Promise<void>;
  onOpenLink?: (listener: (url: string) => void) => () => void;
  setMuted?: (tabId: string, muted: boolean) => Promise<void>;
  setZoom?: (tabId: string, factor: number) => Promise<void>;
  createTab: (
    tabId: string,
    defaults?: { zoomFactor: number; muted: boolean },
  ) => Promise<DesktopPreviewWebviewConfig | void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  /** `agent: true` keeps agent provenance on the navigation's redirects (see agent-browser.md). */
  navigate: (tabId: string, url: string, options?: { readonly agent?: boolean }) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  hardReload: (tabId: string) => Promise<void>;
  openDevTools: (tabId: string) => Promise<void>;
  pickElement: (tabId: string) => Promise<PreviewAnnotationPayload | null>;
  cancelPickElement: (tabId: string) => Promise<void>;
  setViewport: (tabId: string, viewport: PreviewViewportSize | null) => Promise<boolean>;
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<boolean>;
  captureScreenshot: (tabId: string) => Promise<PreviewArtifact>;
  /** Screenshot and recording retention in days; null restores the default. */
  setArtifactRetention?: (days: number | null) => Promise<void>;
  recording?: {
    start: (tabId: string) => Promise<DesktopPreviewRecordingStartResult>;
    appendChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<void>;
    stop: (recordingId: string) => Promise<PreviewArtifact>;
    discard: (recordingId: string) => Promise<void>;
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  automation?: {
    status: (tabId: string) => Promise<PreviewAutomationStatus>;
    snapshot: (tabId: string, save?: boolean) => Promise<PreviewAutomationSnapshot>;
    click: (
      tabId: string,
      input: PreviewAutomationClickInput,
    ) => Promise<PreviewAutomationActionGeometry | void>;
    type: (
      tabId: string,
      input: PreviewAutomationTypeInput,
    ) => Promise<PreviewAutomationActionGeometry | void>;
    press: (tabId: string, input: PreviewAutomationPressInput) => Promise<void>;
    scroll: (tabId: string, input: PreviewAutomationScrollInput) => Promise<void>;
    evaluate: (tabId: string, input: PreviewAutomationEvaluateInput) => Promise<unknown>;
    waitFor: (tabId: string, input: PreviewAutomationWaitForInput) => Promise<void>;
    /** Interrupts the running and queued agent actions on the tab (user take-over). */
    cancel?: (tabId: string) => Promise<void>;
    /** External sites this tab may load besides loopback; malformed lists are rejected. */
    setNavigationPolicy?: (tabId: string, externalHosts: ReadonlyArray<string>) => Promise<boolean>;
    /** Small JPEG data URL for the live agent card, or null when unavailable. */
    captureThumbnail?: (tabId: string) => Promise<string | null>;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
}

import type * as Scheduled from "./scheduledTasks";

export interface NativeApi {
  scheduledTasks: {
    list: (
      input: (typeof Scheduled.ScheduledTaskListInput)["Type"],
    ) => Promise<(typeof Scheduled.ScheduledTaskListResult)["Type"]>;
    get: (
      input: (typeof Scheduled.ScheduledTaskGetInput)["Type"],
    ) => Promise<(typeof Scheduled.ScheduledTaskListResult)["Type"]["tasks"][number]>;
    create: (
      input: (typeof Scheduled.ScheduledTaskCreateInput)["Type"],
    ) => Promise<(typeof Scheduled.ScheduledTaskSaveResult)["Type"]>;
    update: (
      input: (typeof Scheduled.ScheduledTaskUpdateInput)["Type"],
    ) => Promise<(typeof Scheduled.ScheduledTaskSaveResult)["Type"]>;
    delete: (input: (typeof Scheduled.ScheduledTaskVersionInput)["Type"]) => Promise<void>;
    setEnabled: (
      input: (typeof Scheduled.ScheduledTaskEnabledInput)["Type"],
    ) => Promise<Scheduled.ScheduledTask>;
    runNow: (
      input: (typeof Scheduled.ScheduledTaskRunNowInput)["Type"],
    ) => Promise<Scheduled.ScheduledTaskRun>;
    listRuns: (
      input: (typeof Scheduled.ScheduledTaskRunsInput)["Type"],
    ) => Promise<(typeof Scheduled.ScheduledTaskRunsResult)["Type"]>;
    previewSchedule: (
      input: (typeof Scheduled.SchedulePreviewInput)["Type"],
    ) => Promise<Scheduled.SchedulePreview>;
    resolveRun: (
      input: (typeof Scheduled.ScheduledResolveInput)["Type"],
    ) => Promise<Scheduled.ScheduledTaskRun>;
    claimNotifications: (
      input: (typeof Scheduled.ScheduledClaimInput)["Type"],
    ) => Promise<(typeof Scheduled.ScheduledNotificationBatch)["Type"]>;
    acknowledgeNotifications: (
      input: (typeof Scheduled.ScheduledAckInput)["Type"],
    ) => Promise<void>;
    onChanged: (callback: (payload: Scheduled.ScheduledTasksChanged) => void) => () => void;
  };
  mcpApps: {
    toolInfo: (input: McpAppToolInfoInput) => Promise<McpAppToolInfo>;
    callTool: (input: McpAppCallToolInput) => Promise<McpAppToolResult>;
    readResource: (input: McpAppReadResourceInput) => Promise<unknown>;
    updateModelContext: (input: McpAppUpdateModelContextInput) => Promise<void>;
  };
  threadSettlement: {
    settleProjectIdle: (input: { projectId: ProjectId }) => Promise<{ settled: number }>;
  };
  pullRequestWatches: {
    list: (input: { threadId: ThreadId }) => Promise<ReadonlyArray<PullRequestWatchEntry>>;
    start: (input: PullRequestWatchInput) => Promise<PullRequestWatchEntry>;
    stop: (input: PullRequestWatchInput) => Promise<void>;
    onChanged: (callback: (input: typeof PullRequestWatchChanged.Type) => void) => () => void;
  };
  htmlRender: {
    setHost: (input: { available: boolean }) => Promise<void>;
    respond: (input: HtmlPreviewResponse) => Promise<void>;
    onRequest: (callback: (input: HtmlPreviewHostRequest) => void) => () => void;
  };
  chrome?: {
    listTransactions: (
      provider: "claude" | "codex",
    ) => Promise<ReadonlyArray<ChromeNativeHostTransactionSummary>>;
    restoreNativeHost: (
      provider: "claude" | "codex",
      transactionId: string,
    ) => Promise<ChromeNativeHostRestoreResult>;
    /** Read-only preflight for one provider instance: never spawns or writes. */
    getReadiness: (input: { providerInstanceId: string }) => Promise<ChromeReadiness>;
  };
  computer?: {
    access: {
      revoke: (input: { threadId: ThreadId; appId: string }) => Promise<void>;
      list: (input: { threadId: ThreadId }) => Promise<ReadonlyArray<ComputerGrant>>;
      listRemembered: (input: { projectId: ProjectId }) => Promise<ReadonlyArray<ComputerGrant>>;
      forgetRemembered: (input: { projectId: ProjectId; appId: string }) => Promise<void>;
      onRequested: (listener: (event: typeof ComputerAccessPush.Type) => void) => () => void;
      onSettled: (listener: (event: typeof ComputerAccessSettled.Type) => void) => () => void;
      onGrantsChanged: (listener: (event: typeof ComputerGrantsChanged.Type) => void) => () => void;
    };
    onObservationsInvalidated: (listener: (event: { threadId: string }) => void) => () => void;
    onActivity: (listener: (event: ComputerActivity) => void) => () => void;
    onLeaseChanged: (listener: (event: typeof AgentComputerUseChanged.Type) => void) => () => void;
  };

  attachments: {
    getUploads: (input: AttachmentUploadsInput) => Promise<Array<AttachmentUpload | null>>;
    releaseUploads: (input: AttachmentUploadsInput) => Promise<{}>;
    cloneToUpload: (input: AttachmentCloneToUploadInput) => Promise<AttachmentUpload>;
  };
  profiles?: {
    githubLoginStart: () => Promise<import("./profile").GithubLoginStatus>;
    githubLoginStatus: (input: {
      handle?: string;
    }) => Promise<import("./profile").GithubLoginStatus>;
    githubLoginCancel: (input: { handle?: string }) => Promise<void>;
    githubSet: (input: { host: string; token: string }) => Promise<{ login: string }>;
    githubRemove: (input: { host: string }) => Promise<void>;
    githubStatus: (input: { host: string }) => Promise<{ login: string | null }>;
    githubCliCandidates: () => Promise<import("./profile").GithubCliCandidates>;
    githubCliImport: (input: {
      host: string;
      login: string;
    }) => Promise<import("./profile").GithubCliImportResult>;
    list: () => Promise<typeof ProfileListResult.Type>;
    create: (input: ProfileCreateInput) => Promise<ProfileSummary>;
    update: (input: ProfileUpdateInput) => Promise<ProfileSummary>;
    remove: (input: { profileId: ProfileId }) => Promise<void>;
    loginStart: (input: {
      instanceId: import("./providerInstance").ProviderInstanceId;
      method?: "browser" | "device-code" | "install";
    }) => Promise<{ handle: string }>;
    input: (input: { handle: string; data: string }) => Promise<void>;
    cancel: (input: { handle: string }) => Promise<void>;
    logout: (input: {
      instanceId: import("./providerInstance").ProviderInstanceId;
    }) => Promise<{ handle: string }>;
    accountStatus: (input: {
      instanceId: import("./providerInstance").ProviderInstanceId;
    }) => Promise<unknown>;
  };
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    snapshot: (input: TerminalSnapshotInput) => Promise<TerminalSessionSnapshot | null>;
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
      /** User take-over: pausing fails running and queued agent actions for the thread. */
      setPaused: (input: PreviewAutomationSetPausedInput) => Promise<void>;
      onOwnerRequested: (
        callback: (request: PreviewAutomationOwnerRequested) => void,
      ) => () => void;
      onOwnerReleased: (callback: (event: PreviewAutomationOwnerReleased) => void) => () => void;
      onPauseChanged: (callback: (event: PreviewAutomationPauseChanged) => void) => () => void;
      /** Which threads control apps on this computer (computer use); empty when none. */
      onComputerUseChanged: (
        callback: (event: typeof AgentComputerUseChanged.Type) => void,
      ) => () => void;
    };
    onEvent: (callback: (event: PreviewEvent) => void) => () => void;
    onLocalServersUpdated: (callback: (event: DiscoveredLocalServerList) => void) => () => void;
  };
  projects: {
    getCheckedInConfig: (input: ProjectGetCheckedInConfigInput) => Promise<ProjectCheckedInConfig>;
    authorizeEntry: (input: ProjectAuthorizeEntryInput) => Promise<ProjectAuthorizeEntryResult>;
    clone: (input: ProjectCloneInput) => Promise<ProjectCloneJob>;
    cloneList: () => Promise<ReadonlyArray<ProjectCloneJob>>;
    ensureScratch: () => Promise<ProjectEnsureScratchResult>;
    createNew: (input: ProjectCreateNewInput) => Promise<ProjectCreateNewResult>;
    findByRepository: (
      input: ProjectFindByRepositoryInput,
    ) => Promise<ProjectFindByRepositoryResult>;
    cloneCancel: (input: ProjectCloneCancelInput) => Promise<void>;
    listDirectory: (input: ProjectListDirectoryInput) => Promise<ProjectListEntriesResult>;
    listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    searchContents: (input: ProjectSearchContentsInput) => Promise<ProjectSearchContentsResult>;
    cancelContentSearch: (
      input: ProjectCancelContentSearchInput,
    ) => Promise<ProjectCancelContentSearchResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    openHtmlPreview: (input: ProjectOpenHtmlPreviewInput) => Promise<{ url: string }>;
    issueAssetUrl: (input: ProjectIssueAssetUrlInput) => Promise<ProjectIssueAssetUrlResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    /** Replaces this client's watched files and directories for `cwd`. */
    setWatchedPaths: (input: ProjectSetWatchedPathsInput) => Promise<ProjectSetWatchedPathsResult>;
    onWatchedPathsChanged: (
      callback: (payload: ProjectWatchedPathsChangedPayload) => void,
    ) => () => void;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    revealInFileManager: (input: RevealInFileManagerInput) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    prepareWorktree: (input: GitPrepareWorktreeInput) => Promise<GitCreateWorktreeResult>;
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
    reportClientDiagnostics: (input: ReportClientDiagnosticsInput) => Promise<void>;
    getClaudeTranscriptRepair: (input: {
      threadId: ThreadId;
    }) => Promise<{ backupId?: string; canRepair: boolean } | null>;
    repairClaudeTranscript: (input: { threadId: ThreadId }) => Promise<{
      backupId?: string;
      restoredMessages: number;
      status: "validated" | "repaired";
    }>;
    undoClaudeTranscriptRepair: (input: { threadId: ThreadId; backupId: string }) => Promise<void>;
    getConfig: () => Promise<ServerConfig>;
    updateSettings: (input: ServerSettingsPatch) => Promise<ServerSettings>;
    getProjectSettings: (input: { projectId: ProjectId }) => Promise<ProjectSettingsResult>;
    migrateClientSetting: (input: MigrateClientSettingInput) => Promise<MigrateClientSettingResult>;
    refreshProviders: (
      input?: ServerCheckProviderUpdatesInput,
    ) => Promise<ServerProviderUpdatedPayload>;
    checkProviderUpdates: (
      input?: ServerCheckProviderUpdatesInput,
    ) => Promise<ServerProviderUpdatedPayload>;
    runProviderUpdate: (
      input: ServerRunProviderUpdateInput,
    ) => Promise<ServerRunProviderUpdateResult>;
    validateHarnesses: (input?: {
      providerOptions?: ProviderStartOptions;
    }) => Promise<{ results: ReadonlyArray<ServerHarnessValidationResult> }>;
    getProviderInventory: (
      input: ServerGetProviderInventoryInput,
    ) => Promise<ProviderInstanceInventory>;
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
    listImportCandidates: (
      input: McpListImportCandidatesRequest,
    ) => Promise<McpListImportCandidatesResult>;
    probeServer: (input: McpProbeServerRequest) => Promise<McpProbeServerResult>;
    storeSecret: (input: McpStoreSecretRequest) => Promise<McpStoreSecretResult>;
    inspectServer: (input: McpInspectServerRequest) => Promise<McpInspectServerResult>;
    reconnectServer: (input: McpReconnectServerRequest) => Promise<McpReconnectServerResult>;
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
    getUsage: (input?: StorageGetUsageRequest) => Promise<StorageGetUsageResult>;
    cleanup: (input: StorageCleanupRequest) => Promise<StorageCleanupStatus>;
    cancelCleanup: (input: StorageCancelCleanupRequest) => Promise<void>;
    /** What automatic cleanup and auto-pull would do now, with exact skip reasons. */
    automationDryRun: () => Promise<StorageAutomationDryRunResult>;
    automationAudit: (input?: StorageAutomationAuditInput) => Promise<StorageAutomationAuditResult>;
    onInvalidated: (callback: (payload: StorageInvalidatedPayload) => void) => () => void;
    getStatus: () => Promise<StorageStatus>;
    getTargets: (input: StorageGetTargetsRequest) => Promise<StorageGetTargetsResult>;
    getOperation: (input: StorageGetOperationRequest) => Promise<StorageGetOperationResult>;
    onStatusUpdated: (callback: (payload: StorageStatus) => void) => () => void;
    /** Free space on the volumes F5 and its providers write to. */
    getDiskSpace: (input?: StorageGetDiskSpaceRequest) => Promise<DiskSpaceStatus>;
    onDiskSpaceUpdated: (callback: (payload: DiskSpaceStatus) => void) => () => void;
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
    steer: (input: NextTurnQueueSteerInput) => Promise<NextTurnQueueSnapshot>;
    setPaused: (input: NextTurnQueueSetPausedInput) => Promise<NextTurnQueueSnapshot>;
    scheduleUsageLimitResume: (
      input: NextTurnQueueScheduleUsageLimitResumeInput,
    ) => Promise<NextTurnQueueSnapshot>;
    cancelUsageLimitResume: (input: NextTurnQueueCancelUsageLimitResumeInput) => Promise<{
      readonly kind: "cancelled" | "already_sending";
      readonly snapshot: NextTurnQueueSnapshot;
    }>;
    refreshUsageLimitResume: (
      input: NextTurnQueueRefreshUsageLimitResumeInput,
    ) => Promise<NextTurnQueueSnapshot>;
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
  worktrees: {
    moveThread: (input: WorktreesMoveThreadInput) => Promise<WorktreesMoveThreadResult>;
    discardMovedChanges: (
      input: WorktreesDiscardMovedChangesInput,
    ) => Promise<WorktreesDiscardMovedChangesResult>;
    list: (input: WorktreesListInput) => Promise<WorktreesListResult>;
    switchWorkspace: (input: WorktreesSwitchWorkspaceInput) => Promise<WorkspaceTransitionSnapshot>;
    getTransition: (
      input: WorktreesGetTransitionInput,
    ) => Promise<WorkspaceTransitionSnapshot | null>;
    previewTransitionRecovery: (
      input: WorktreesPreviewTransitionRecoveryInput,
    ) => Promise<WorkspaceTransitionRecoveryPreview>;
    resolveTransition: (
      input: WorktreesResolveTransitionInput,
    ) => Promise<WorkspaceTransitionSnapshot>;

    inspect: (input: WorktreesInspectInput) => Promise<WorktreesInspectResult>;
    remove: (input: WorktreesRemoveInput) => Promise<WorktreesRemoveResult>;
    threadState: (input: WorktreesThreadStateInput) => Promise<WorktreesThreadStateResult>;
    recover: (input: WorktreesRecoverInput) => Promise<WorktreesRecoverResult>;
  };
  worktreeSetup: {
    /** Current snapshot (null when nothing is tracked); updates arrive on `onUpdated`. */
    subscribe: (input: WorktreeSetupThreadInput) => Promise<WorktreeSetupSubscribeResult>;
    cancel: (input: WorktreeSetupActionInput) => Promise<WorktreeSetupActionResult>;
    retry: (input: WorktreeSetupActionInput) => Promise<WorktreeSetupActionResult>;
    workLocally: (input: WorktreeSetupActionInput) => Promise<WorktreeSetupActionResult>;
    onUpdated: (callback: (payload: WorktreeSetupUpdatedPayload) => void) => () => void;
  };
  globalSearch: {
    query: (input: GlobalSearchQueryInput) => Promise<GlobalSearchQueryResult>;
  };
  agentBridge: {
    getState: () => Promise<AgentBridgeState>;
    setSchedulingGrant: (
      input: import("./agentBridge").AgentBridgeSchedulingGrantInput,
    ) => Promise<void>;
    /** Invalidation only: refetch state when it fires. */
    onStateChanged: (callback: (payload: AgentBridgeStateChanged) => void) => () => void;
    getTasks: (input: AgentBridgeGetTasksInput) => Promise<AgentBridgeGetTasksResult>;
    getTask: (taskId: string) => Promise<BotTask>;
    getTaskActivities: (
      input: AgentBridgeGetTaskActivitiesInput,
    ) => Promise<AgentBridgeGetTaskActivitiesResult>;
    createTask: (input: AgentBridgeCreateTaskInput) => Promise<BotTask>;
    replyToTask: (input: AgentBridgeReplyToTaskInput) => Promise<BotTask>;
    pauseTask: (input: AgentBridgeTaskControlInput) => Promise<BotTask>;
    resumeTask: (input: AgentBridgeTaskControlInput) => Promise<BotTask>;
    cancelTask: (input: AgentBridgeTaskControlInput) => Promise<BotTask>;
  };
  agents: {
    getSnapshot: (input?: AgentsGetSnapshotInput) => Promise<AgentsSnapshot>;
    dismiss: (input: AgentsDismissInput) => Promise<AgentsDismissResult>;
    onSnapshotUpdated: (callback: (snapshot: AgentsSnapshot) => void) => () => void;
  };
  usage: {
    consumeResetCredit: (
      input: UsageConsumeResetCreditInput,
    ) => Promise<UsageConsumeResetCreditResult>;
    getAccounts: (input: UsageGetAccountsInput) => Promise<UsageAccounts>;
    getSummary: (input: UsageGetSummaryInput) => Promise<UsageSummary>;
    getQuotaHistory: () => Promise<UsageQuotaHistory>;
  };
  /** Private provider form/URL answers; never go through orchestration commands. */
  nativeOperations?: {
    historyRecovery?: (input: NativeHistoryRecoveryInput) => Promise<NativeHistoryRecovery | null>;
    resolve: (input: NativeOperationResolutionInput) => Promise<NativeOperationRecord>;
    fork: (input: NativeForkInput) => Promise<NativeOperationRecord>;
    execute: (input: NativeOperationInput) => Promise<NativeOperationRecord>;
    list: (input: { threadId: ThreadId }) => Promise<readonly NativeOperationRecord[]>;
    inspect: (input: NativeOperationInspectInput) => Promise<unknown>;
  };
  elicitation: {
    submit: (input: ElicitationSubmitInput) => Promise<ElicitationSubmitResult>;
  };
  workflowPlatform: {
    listTemplates: () => Promise<WorkflowPlatformListTemplatesResult>;
    createRun: (input: WorkflowPlatformCreateRunInput) => Promise<WorkflowPlatformCreateRunResult>;
    inspectRun: (
      input: WorkflowPlatformInspectRunInput,
    ) => Promise<WorkflowPlatformInspectRunResult>;
  };
  upstreamPorts: {
    listProjects: () => Promise<UpstreamPortsListProjectsResult>;
    getOverview: (input: UpstreamPortsProjectInput) => Promise<UpstreamOverview>;
    listTopics: (input: UpstreamListTopicsInput) => Promise<UpstreamListTopicsResult>;
    getTopic: (input: UpstreamGetTopicInput) => Promise<UpstreamTopicDetail>;
    decide: (input: UpstreamDecideInput) => Promise<UpstreamDecideResult>;
    acceptSuggestions: (input: UpstreamAcceptSuggestionsInput) => Promise<UpstreamDecideResult>;
    run: (input: UpstreamRunInput) => Promise<UpstreamRunResult>;
    startPort: (input: UpstreamStartPortInput) => Promise<UpstreamStartPortResult>;
    unlinkPort: (input: UpstreamUnlinkPortInput) => Promise<UpstreamRevisionResult>;
    getPortPrompt: (input: UpstreamGetPortPromptInput) => Promise<UpstreamGetPortPromptResult>;
    resolvePublication: (input: UpstreamResolvePublicationInput) => Promise<UpstreamRevisionResult>;
    addRemote: (input: UpstreamPortsProjectInput) => Promise<UpstreamRevisionResult>;
    takeOverWriter: (input: UpstreamPortsProjectInput) => Promise<UpstreamRevisionResult>;
    /** Invalidation only: refetch when it fires. */
    onChanged: (callback: (payload: UpstreamPortsChanged) => void) => () => void;
  };
  prHub: {
    listAccounts: () => Promise<ReadonlyArray<ForgeAccount>>;
    saveAccount: (input: ForgeAccountInput) => Promise<ForgeAccount>;
    removeAccount: (input: { accountId: string }) => Promise<void>;
    listAccountRouting: () => Promise<ReadonlyArray<ForgeAccountRouting>>;
    setAccountRouting: (input: ForgeAccountRouting) => Promise<void>;
    removeAccountRouting: (input: ForgeAccountRouting) => Promise<void>;
    peek: (input: PrHubPeekInput) => Promise<PrHubPeek | null>;
    getStack: (input: PrHubStackInput) => Promise<PrHubStack | null>;
    getViewedFiles: (input: PrHubViewedFilesInput) => Promise<ReadonlyArray<string>>;
    setViewedFile: (input: PrHubSetViewedFileInput) => Promise<ReadonlyArray<string>>;
    getThreadLinks: (input: {
      threadId: ThreadId;
    }) => Promise<ReadonlyArray<ThreadPullRequestLink>>;
    getThreadsForPr: (input: {
      key: PullRequestKey;
    }) => Promise<ReadonlyArray<{ threadId: ThreadId; title: string }>>;
    prepareOperation: (input: ForgePrepareOperationInput) => Promise<ForgeOperation>;
    submitOperation: (input: ForgeOperationInput) => Promise<ForgeOperation>;
    getOperation: (input: ForgeOperationInput) => Promise<ForgeOperation | null>;
    recoverOperation: (input: ForgeOperationInput) => Promise<ForgeOperation>;
    cancelOperation: (input: ForgeOperationInput) => Promise<ForgeOperation>;
    listReviewerCandidates: (input: PrHubStackInput) => Promise<unknown>;

    getOverview: (input?: PrHubOverviewInput) => Promise<PrHubOverview>;
    claimNotifications: (input: PrHubClaimNotificationsInput) => Promise<PrHubNotificationBatch>;
    acknowledgeNotifications: (input: PrHubAcknowledgeNotificationsInput) => Promise<PrHubOverview>;
    listPullRequests: (input: PrHubListInput) => Promise<PrHubListPage>;
    refresh: (input: PrHubRefreshInput) => Promise<PrHubOverview>;
    approve: (input: PrHubReviewInput) => Promise<PrHubOverview>;
    requestChanges: (input: PrHubRequestChangesInput) => Promise<PrHubOverview>;
    comment: (input: PrHubCommentInput) => Promise<PrHubOverview>;
    merge: (input: PrHubMergeInput) => Promise<PrHubOverview>;
    markReady: (input: PrHubMarkReadyInput) => Promise<PrHubOverview>;
    reRequestReview: (input: PrHubReRequestInput) => Promise<PrHubOverview>;
    snooze: (input: PrHubSnoozeInput) => Promise<PrHubOverview>;
    unsnooze: (input: PrHubUnsnoozeInput) => Promise<PrHubOverview>;
    ignore: (input: PrHubIgnoreInput) => Promise<PrHubOverview>;
    acknowledgeAttention: (input: PrHubAcknowledgeAttentionInput) => Promise<PrHubOverview>;
    markSeen: (input: PrHubMarkSeenInput) => Promise<PrHubOverview>;
    markNotified: (input: PrHubMarkNotifiedInput) => Promise<PrHubOverview>;
    analyzeAdvisories: (input?: PrHubAnalyzeAdvisoriesInput) => Promise<PrHubAdvisorySnapshot>;
    getAdvisories: (input?: PrHubGetAdvisoriesInput) => Promise<PrHubAdvisorySnapshot>;
    getReviewGuide: (input: PrHubReviewGuideInput) => Promise<PullRequestReviewGuideResult>;
    generateReviewGuide: (input: PrHubReviewGuideInput) => Promise<PullRequestReviewGuideResult>;
    resolveLocalCheckout: (input: PrHubResolveCheckoutInput) => Promise<PrHubResolvedCheckout[]>;
    listLocalCheckoutCandidates: (
      input: PrHubLocalCandidatesInput,
    ) => Promise<PrHubLocalCheckoutCandidate[]>;
    getDetail: (input: PrHubDetailInput) => Promise<PrHubDetailResult>;
    getTimeline: (input: PrHubTimelineInput) => Promise<PrHubTimelinePage>;
    getUnresolvedThreads: (input: PrHubDetailInput) => Promise<PrHubUnresolvedThreadsResult>;
    getFiles: (input: PrHubFilesInput) => Promise<PrHubFilesPage>;
    replyReviewThread: (input: PrHubReplyInput) => Promise<PrHubReplyOperation>;
    getReplyOperation: (input: PrHubThreadsInput) => Promise<PrHubReplyOperation | null>;
    recoverReply: (input: PrHubRecoverReplyInput) => Promise<PrHubReplyOperation>;
    getReplyDraft: (input: PrHubThreadsInput) => Promise<PrHubReplyDraft | null>;
    saveReplyDraft: (input: PrHubSaveReplyDraftInput) => Promise<PrHubReplyDraftResult>;
    getReviewThreads: (input: PrHubThreadsInput) => Promise<PrHubThreadsPage>;
    setReviewThreadState: (input: PrHubThreadStateInput) => Promise<PrHubReviewThread>;
    getReviewDraft: (input: PrHubDetailInput) => Promise<PrHubReviewDraftResult>;
    prepareComment: (input: PrHubPrepareCommentInput) => Promise<PrHubCommentOperation>;
    submitComment: (input: PrHubCommentOperationInput) => Promise<PrHubCommentOperation>;
    getCommentOperation: (input: PrHubCommentReadInput) => Promise<PrHubCommentOperation | null>;
    recoverComment: (input: PrHubRecoverCommentInput) => Promise<PrHubCommentOperation>;
    prepareQuickReview: (input: PrHubPrepareQuickReviewInput) => Promise<PrHubReviewOperation>;
    prepareReview: (input: PrHubPrepareReviewInput) => Promise<PrHubReviewOperation>;
    track: (input: PrHubTrackInput) => Promise<TrackedPullRequest>;
    recoverReview: (input: PrHubRecoverReviewInput) => Promise<PrHubReviewOperation>;
    submitReview: (input: PrHubReviewOperationInput) => Promise<PrHubReviewOperation>;
    getReviewOperation: (input: PrHubDetailInput) => Promise<PrHubReviewOperation | null>;
    cancelReviewPreparation: (input: PrHubReviewOperationInput) => Promise<PrHubReviewOperation>;
    saveReviewDraft: (input: PrHubSaveReviewDraftInput) => Promise<PrHubReviewDraftResult>;
    updateComment: (input: PrHubUpdateCommentInput) => Promise<PrHubDetailMutationResult>;
    setReaction: (input: PrHubSetReactionInput) => Promise<PrHubDetailMutationResult>;
    changeReviewers: (input: PrHubChangeReviewersInput) => Promise<PrHubDetailMutationResult>;
    updateBranch: (input: PrHubUpdateBranchInput) => Promise<PrHubDetailMutationResult>;
    clearData: (input?: PrHubClearDataInput) => Promise<PrHubOverview>;
    onChanged: (callback: (snapshot: PrHubChanged) => void) => () => void;
    onAdvisoriesUpdated: (callback: (snapshot: PrHubAdvisoriesChanged) => void) => () => void;
  };
  orchestration: {
    searchThread: (input: ThreadSearchInput) => Promise<ThreadSearchResult>;
    getLatestSequence: () => Promise<OrchestrationGetLatestSequenceResult>;
    getSnapshot: () => Promise<OrchestrationReadModel>;
    getStartupSnapshot: (
      input?: OrchestrationGetStartupSnapshotInput,
    ) => Promise<OrchestrationGetStartupSnapshotResult>;
    getThreadTailDetails: (
      input: OrchestrationGetThreadTailDetailsInput,
    ) => Promise<OrchestrationThreadTailDetails>;
    getRewindDrafts: (
      input: OrchestrationGetRewindDraftsInput,
    ) => Promise<OrchestrationGetRewindDraftsResult>;
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
    skipDocumentReaderPass: (
      input: OrchestrationSkipDocumentReaderPassInput,
    ) => Promise<OrchestrationSkipDocumentReaderPassResult>;
    retryWorkflow: (
      input: OrchestrationRetryWorkflowInput,
    ) => Promise<OrchestrationRetryWorkflowResult>;
    retryCodeReviewWorkflow: (
      input: OrchestrationRetryCodeReviewWorkflowInput,
    ) => Promise<OrchestrationRetryWorkflowResult>;
    retryInvestigationWorkflow: (
      input: OrchestrationRetryInvestigationWorkflowInput,
    ) => Promise<void>;
    startImplementation: (input: OrchestrationStartImplementationInput) => Promise<void>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
