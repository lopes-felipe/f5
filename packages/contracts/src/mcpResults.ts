import { Schema } from "effect";
import { ProviderInstanceId } from "./providerInstance";
import { ProviderKind } from "./orchestration";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ServerProviderAuthStatus } from "./server";
import { McpServerDefinition, McpProjectServersConfig } from "./mcpServer";
import { McpConfigScope } from "./mcpConfigScope";

// Responses are separate from startup request schemas so browser bundles can omit unused definitions.
export const McpProjectStatusSupport = Schema.Literals(["supported", "unsupported", "unavailable"]);
export type McpProjectStatusSupport = typeof McpProjectStatusSupport.Type;

/** Connection state reported by a provider session. */
export const McpObservedServerStatus = Schema.Literals([
  "connected",
  "pending",
  "needs-auth",
  "failed",
  "disabled",
  "unknown",
]);
export type McpObservedServerStatus = typeof McpObservedServerStatus.Type;

export const McpReloadServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: McpObservedServerStatus,
  /** True for servers F5 configured; settings-file and plugin servers are observed only. */
  owned: Schema.Boolean,
  error: Schema.optional(TrimmedNonEmptyString),
});
export type McpReloadServerStatus = typeof McpReloadServerStatus.Type;

export const McpReloadError = Schema.Struct({
  server: Schema.optional(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
});
export type McpReloadError = typeof McpReloadError.Type;

/** Applied configuration can be converged while servers are still starting or need sign-in. */
export const McpReloadResult = Schema.Struct({
  converged: Schema.Boolean,
  restartRequired: Schema.Boolean,
  servers: Schema.Array(McpReloadServerStatus),
  errors: Schema.Array(McpReloadError),
});
export type McpReloadResult = typeof McpReloadResult.Type;

export const McpLiveSessionReloadFailure = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  provider: ProviderKind,
  restartRequired: Schema.Boolean,
  errors: Schema.Array(McpReloadError),
});
export type McpLiveSessionReloadFailure = typeof McpLiveSessionReloadFailure.Type;

export const McpSessionReloadOutcome = Schema.Struct({
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  generation: NonNegativeInt,
  requestedVersion: Schema.String,
  attemptedVersion: Schema.String,
  disposition: Schema.Literals(["applied", "restart-required", "deferred", "failed", "superseded"]),
  result: McpReloadResult,
});
export type McpSessionReloadOutcome = typeof McpSessionReloadOutcome.Type;

export const McpConfigIssue = Schema.Struct({
  kind: Schema.Literals(["validation", "compatibility"]),
  message: Schema.String,
  serverName: Schema.optional(Schema.String),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
});
export type McpConfigIssue = typeof McpConfigIssue.Type;

export const McpCommonConfigResult = Schema.Struct({
  version: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
  issues: Schema.optional(Schema.Array(McpConfigIssue)),
});
export type McpCommonConfigResult = typeof McpCommonConfigResult.Type;

export const McpProjectConfigResult = Schema.Struct({
  disabledCommonServers: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  projectId: ProjectId,
  version: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
  issues: Schema.optional(Schema.Array(McpConfigIssue)),
});
export type McpProjectConfigResult = typeof McpProjectConfigResult.Type;

export const McpEffectiveConfigResult = Schema.Struct({
  projectId: ProjectId,
  commonVersion: Schema.optional(TrimmedNonEmptyString),
  projectVersion: Schema.optional(TrimmedNonEmptyString),
  effectiveVersion: TrimmedNonEmptyString,
  servers: McpProjectServersConfig,
  issues: Schema.optional(Schema.Array(McpConfigIssue)),
});
export type McpEffectiveConfigResult = typeof McpEffectiveConfigResult.Type;

export const McpProviderStatusResult = Schema.Struct({
  provider: ProviderKind,
  projectId: ProjectId,
  support: McpProjectStatusSupport,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  supportMessage: Schema.optional(TrimmedNonEmptyString),
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpProviderStatusResult = typeof McpProviderStatusResult.Type;

export const McpCodexStatusResult = Schema.Struct({
  projectId: ProjectId,
  support: McpProjectStatusSupport,
  supportMessage: Schema.optional(TrimmedNonEmptyString),
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpCodexStatusResult = typeof McpCodexStatusResult.Type;

export const McpApplyToLiveSessionsResult = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  sessions: Schema.optional(Schema.Array(McpSessionReloadOutcome)),
  codexReloaded: NonNegativeInt,
  claudeRestarted: NonNegativeInt,
  /** Claude sessions reconciled in place without a restart. */
  claudeReconciled: Schema.optional(NonNegativeInt),
  /** Busy sessions whose restart waits for the next idle turn boundary. */
  deferred: Schema.optional(NonNegativeInt),
  skipped: NonNegativeInt,
  failures: Schema.optional(Schema.Array(McpLiveSessionReloadFailure)),
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpApplyToLiveSessionsResult = typeof McpApplyToLiveSessionsResult.Type;

export const McpLoginTarget = Schema.Literals(["provider", "server"]);
export type McpLoginTarget = typeof McpLoginTarget.Type;

export const McpLoginMode = Schema.Literals(["oauth", "cli"]);
export type McpLoginMode = typeof McpLoginMode.Type;

export const McpLoginStatus = Schema.Literals(["idle", "pending", "completed", "failed"]);
export type McpLoginStatus = typeof McpLoginStatus.Type;

export const McpLoginStatusResult = Schema.Struct({
  target: McpLoginTarget,
  mode: McpLoginMode,
  provider: ProviderKind,
  projectId: ProjectId,
  serverName: Schema.optional(TrimmedNonEmptyString),
  status: McpLoginStatus,
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  message: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type McpLoginStatusResult = typeof McpLoginStatusResult.Type;

export const McpOauthLoginStatus = Schema.Literals(["idle", "pending", "completed", "failed"]);
export type McpOauthLoginStatus = typeof McpOauthLoginStatus.Type;

export const McpOauthLoginStatusResult = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  status: McpOauthLoginStatus,
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  message: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type McpOauthLoginStatusResult = typeof McpOauthLoginStatusResult.Type;

export const McpServerStatusState = Schema.Literals([
  "disabled",
  "ready",
  "starting",
  "login-required",
  "needs-auth",
  "failed",
  "unknown",
]);
export type McpServerStatusState = typeof McpServerStatusState.Type;

export const McpToolSummary = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  readOnly: Schema.optional(Schema.Boolean),
  destructive: Schema.optional(Schema.Boolean),
});
export type McpToolSummary = typeof McpToolSummary.Type;

export const McpServerStatusEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  state: McpServerStatusState,
  authStatus: ServerProviderAuthStatus,
  toolCount: NonNegativeInt,
  resourceCount: NonNegativeInt,
  resourceTemplateCount: NonNegativeInt,
  message: Schema.optional(TrimmedNonEmptyString),
  ownership: Schema.optional(Schema.Literals(["managed", "external", "built-in"])),
  origin: Schema.optional(Schema.String),
  desiredEnabled: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(McpToolSummary).check(Schema.isMaxLength(200))),
});
export type McpServerStatusEntry = typeof McpServerStatusEntry.Type;

export const McpSessionSummary = Schema.Struct({
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  generation: NonNegativeInt,
  lastSeenAt: IsoDateTime,
  busy: Schema.Boolean,
  appliedVersion: Schema.optional(Schema.String),
  unconvergedVersion: Schema.optional(Schema.String),
});
export type McpSessionSummary = typeof McpSessionSummary.Type;

export const McpObservationMetadata = {
  source: Schema.optional(Schema.Literals(["conversation", "configurationCheck"])),
  observedAt: Schema.optional(IsoDateTime),
  instanceId: Schema.optional(ProviderInstanceId),
  threadId: Schema.optional(ThreadId),
  generation: Schema.optional(NonNegativeInt),
  desiredVersion: Schema.optional(Schema.String),
  appliedVersion: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  complete: Schema.optional(Schema.Boolean),
  omissions: Schema.optional(Schema.Array(Schema.String)),
  sessions: Schema.optional(Schema.Array(McpSessionSummary)),
};

export const McpServerStatusesResult = Schema.Struct({
  ...McpObservationMetadata,
  provider: ProviderKind,
  projectId: ProjectId,
  support: McpProjectStatusSupport,
  supportMessage: Schema.optional(TrimmedNonEmptyString),
  configVersion: Schema.optional(TrimmedNonEmptyString),
  statuses: Schema.Array(McpServerStatusEntry),
});
export type McpServerStatusesResult = typeof McpServerStatusesResult.Type;

export const McpInspectorTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  annotations: Schema.optional(Schema.Unknown),
  inputSchema: Schema.optional(Schema.Unknown),
});

export const McpInspectServerResult = Schema.Struct({
  ...McpServerStatusesResult.fields,
  serverName: Schema.String,
  capabilities: Schema.Struct({
    tools: Schema.Boolean,
    inputSchemas: Schema.Boolean,
    resources: Schema.Boolean,
  }),
  tools: Schema.Array(McpInspectorTool),
  resources: Schema.Array(Schema.Unknown),
  resourceTemplates: Schema.Array(Schema.Unknown),
  diagnostics: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      message: Schema.optional(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  outcomes: Schema.optional(Schema.Array(McpSessionReloadOutcome)),
});
export type McpInspectServerResult = typeof McpInspectServerResult.Type;

export const McpReconnectServerResult = Schema.Struct({
  settingsConnectionReloaded: Schema.Boolean,
  sessionsMatched: NonNegativeInt,
  sessionsReconnected: NonNegativeInt,
  failures: Schema.Array(
    Schema.Struct({ threadId: Schema.optional(ThreadId), message: Schema.String }),
  ),
  sessions: Schema.optional(Schema.Array(McpSessionReloadOutcome)),
});
export type McpReconnectServerResult = typeof McpReconnectServerResult.Type;

export const McpImportIssue = Schema.Struct({
  serverName: Schema.optional(Schema.String),
  field: Schema.String,
  severity: Schema.Literals(["warning", "error"]),
  message: Schema.String,
});
export const McpImportCandidate = Schema.Struct({
  selectedByDefault: Schema.optional(Schema.Boolean),
  id: Schema.String,
  name: Schema.String,
  source: Schema.String,
  server: Schema.optional(McpServerDefinition),
  issues: Schema.Array(McpImportIssue),
});
export const McpListImportCandidatesResult = Schema.Struct({
  candidates: Schema.Array(McpImportCandidate),
  issues: Schema.Array(McpImportIssue),
});
export const McpProbeServerResult = Schema.Struct({
  ok: Schema.Boolean,
  durationMs: NonNegativeInt,
  serverInfo: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.String })),
  protocolVersion: Schema.optional(Schema.String),
  tools: Schema.Array(McpToolSummary),
  toolsTruncated: Schema.Boolean,
  resourceCount: NonNegativeInt,
  promptCount: NonNegativeInt,
  authRequired: Schema.Boolean,
  error: Schema.optional(Schema.String),
  stderrTail: Schema.optional(Schema.String),
});
export const McpStoreSecretResult = Schema.Struct({ placeholder: Schema.String });

export type McpImportIssue = typeof McpImportIssue.Type;
export type McpImportCandidate = typeof McpImportCandidate.Type;
export type McpListImportCandidatesResult = typeof McpListImportCandidatesResult.Type;
export type McpProbeServerResult = typeof McpProbeServerResult.Type;
export type McpStoreSecretResult = typeof McpStoreSecretResult.Type;
