/**
 * F5 Agent Bridge: a vendor-neutral MCP server that external agents (such as
 * a ChatGPT Dot) connect to. Settings are server-authoritative.
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./orchestration";

export const AGENT_BRIDGE_WS_METHODS = {
  getState: "agentBridge.getState",
  getTasks: "agentBridge.getTasks",
  getTask: "agentBridge.getTask",
  getTaskActivities: "agentBridge.getTaskActivities",
  createTask: "agentBridge.createTask",
  replyToTask: "agentBridge.replyToTask",
  pauseTask: "agentBridge.pauseTask",
  resumeTask: "agentBridge.resumeTask",
  cancelTask: "agentBridge.cancelTask",
  openPairingWindow: "agentBridge.openPairingWindow",
  decideAuthorization: "agentBridge.decideAuthorization",
  updateClientGrant: "agentBridge.updateClientGrant",
  revokeClient: "agentBridge.revokeClient",
  retryNotification: "agentBridge.retryNotification",
} as const;

export const AGENT_BRIDGE_WS_CHANNELS = {
  stateChanged: "agentBridge.stateChanged",
} as const;

export const AGENT_BRIDGE_SCOPES = ["f5.read", "f5.turns", "f5.tasks", "f5.events"] as const;
export const AgentBridgeScope = Schema.Literals(AGENT_BRIDGE_SCOPES);
export type AgentBridgeScope = typeof AgentBridgeScope.Type;

/** The fixed client id for whoever holds the local listener's token. */
export const AGENT_BRIDGE_LOCAL_CLIENT_ID = "local";
export const AGENT_BRIDGE_LOCAL_CLIENT_NAME = "Local MCP client";
export const AGENT_BRIDGE_CHATGPT_REDIRECT_URI =
  "https://chatgpt.com/connector_platform_oauth_redirect";
/** How long "Connect a client" accepts OAuth authorization requests. */
export const AGENT_BRIDGE_PAIRING_WINDOW_MS = 10 * 60 * 1000;
/** Remote listener ports must be unprivileged. */
export const AGENT_BRIDGE_REMOTE_MIN_PORT = 1024;

/**
 * Canonical public base URL: https, lowercase host, default port dropped, no
 * path, query, fragment, credentials, or trailing slash. Returns null when the
 * value cannot be one.
 */
export function canonicalizeAgentBridgePublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  return `https://${url.host.toLowerCase()}`;
}

/** Activity kind for the "Sent by … via F5 Agent Bridge" row. */
export const AGENT_BRIDGE_TURN_SUBMITTED_ACTIVITY_KIND = "agent-bridge.turn-submitted";

export const AgentBridgeRemoteSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  /** 0 means unset. The remote listener needs a fixed port the user tunnels. */
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })).pipe(
    Schema.withDecodingDefault(() => 0),
  ),
  /** Canonical https origin: lowercase host, no path, no trailing slash. */
  publicBaseUrl: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  /** Exact redirect URIs accepted for OAuth clients. */
  allowedRedirectUris: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMaxLength(20))
    .pipe(Schema.withDecodingDefault(() => [AGENT_BRIDGE_CHATGPT_REDIRECT_URI])),
  trustedClientMetadataHosts: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMaxLength(20))
    .pipe(Schema.withDecodingDefault(() => ["chatgpt.com"])),
});
export type AgentBridgeRemoteSettings = typeof AgentBridgeRemoteSettings.Type;

export const AgentBridgeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  /** No project is visible to any agent until it is listed here. */
  exposedProjectIds: Schema.Array(ProjectId)
    .check(Schema.isMaxLength(200))
    .pipe(Schema.withDecodingDefault(() => [])),
  remote: AgentBridgeRemoteSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type AgentBridgeSettings = typeof AgentBridgeSettings.Type;

export const AgentBridgeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  exposedProjectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(200))),
  remote: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
      publicBaseUrl: Schema.optionalKey(Schema.String),
      allowedRedirectUris: Schema.optionalKey(
        Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
      ),
      trustedClientMetadataHosts: Schema.optionalKey(
        Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
      ),
    }),
  ),
});
export type AgentBridgeSettingsPatch = typeof AgentBridgeSettingsPatch.Type;

export const AgentBridgeClientKind = Schema.Literals(["local", "cimd", "dcr"]);
export type AgentBridgeClientKind = typeof AgentBridgeClientKind.Type;

/**
 * Whether a remote client will hear about new work. Authentication alone is
 * never "ready": that needs an active event subscription.
 */
export const AgentBridgeClientReadiness = Schema.Literals([
  "linked",
  "awaiting-subscription",
  "ready",
  "expired",
  "delivery-failed",
]);
export type AgentBridgeClientReadiness = typeof AgentBridgeClientReadiness.Type;

export const AgentBridgeClient = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentBridgeClientKind,
  name: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  scopes: Schema.Array(AgentBridgeScope),
  /** Effective projects: the client's allowlist intersected with the exposed projects. */
  projectIds: Schema.Array(ProjectId),
  grantGeneration: NonNegativeInt,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  /** Host of a URL client id (client metadata document). */
  clientIdHost: Schema.NullOr(Schema.String),
  /** Hosts of the registered redirect URIs. */
  callbackHosts: Schema.Array(Schema.String),
  /** Null for the local client, which has no notifications. */
  readiness: Schema.NullOr(AgentBridgeClientReadiness),
});
export type AgentBridgeClient = typeof AgentBridgeClient.Type;

export const AgentBridgeListenerStatus = Schema.Literals(["stopped", "running", "failed"]);
export type AgentBridgeListenerStatus = typeof AgentBridgeListenerStatus.Type;

export const AgentBridgeListenerState = Schema.Struct({
  status: AgentBridgeListenerStatus,
  port: Schema.NullOr(NonNegativeInt),
  detail: Schema.NullOr(Schema.String),
});
export type AgentBridgeListenerState = typeof AgentBridgeListenerState.Type;

/** Values to paste into an MCP client's STDIO server form. F5 never writes that config. */
export const AgentBridgeStdioSetup = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
export type AgentBridgeStdioSetup = typeof AgentBridgeStdioSetup.Type;

/** An OAuth authorization request waiting for a decision in F5. */
export const AgentBridgePendingAuthorization = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  clientName: Schema.String,
  clientKind: AgentBridgeClientKind,
  redirectUri: Schema.String,
  requestedScopes: Schema.Array(AgentBridgeScope),
  /** Also shown on the browser page; confirm they match before approving. */
  matchCode: Schema.String,
  createdAt: IsoDateTime,
});
export type AgentBridgePendingAuthorization = typeof AgentBridgePendingAuthorization.Type;

export const AgentBridgePairingState = Schema.Struct({
  /** Authorization requests are accepted until this time; null when closed. */
  openUntil: Schema.NullOr(IsoDateTime),
  pending: Schema.NullOr(AgentBridgePendingAuthorization),
});
export type AgentBridgePairingState = typeof AgentBridgePairingState.Type;

export const AgentBridgeState = Schema.Struct({
  revision: NonNegativeInt,
  enabled: Schema.Boolean,
  local: AgentBridgeListenerState,
  remote: Schema.Struct({
    ...AgentBridgeListenerState.fields,
    /** The OAuth issuer (the canonical public base URL) while the listener runs. */
    issuer: Schema.NullOr(Schema.String),
  }),
  pairing: AgentBridgePairingState,
  stdio: Schema.Struct({
    /** Present when this server runs inside the desktop app. */
    desktop: Schema.NullOr(AgentBridgeStdioSetup),
    cli: AgentBridgeStdioSetup,
  }),
  clients: Schema.Array(AgentBridgeClient),
});
export type AgentBridgeState = typeof AgentBridgeState.Type;

export const AgentBridgeStateChanged = Schema.Struct({
  revision: NonNegativeInt,
  affectedIds: Schema.Array(Schema.String),
});
export type AgentBridgeStateChanged = typeof AgentBridgeStateChanged.Type;

export const AgentBridgeGetStateInput = Schema.Struct({});
export type AgentBridgeGetStateInput = typeof AgentBridgeGetStateInput.Type;

export const AgentBridgeOpenPairingWindowInput = Schema.Struct({});
export type AgentBridgeOpenPairingWindowInput = typeof AgentBridgeOpenPairingWindowInput.Type;

export const AgentBridgeDecideAuthorizationInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  approve: Schema.Boolean,
  /** Granted scopes are the requested scopes intersected with these. */
  scopes: Schema.Array(AgentBridgeScope),
  /** Must be a subset of the exposed projects. */
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(200)),
});
export type AgentBridgeDecideAuthorizationInput = typeof AgentBridgeDecideAuthorizationInput.Type;

export const AgentBridgeUpdateClientGrantInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  scopes: Schema.Array(AgentBridgeScope),
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(200)),
});
export type AgentBridgeUpdateClientGrantInput = typeof AgentBridgeUpdateClientGrantInput.Type;

export const AgentBridgeRevokeClientInput = Schema.Struct({ clientId: TrimmedNonEmptyString });
export type AgentBridgeRevokeClientInput = typeof AgentBridgeRevokeClientInput.Type;

/** Re-sends a backlog notification (queued tasks and unanswered updates) to a client. */
export const AgentBridgeRetryNotificationInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
});
export type AgentBridgeRetryNotificationInput = typeof AgentBridgeRetryNotificationInput.Type;

// ── Task board (F5 → agent) ──────────────────────────────────────────

/** Progress, questions, replies, and results are capped at 32 KiB each; summaries at 1 KiB. */
export const BOT_TASK_CONTENT_MAX_BYTES = 32 * 1024;
export const BOT_TASK_SUMMARY_MAX_BYTES = 1024;
export const BOT_TASK_TITLE_MAX_CHARS = 200;
export const BOT_TASK_INSTRUCTIONS_MAX_CHARS = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
export const BOT_TASK_PAGE_SIZE = 50;
/** Progress-only history is pruned after this many days; everything else is kept. */
export const BOT_TASK_PROGRESS_RETENTION_DAYS = 30;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const maxBytes = (limit: number) =>
  Schema.makeFilter((value: string) => utf8Bytes(value) <= limit || `At most ${limit} bytes.`);
export const BotTaskContent = Schema.String.check(
  Schema.isMinLength(1),
  maxBytes(BOT_TASK_CONTENT_MAX_BYTES),
);
export const BotTaskSummary = Schema.String.check(
  Schema.isMinLength(1),
  maxBytes(BOT_TASK_SUMMARY_MAX_BYTES),
);

export const BOT_TASK_STATUSES = [
  "queued",
  "running",
  "waiting-for-user",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export const BotTaskStatus = Schema.Literals(BOT_TASK_STATUSES);
export type BotTaskStatus = typeof BotTaskStatus.Type;
export const BOT_TASK_TERMINAL_STATUSES: ReadonlySet<BotTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const BotTaskQuestion = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  text: Schema.String,
  askedAt: IsoDateTime,
});
export type BotTaskQuestion = typeof BotTaskQuestion.Type;

export const BotTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  clientName: Schema.String,
  projectId: ProjectId,
  sourceThreadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  instructions: Schema.String,
  status: BotTaskStatus,
  /** Increments on every change; operator controls send the version they saw. */
  version: NonNegativeInt,
  /** Increments on claim, pause, cancel, and grant changes; bot writes must carry the current one. */
  executionEpoch: NonNegativeInt,
  latestProgress: Schema.NullOr(Schema.String),
  pendingQuestion: Schema.NullOr(BotTaskQuestion),
  result: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Last time the bot touched this task; only a freshness indicator. */
  lastContactAt: Schema.NullOr(IsoDateTime),
  revision: NonNegativeInt,
});
export type BotTask = typeof BotTask.Type;

export const BotTaskActivityType = Schema.Literals([
  "created",
  "claimed",
  "progress",
  "question",
  "reply",
  "question-withdrawn",
  "paused",
  "resumed",
  "cancelled",
  "completed",
  "failed",
]);
export type BotTaskActivityType = typeof BotTaskActivityType.Type;

export const BotTaskActivity = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  sequence: PositiveInt,
  revision: NonNegativeInt,
  type: BotTaskActivityType,
  actor: Schema.Literals(["bot", "operator"]),
  content: Schema.NullOr(Schema.String),
  operationId: Schema.String,
  questionId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type BotTaskActivity = typeof BotTaskActivity.Type;

const OperationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/u),
);

export const AgentBridgeGetTasksInput = Schema.Struct({
  clientId: Schema.optional(TrimmedNonEmptyString),
  statuses: Schema.optional(Schema.Array(BotTaskStatus)),
  /** Opaque cursor from the previous page. */
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BOT_TASK_PAGE_SIZE })),
  ),
});
export type AgentBridgeGetTasksInput = typeof AgentBridgeGetTasksInput.Type;

export const AgentBridgeGetTasksResult = Schema.Struct({
  revision: NonNegativeInt,
  tasks: Schema.Array(BotTask),
  nextCursor: Schema.NullOr(Schema.String),
});
export type AgentBridgeGetTasksResult = typeof AgentBridgeGetTasksResult.Type;

export const AgentBridgeTaskInput = Schema.Struct({ taskId: TrimmedNonEmptyString });
export type AgentBridgeTaskInput = typeof AgentBridgeTaskInput.Type;

export const AgentBridgeGetTaskActivitiesInput = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  /** Entries before this sequence, newest first. */
  beforeSequence: Schema.optional(PositiveInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type AgentBridgeGetTaskActivitiesInput = typeof AgentBridgeGetTaskActivitiesInput.Type;

export const AgentBridgeGetTaskActivitiesResult = Schema.Struct({
  activities: Schema.Array(BotTaskActivity),
  hasOlder: Schema.Boolean,
  /** Progress entries older than this were pruned. */
  progressPrunedBefore: IsoDateTime,
});
export type AgentBridgeGetTaskActivitiesResult = typeof AgentBridgeGetTaskActivitiesResult.Type;

export const AgentBridgeCreateTaskInput = Schema.Struct({
  operationId: OperationId,
  clientId: TrimmedNonEmptyString,
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BOT_TASK_TITLE_MAX_CHARS)),
  instructions: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BOT_TASK_INSTRUCTIONS_MAX_CHARS),
  ),
  sourceThreadId: Schema.optional(ThreadId),
});
export type AgentBridgeCreateTaskInput = typeof AgentBridgeCreateTaskInput.Type;

export const AgentBridgeReplyToTaskInput = Schema.Struct({
  operationId: OperationId,
  taskId: TrimmedNonEmptyString,
  questionId: TrimmedNonEmptyString,
  expectedVersion: NonNegativeInt,
  text: BotTaskContent,
});
export type AgentBridgeReplyToTaskInput = typeof AgentBridgeReplyToTaskInput.Type;

export const AgentBridgeTaskControlInput = Schema.Struct({
  operationId: OperationId,
  taskId: TrimmedNonEmptyString,
  expectedVersion: Schema.optional(NonNegativeInt),
});
export type AgentBridgeTaskControlInput = typeof AgentBridgeTaskControlInput.Type;
