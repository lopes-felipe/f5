import { PR_WATCH_CHANGED_CHANNEL, PullRequestWatchChanged } from "./pullRequestWatch";
import { HTML_RENDER_REQUEST_CHANNEL, HtmlPreviewHostRequest } from "./threadTools";
import { Schema } from "effect";
import {
  FilesystemPath,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  ComputerAccessRequested,
  ComputerActivity,
  ComputerBackendKind,
  ComputerDelivery,
  ComputerExecutionState,
  ComputerGrant,
  ComputerPauseCause,
} from "./computerAutomation";
import {
  ProfileListResult,
  ProfileRegistryDiagnostic,
  ProfileSummary,
  ProviderAccountEvent,
} from "./profile";
import { ServerBootstrap } from "./protocol";

import { AGENT_BRIDGE_WS_CHANNELS, AgentBridgeStateChanged } from "./agentBridge";
import { AGENTS_WS_CHANNELS, AgentsSnapshot } from "./backgroundWork";
import { GitActionProgressEvent, GitCheckoutConflict, GitStatusInvalidatedPayload } from "./git";
import { McpStatusUpdatedPayload } from "./mcp";
import { ScheduledTasksChanged } from "./scheduledTasks";
import { NextTurnQueueSnapshot, NextTurnQueueSummary } from "./nextTurnQueue";
import { ORCHESTRATION_WS_CHANNELS, OrchestrationEvent } from "./orchestration";
import { DiscoveredLocalServerList, PreviewEvent } from "./preview";
import {
  PreviewAutomationOwnerReleased,
  PreviewAutomationOwnerRequested,
  PreviewAutomationPauseChanged,
  PreviewAutomationRequest,
} from "./previewAutomation";
import { PR_HUB_WS_CHANNELS, PrHubAdvisoriesChanged, PrHubChanged } from "./prHub";
import { UPSTREAM_PORTS_WS_CHANNELS, UpstreamPortsChanged } from "./upstreamPortsWire";
import { ProjectWatchedPathsChangedPayload } from "./project";
import { ServerConfigUpdatedPayload, ServerProviderAdvisoriesUpdatedPayload } from "./server";
import { DiskSpaceStatus, StorageStatus, StorageInvalidatedPayload } from "./storage";
import { TerminalEvent } from "./terminal";
import { WorktreeSetupUpdatedPayload } from "./worktreeSetup";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export { WS_METHODS } from "./wsMethods";
export { WebSocketRequest } from "./wsRequests";

export const WS_CHANNELS = {
  scheduledTasksChanged: "scheduledTasks.changed",
  profilesUpdated: "profiles.updated",
  providerAccountEvent: "providerAccount.event",
  gitActionProgress: "git.actionProgress",
  gitStatusInvalidated: "git.status.invalidate",
  projectsWatchedPathsChanged: "projects.watchedPathsChanged",
  terminalEvent: "terminal.event",
  previewEvent: "preview.event",
  previewLocalServersUpdated: "preview.localServersUpdated",
  previewAutomationRequest: "preview.automation.request",
  htmlRenderRequest: HTML_RENDER_REQUEST_CHANNEL,
  pullRequestWatchesChanged: PR_WATCH_CHANGED_CHANNEL,
  previewAutomationOwnerRequested: "preview.automation.ownerRequested",
  previewAutomationOwnerReleased: "preview.automation.ownerReleased",
  previewAutomationPauseChanged: "preview.automation.pauseChanged",
  agentComputerUseChanged: "agent.computerUseChanged",
  computerAccessRequested: "computer.access.requested",
  computerAccessSettled: "computer.access.settled",
  computerAccessGrantsChanged: "computer.access.grantsChanged",
  computerActivity: "computer.activity",
  computerObservationsInvalidated: "computer.observations.invalidated",
  serverWelcome: "server.welcome",
  serverConfigUpdated: "server.configUpdated",
  providerAdvisoriesUpdated: "provider.advisoriesUpdated",
  mcpStatusUpdated: "mcp.statusUpdated",
  storageInvalidated: "storage.invalidated",
  storageStatusUpdated: "storage.statusUpdated",
  storageDiskSpaceUpdated: "storage.diskSpaceUpdated",
  nextTurnQueueUpdated: "nextTurnQueue.updated",
  nextTurnQueueSummaryUpdated: "nextTurnQueue.summaryUpdated",
  worktreeSetupUpdated: "worktreeSetup.updated",
} as const;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.String),
      retryable: Schema.optional(Schema.Boolean),
      retryAfterMs: Schema.optional(NonNegativeInt),
      checkoutConflict: Schema.optional(GitCheckoutConflict),
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPushSequence = NonNegativeInt;
export type WsPushSequence = typeof WsPushSequence.Type;

export const WsWelcomePayload = Schema.Struct({
  // Legacy welcomes remain decodable so the protocol check can request an upgrade.
  backendIncarnation: Schema.optional(TrimmedNonEmptyString),
  // Optional only to decode legacy welcomes and explicitly close them as upgrade-required.
  bootstrap: Schema.optional(ServerBootstrap),
  profile: Schema.optional(ProfileSummary),
  profileDiagnostic: Schema.optional(ProfileRegistryDiagnostic),
  cwd: FilesystemPath,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;

export interface WsPushPayloadByChannel {
  readonly [PR_WATCH_CHANGED_CHANNEL]: typeof PullRequestWatchChanged.Type;
  readonly [WS_CHANNELS.profilesUpdated]: typeof ProfileListResult.Type;
  readonly [WS_CHANNELS.providerAccountEvent]: typeof ProviderAccountEvent.Type;
  readonly [AGENTS_WS_CHANNELS.snapshotUpdated]: typeof AgentsSnapshot.Type;
  readonly [AGENT_BRIDGE_WS_CHANNELS.stateChanged]: typeof AgentBridgeStateChanged.Type;
  readonly [WS_CHANNELS.serverWelcome]: WsWelcomePayload;
  readonly [WS_CHANNELS.serverConfigUpdated]: typeof ServerConfigUpdatedPayload.Type;
  readonly [WS_CHANNELS.providerAdvisoriesUpdated]: typeof ServerProviderAdvisoriesUpdatedPayload.Type;
  readonly [WS_CHANNELS.gitActionProgress]: typeof GitActionProgressEvent.Type;
  readonly [WS_CHANNELS.gitStatusInvalidated]: typeof GitStatusInvalidatedPayload.Type;
  readonly [WS_CHANNELS.projectsWatchedPathsChanged]: ProjectWatchedPathsChangedPayload;
  readonly [WS_CHANNELS.terminalEvent]: typeof TerminalEvent.Type;
  readonly [WS_CHANNELS.previewEvent]: PreviewEvent;
  readonly [WS_CHANNELS.previewLocalServersUpdated]: DiscoveredLocalServerList;
  readonly [WS_CHANNELS.htmlRenderRequest]: typeof HtmlPreviewHostRequest.Type;
  readonly [WS_CHANNELS.previewAutomationRequest]: typeof PreviewAutomationRequest.Type;
  readonly [WS_CHANNELS.previewAutomationOwnerRequested]: typeof PreviewAutomationOwnerRequested.Type;
  readonly [WS_CHANNELS.previewAutomationOwnerReleased]: typeof PreviewAutomationOwnerReleased.Type;
  readonly [WS_CHANNELS.previewAutomationPauseChanged]: typeof PreviewAutomationPauseChanged.Type;
  readonly [WS_CHANNELS.agentComputerUseChanged]: typeof AgentComputerUseChanged.Type;
  readonly [WS_CHANNELS.computerAccessRequested]: typeof ComputerAccessPush.Type;
  readonly [WS_CHANNELS.computerAccessSettled]: typeof ComputerAccessSettled.Type;
  readonly [WS_CHANNELS.computerAccessGrantsChanged]: typeof ComputerGrantsChanged.Type;
  readonly [WS_CHANNELS.computerObservationsInvalidated]: { readonly threadId: string };
  readonly [WS_CHANNELS.computerActivity]: typeof ComputerActivity.Type;
  readonly [WS_CHANNELS.mcpStatusUpdated]: McpStatusUpdatedPayload;
  readonly [WS_CHANNELS.storageInvalidated]: StorageInvalidatedPayload;
  readonly [WS_CHANNELS.storageStatusUpdated]: StorageStatus;
  readonly [WS_CHANNELS.storageDiskSpaceUpdated]: typeof DiskSpaceStatus.Type;
  readonly [WS_CHANNELS.scheduledTasksChanged]: typeof ScheduledTasksChanged.Type;
  readonly [WS_CHANNELS.nextTurnQueueUpdated]: typeof NextTurnQueueSnapshot.Type;
  readonly [WS_CHANNELS.nextTurnQueueSummaryUpdated]: typeof NextTurnQueueSummary.Type;
  readonly [WS_CHANNELS.worktreeSetupUpdated]: WorktreeSetupUpdatedPayload;
  readonly [ORCHESTRATION_WS_CHANNELS.domainEvent]: OrchestrationEvent;
  readonly [PR_HUB_WS_CHANNELS.changed]: typeof PrHubChanged.Type;
  readonly [PR_HUB_WS_CHANNELS.advisoriesUpdated]: typeof PrHubAdvisoriesChanged.Type;
  readonly [UPSTREAM_PORTS_WS_CHANNELS.changed]: typeof UpstreamPortsChanged.Type;
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

export const WsPushProfilesUpdated = makeWsPushSchema(
  WS_CHANNELS.profilesUpdated,
  ProfileListResult,
);
export const WsPushProviderAccountEvent = makeWsPushSchema(
  WS_CHANNELS.providerAccountEvent,
  ProviderAccountEvent,
);
export const WsPushServerWelcome = makeWsPushSchema(WS_CHANNELS.serverWelcome, WsWelcomePayload);
export const WsPushAgentsSnapshotUpdated = makeWsPushSchema(
  AGENTS_WS_CHANNELS.snapshotUpdated,
  AgentsSnapshot,
);
export const WsPushAgentBridgeStateChanged = makeWsPushSchema(
  AGENT_BRIDGE_WS_CHANNELS.stateChanged,
  AgentBridgeStateChanged,
);
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
export const WsPushProjectsWatchedPathsChanged = makeWsPushSchema(
  WS_CHANNELS.projectsWatchedPathsChanged,
  ProjectWatchedPathsChangedPayload,
);
export const WsPushTerminalEvent = makeWsPushSchema(WS_CHANNELS.terminalEvent, TerminalEvent);
export const WsPushPreviewEvent = makeWsPushSchema(WS_CHANNELS.previewEvent, PreviewEvent);
export const WsPushPreviewLocalServersUpdated = makeWsPushSchema(
  WS_CHANNELS.previewLocalServersUpdated,
  DiscoveredLocalServerList,
);
export const WsPushPullRequestWatchesChanged = makeWsPushSchema(
  PR_WATCH_CHANGED_CHANNEL,
  PullRequestWatchChanged,
);
export const WsPushHtmlRenderRequest = makeWsPushSchema(
  WS_CHANNELS.htmlRenderRequest,
  HtmlPreviewHostRequest,
);
export const WsPushPreviewAutomationRequest = makeWsPushSchema(
  WS_CHANNELS.previewAutomationRequest,
  PreviewAutomationRequest,
);
export const WsPushPreviewAutomationOwnerRequested = makeWsPushSchema(
  WS_CHANNELS.previewAutomationOwnerRequested,
  PreviewAutomationOwnerRequested,
);
export const WsPushPreviewAutomationOwnerReleased = makeWsPushSchema(
  WS_CHANNELS.previewAutomationOwnerReleased,
  PreviewAutomationOwnerReleased,
);
export const WsPushPreviewAutomationPauseChanged = makeWsPushSchema(
  WS_CHANNELS.previewAutomationPauseChanged,
  PreviewAutomationPauseChanged,
);
export const AgentComputerUseHolder = Schema.Struct({
  /** False for retained pause/recovery summaries after authoritative release. */
  leaseHeld: Schema.optional(Schema.Boolean),
  threadId: ThreadId,
  /** Absent for browser-integration (Chrome) holders. */
  backend: Schema.optional(ComputerBackendKind),
  delivery: ComputerDelivery,
  appId: Schema.optional(Schema.String),
  appName: Schema.optional(Schema.String),
  state: ComputerExecutionState,
  pauseCause: Schema.optional(ComputerPauseCause),
});
export type AgentComputerUseHolder = typeof AgentComputerUseHolder.Type;
/**
 * Which threads in this profile control apps on this computer. Foreground holders own the
 * screen, mouse and keyboard; background holders act inside one app each.
 */
export const AgentComputerUseChanged = Schema.Struct({
  holders: Schema.Array(AgentComputerUseHolder),
  pendingTakeover: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      appId: Schema.String,
      appName: Schema.optional(Schema.String),
      state: ComputerExecutionState,
    }),
  ),
  otherProfile: Schema.optional(Schema.Boolean),
});
export const WsPushAgentComputerUseChanged = makeWsPushSchema(
  WS_CHANNELS.agentComputerUseChanged,
  AgentComputerUseChanged,
);
export const ComputerAccessPush = Schema.Struct({
  expiresAtMs: Schema.optionalKey(Schema.Number),
  ...ComputerAccessRequested.fields,
  backendIncarnation: Schema.String,
});
export const ComputerAccessSettled = Schema.Struct({
  requestId: Schema.String,
  threadId: Schema.String,
  allowed: Schema.Boolean,
});
export const ComputerGrantsChanged = Schema.Struct({
  threadId: Schema.String,
  grants: Schema.Array(ComputerGrant),
  grantVersion: Schema.Int,
});
export const WsPushComputerAccessRequested = makeWsPushSchema(
  WS_CHANNELS.computerAccessRequested,
  ComputerAccessPush,
);
export const WsPushComputerAccessSettled = makeWsPushSchema(
  WS_CHANNELS.computerAccessSettled,
  ComputerAccessSettled,
);
export const WsPushComputerGrantsChanged = makeWsPushSchema(
  WS_CHANNELS.computerAccessGrantsChanged,
  ComputerGrantsChanged,
);
export const WsPushComputerObservationsInvalidated = makeWsPushSchema(
  WS_CHANNELS.computerObservationsInvalidated,
  Schema.Struct({ threadId: Schema.String }),
);
export const WsPushComputerActivity = makeWsPushSchema(
  WS_CHANNELS.computerActivity,
  ComputerActivity,
);
export const WsPushMcpStatusUpdated = makeWsPushSchema(
  WS_CHANNELS.mcpStatusUpdated,
  McpStatusUpdatedPayload,
);
export const WsPushStorageInvalidated = makeWsPushSchema(
  WS_CHANNELS.storageInvalidated,
  StorageInvalidatedPayload,
);
export const WsPushStorageStatusUpdated = makeWsPushSchema(
  WS_CHANNELS.storageStatusUpdated,
  StorageStatus,
);
export const WsPushStorageDiskSpaceUpdated = makeWsPushSchema(
  WS_CHANNELS.storageDiskSpaceUpdated,
  DiskSpaceStatus,
);
export const WsPushScheduledTasksChanged = makeWsPushSchema(
  WS_CHANNELS.scheduledTasksChanged,
  ScheduledTasksChanged,
);
export const WsPushNextTurnQueueUpdated = makeWsPushSchema(
  WS_CHANNELS.nextTurnQueueUpdated,
  NextTurnQueueSnapshot,
);
export const WsPushNextTurnQueueSummaryUpdated = makeWsPushSchema(
  WS_CHANNELS.nextTurnQueueSummaryUpdated,
  NextTurnQueueSummary,
);
export const WsPushWorktreeSetupUpdated = makeWsPushSchema(
  WS_CHANNELS.worktreeSetupUpdated,
  WorktreeSetupUpdatedPayload,
);
export const WsPushOrchestrationDomainEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  OrchestrationEvent,
);
export const WsPushPrHubChanged = makeWsPushSchema(PR_HUB_WS_CHANNELS.changed, PrHubChanged);
export const WsPushPrHubAdvisoriesUpdated = makeWsPushSchema(
  PR_HUB_WS_CHANNELS.advisoriesUpdated,
  PrHubAdvisoriesChanged,
);
export const WsPushUpstreamPortsChanged = makeWsPushSchema(
  UPSTREAM_PORTS_WS_CHANNELS.changed,
  UpstreamPortsChanged,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.profilesUpdated,
  WS_CHANNELS.providerAccountEvent,
  AGENTS_WS_CHANNELS.snapshotUpdated,
  AGENT_BRIDGE_WS_CHANNELS.stateChanged,
  WS_CHANNELS.gitActionProgress,
  WS_CHANNELS.gitStatusInvalidated,
  WS_CHANNELS.projectsWatchedPathsChanged,
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.providerAdvisoriesUpdated,
  WS_CHANNELS.terminalEvent,
  WS_CHANNELS.previewEvent,
  WS_CHANNELS.previewLocalServersUpdated,
  WS_CHANNELS.previewAutomationRequest,
  WS_CHANNELS.htmlRenderRequest,
  PR_WATCH_CHANGED_CHANNEL,
  WS_CHANNELS.previewAutomationOwnerRequested,
  WS_CHANNELS.previewAutomationOwnerReleased,
  WS_CHANNELS.previewAutomationPauseChanged,
  WS_CHANNELS.agentComputerUseChanged,
  WS_CHANNELS.computerAccessRequested,
  WS_CHANNELS.computerAccessSettled,
  WS_CHANNELS.computerAccessGrantsChanged,
  WS_CHANNELS.computerActivity,
  WS_CHANNELS.computerObservationsInvalidated,
  WS_CHANNELS.mcpStatusUpdated,
  WS_CHANNELS.storageInvalidated,
  WS_CHANNELS.storageStatusUpdated,
  WS_CHANNELS.storageDiskSpaceUpdated,
  WS_CHANNELS.scheduledTasksChanged,
  WS_CHANNELS.nextTurnQueueUpdated,
  WS_CHANNELS.nextTurnQueueSummaryUpdated,
  WS_CHANNELS.worktreeSetupUpdated,
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  PR_HUB_WS_CHANNELS.changed,
  PR_HUB_WS_CHANNELS.advisoriesUpdated,
  UPSTREAM_PORTS_WS_CHANNELS.changed,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushProfilesUpdated,
  WsPushProviderAccountEvent,
  WsPushAgentsSnapshotUpdated,
  WsPushAgentBridgeStateChanged,
  WsPushServerWelcome,
  WsPushServerConfigUpdated,
  WsPushProviderAdvisoriesUpdated,
  WsPushGitActionProgress,
  WsPushGitStatusInvalidated,
  WsPushProjectsWatchedPathsChanged,
  WsPushTerminalEvent,
  WsPushPreviewEvent,
  WsPushPreviewLocalServersUpdated,
  WsPushPreviewAutomationRequest,
  WsPushHtmlRenderRequest,
  WsPushPullRequestWatchesChanged,
  WsPushPreviewAutomationOwnerRequested,
  WsPushPreviewAutomationOwnerReleased,
  WsPushPreviewAutomationPauseChanged,
  WsPushAgentComputerUseChanged,
  WsPushComputerAccessRequested,
  WsPushComputerAccessSettled,
  WsPushComputerGrantsChanged,
  WsPushComputerActivity,
  WsPushComputerObservationsInvalidated,
  WsPushMcpStatusUpdated,
  WsPushStorageInvalidated,
  WsPushStorageStatusUpdated,
  WsPushStorageDiskSpaceUpdated,
  WsPushScheduledTasksChanged,
  WsPushNextTurnQueueUpdated,
  WsPushNextTurnQueueSummaryUpdated,
  WsPushWorktreeSetupUpdated,
  WsPushOrchestrationDomainEvent,
  WsPushPrHubChanged,
  WsPushPrHubAdvisoriesUpdated,
  WsPushUpstreamPortsChanged,
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
