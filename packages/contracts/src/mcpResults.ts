import { Schema } from "effect";
import { ProviderInstanceId } from "./providerInstance";
import { ProviderKind } from "./orchestration";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  SignInUrl,
} from "./baseSchemas";
import { ServerProviderAuthStatus } from "./server";
import {
  McpConnectionScope,
  McpServerDefinition,
  McpProjectServersConfig,
  McpServerTransportType,
} from "./mcpServer";
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

export const McpHubServerState = Schema.Literals([
  "idle",
  "connecting",
  "ready",
  "retrying",
  "failed",
  "needs-auth",
  "stopped",
]);
export type McpHubServerState = typeof McpHubServerState.Type;

/** One upstream connection owned by F5's MCP hub. */
export const McpHubServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  connectionScope: McpConnectionScope,
  transport: McpServerTransportType,
  state: McpHubServerState,
  error: Schema.optional(TrimmedNonEmptyString),
  serverInfo: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.String })),
  protocolVersion: Schema.optional(TrimmedNonEmptyString),
  toolCount: Schema.optional(NonNegativeInt),
  resourceCount: Schema.optional(NonNegativeInt),
  promptCount: Schema.optional(NonNegativeInt),
  latencyMs: Schema.optional(NonNegativeInt),
  lastConnectedAt: Schema.optional(IsoDateTime),
  /** Failed connection attempts since the last success. */
  attempts: NonNegativeInt,
  /** Provider session endpoints currently routed to this connection. */
  attachedSessions: NonNegativeInt,
  projectIds: Schema.Array(ProjectId),
  providers: Schema.Array(ProviderKind),
});
export type McpHubServerStatus = typeof McpHubServerStatus.Type;

export const McpGetHubStatusResult = Schema.Struct({
  servers: Schema.Array(McpHubServerStatus),
});
export type McpGetHubStatusResult = typeof McpGetHubStatusResult.Type;

export const McpReconnectHubServerResult = Schema.Struct({
  reconnected: NonNegativeInt,
});
export type McpReconnectHubServerResult = typeof McpReconnectHubServerResult.Type;

export const McpHubSignInAttempt = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  /** Open this in a browser; F5 never opens it on its own. */
  authorizationUrl: TrimmedNonEmptyString,
  redirectUrl: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
});
export type McpHubSignInAttempt = typeof McpHubSignInAttempt.Type;

/** OAuth state of one remote server; tokens are shared by every project with the same URL. */
export const McpHubAuthServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  signedIn: Schema.Boolean,
  /** F5 can renew the access token without a new sign-in. */
  refreshable: Schema.Boolean,
  expiresAt: Schema.optional(IsoDateTime),
  pending: Schema.optional(McpHubSignInAttempt),
});
export type McpHubAuthServerStatus = typeof McpHubAuthServerStatus.Type;

export const McpGetHubAuthStatusResult = Schema.Struct({
  servers: Schema.Array(McpHubAuthServerStatus),
});
export type McpGetHubAuthStatusResult = typeof McpGetHubAuthStatusResult.Type;

export const McpStartHubSignInResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signed-in") }),
  Schema.Struct({ status: Schema.Literal("pending"), attempt: McpHubSignInAttempt }),
]);
export type McpStartHubSignInResult = typeof McpStartHubSignInResult.Type;

export const McpCompleteHubSignInResult = Schema.Struct({
  status: Schema.Literal("signed-in"),
  serverName: TrimmedNonEmptyString,
  /** Hub connections reconnected with the new tokens. */
  reconnected: NonNegativeInt,
});
export type McpCompleteHubSignInResult = typeof McpCompleteHubSignInResult.Type;

export const McpSignOutHubServerResult = Schema.Struct({
  signedOut: Schema.Boolean,
});
export type McpSignOutHubServerResult = typeof McpSignOutHubServerResult.Type;

/**
 * `pinned`: matches the accepted definition. `new`: first seen after the server's
 * first listing. `changed`: the name, description or input schema differs from the
 * accepted one, so calls ask until the change is accepted.
 */
export const McpToolPinState = Schema.Literals(["pinned", "new", "changed"]);
export type McpToolPinState = typeof McpToolPinState.Type;

export const McpToolPin = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  /** Which definition of the server (URL or command) the pin belongs to; opaque. */
  identity: TrimmedNonEmptyString,
  /** The server's URL without query, or its command, for telling identities apart. */
  identityLabel: Schema.String,
  toolName: TrimmedNonEmptyString,
  state: McpToolPinState,
  firstSeenAt: IsoDateTime,
  acceptedAt: Schema.optional(IsoDateTime),
  /** Pretty-printed JSON of the accepted description and input schema. */
  accepted: Schema.String,
  /** The definition the server reports now, when it differs from `accepted`. */
  observed: Schema.optional(Schema.String),
});
export type McpToolPin = typeof McpToolPin.Type;

export const McpListToolPinsResult = Schema.Struct({
  tools: Schema.Array(McpToolPin),
});
export type McpListToolPinsResult = typeof McpListToolPinsResult.Type;

export const McpAcceptToolChangesResult = Schema.Struct({
  accepted: NonNegativeInt,
});
export type McpAcceptToolChangesResult = typeof McpAcceptToolChangesResult.Type;

export const McpToolCallOutcome = Schema.Literals([
  "ok",
  "error",
  "declined",
  "blocked",
  "cancelled",
  "turned-off",
]);
export type McpToolCallOutcome = typeof McpToolCallOutcome.Type;

/** How a call was let through: the tool's Allow policy, the user's answer, or an earlier answer. */
export const McpToolCallApproval = Schema.Literals(["policy", "asked", "session"]);
export type McpToolCallApproval = typeof McpToolCallApproval.Type;

/** One tool call through F5's hub. Arguments and results are never stored. */
export const McpToolCallRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  threadId: ThreadId,
  provider: ProviderKind,
  serverName: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  outcome: McpToolCallOutcome,
  durationMs: NonNegativeInt,
  approval: McpToolCallApproval,
  errorSummary: Schema.optional(Schema.String),
});
export type McpToolCallRecord = typeof McpToolCallRecord.Type;

export const McpActivitySummary = Schema.Struct({
  /** Calls in the last 24 hours. */
  calls: NonNegativeInt,
  errors: NonNegativeInt,
  p50Ms: Schema.optional(NonNegativeInt),
  p95Ms: Schema.optional(NonNegativeInt),
});
export type McpActivitySummary = typeof McpActivitySummary.Type;

export const McpListActivityResult = Schema.Struct({
  calls: Schema.Array(McpToolCallRecord),
  last24h: McpActivitySummary,
  /** Redacted stderr of the server's live stdio connections, when one server was asked for. */
  stderrTail: Schema.optional(Schema.String),
});
export type McpListActivityResult = typeof McpListActivityResult.Type;

export const McpThreadServersResult = Schema.Struct({
  /** Hub servers turned off for this conversation. */
  disabledServers: Schema.Array(TrimmedNonEmptyString),
});
export type McpThreadServersResult = typeof McpThreadServersResult.Type;

/** An environment variable or header a catalog entry asks for. */
export const McpCatalogInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  secret: Schema.Boolean,
  /** A fixed value the entry sets, which may contain `{placeholders}`. */
  value: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
});
export type McpCatalogInput = typeof McpCatalogInput.Type;

export const McpCatalogArgument = Schema.Struct({
  type: Schema.Literals(["positional", "named"]),
  name: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
  valueHint: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  /** A flag that takes no value, such as `--read-only`. */
  flag: Schema.Boolean,
});
export type McpCatalogArgument = typeof McpCatalogArgument.Type;

export const McpCatalogRemote = Schema.Struct({
  type: Schema.Literals(["http", "sse"]),
  url: TrimmedNonEmptyString,
  headers: Schema.Array(McpCatalogInput),
});
export type McpCatalogRemote = typeof McpCatalogRemote.Type;

/** A package F5 can run over stdio. */
export const McpCatalogPackage = Schema.Struct({
  registryType: Schema.Literals(["npm", "pypi", "oci"]),
  identifier: TrimmedNonEmptyString,
  version: Schema.optional(Schema.String),
  environmentVariables: Schema.Array(McpCatalogInput),
  packageArguments: Schema.Array(McpCatalogArgument),
  runtimeArguments: Schema.Array(McpCatalogArgument),
});
export type McpCatalogPackage = typeof McpCatalogPackage.Type;

export const McpCatalogEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  websiteUrl: Schema.optional(Schema.String),
  repositoryUrl: Schema.optional(Schema.String),
  remotes: Schema.Array(McpCatalogRemote),
  packages: Schema.Array(McpCatalogPackage),
});
export type McpCatalogEntry = typeof McpCatalogEntry.Type;

export const McpSearchCatalogResult = Schema.Struct({
  entries: Schema.Array(McpCatalogEntry),
  nextCursor: Schema.optional(Schema.String),
});
export type McpSearchCatalogResult = typeof McpSearchCatalogResult.Type;

export const McpComposerPromptArgument = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type McpComposerPromptArgument = typeof McpComposerPromptArgument.Type;

export const McpComposerPrompt = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  arguments: Schema.Array(McpComposerPromptArgument),
});
export type McpComposerPrompt = typeof McpComposerPrompt.Type;

/** One server's prompts, or why they could not be listed. */
export const McpComposerServerPrompts = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  prompts: Schema.Array(McpComposerPrompt),
  error: Schema.optional(Schema.String),
});
export type McpComposerServerPrompts = typeof McpComposerServerPrompts.Type;

export const McpListComposerPromptsResult = Schema.Struct({
  servers: Schema.Array(McpComposerServerPrompts),
});
export type McpListComposerPromptsResult = typeof McpListComposerPromptsResult.Type;

export const McpGetComposerPromptResult = Schema.Struct({
  /** The prompt's messages as text, for the user to review in the composer. */
  text: Schema.String,
  /** Images, audio and binary resources in the prompt, which the composer cannot hold. */
  omitted: NonNegativeInt,
});
export type McpGetComposerPromptResult = typeof McpGetComposerPromptResult.Type;

export const McpCompleteComposerPromptResult = Schema.Struct({
  values: Schema.Array(Schema.String),
});
export type McpCompleteComposerPromptResult = typeof McpCompleteComposerPromptResult.Type;

export const McpComposerResource = Schema.Struct({
  uri: TrimmedNonEmptyString,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
});
export type McpComposerResource = typeof McpComposerResource.Type;

export const McpComposerServerResources = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  resources: Schema.Array(McpComposerResource),
  /** True when the server has more than the composer lists. */
  truncated: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type McpComposerServerResources = typeof McpComposerServerResources.Type;

export const McpListComposerResourcesResult = Schema.Struct({
  servers: Schema.Array(McpComposerServerResources),
});
export type McpListComposerResourcesResult = typeof McpListComposerResourcesResult.Type;

export const McpComposerResourceContent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    text: Schema.String,
    /** The text was cut to fit the message's resource budget. */
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    uri: Schema.String,
    mimeType: TrimmedNonEmptyString,
    /** Base64, as the server sent it. */
    data: Schema.String,
  }),
]);
export type McpComposerResourceContent = typeof McpComposerResourceContent.Type;

export const McpReadComposerResourceResult = Schema.Struct({
  contents: Schema.Array(McpComposerResourceContent),
  /** Binary parts other than images, which are left out. */
  omitted: NonNegativeInt,
});
export type McpReadComposerResourceResult = typeof McpReadComposerResourceResult.Type;

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
  authorizationUrl: Schema.optional(SignInUrl),
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
  authorizationUrl: Schema.optional(SignInUrl),
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
