import { McpConfigScope } from "./mcpConfigScope";
export * from "./mcpConfigScope";
export * from "./mcpResults";
import { ProviderInstanceId } from "./providerInstance";
import { Schema } from "effect";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { McpServerDefinition, McpProjectServersConfig } from "./mcpServer";

// Account-scoped requests select a provider instance; the server resolves its
// executable and home. Client-supplied paths are rejected on the wire.

export const McpGetCommonConfigRequest = Schema.Struct({});
export type McpGetCommonConfigRequest = typeof McpGetCommonConfigRequest.Type;

export const McpReplaceCommonConfigRequest = Schema.Struct({
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
});
export type McpReplaceCommonConfigRequest = typeof McpReplaceCommonConfigRequest.Type;

export const McpGetProjectConfigRequest = Schema.Struct({
  projectId: ProjectId,
});
export type McpGetProjectConfigRequest = typeof McpGetProjectConfigRequest.Type;

export const McpReplaceProjectConfigRequest = Schema.Struct({
  disabledCommonServers: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  projectId: ProjectId,
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
});
export type McpReplaceProjectConfigRequest = typeof McpReplaceProjectConfigRequest.Type;

export const McpGetEffectiveConfigRequest = Schema.Struct({
  projectId: ProjectId,
});
export type McpGetEffectiveConfigRequest = typeof McpGetEffectiveConfigRequest.Type;

export const McpGetProviderStatusRequest = Schema.Struct({
  provider: ProviderKind,
  projectId: ProjectId,
  instanceId: Schema.optional(ProviderInstanceId),
});
export type McpGetProviderStatusRequest = typeof McpGetProviderStatusRequest.Type;

export const McpGetServerStatusesRequest = Schema.Struct({
  ...McpGetProviderStatusRequest.fields,
  threadId: Schema.optional(ThreadId),
});

export type McpGetServerStatusesRequest = typeof McpGetServerStatusesRequest.Type;

export const McpApplyToLiveSessionsRequest = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  instanceId: Schema.optional(ProviderInstanceId),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  retryUnchanged: Schema.optional(Schema.Boolean),
});
export type McpApplyToLiveSessionsRequest = typeof McpApplyToLiveSessionsRequest.Type;

export const McpStartLoginRequest = Schema.Struct({
  provider: ProviderKind,
  projectId: ProjectId,
  serverName: Schema.optional(TrimmedNonEmptyString),
  instanceId: Schema.optional(ProviderInstanceId),
  /** Running conversation that performs a session-routed sign-in (Claude). */
  threadId: Schema.optional(ThreadId),
});
export type McpStartLoginRequest = typeof McpStartLoginRequest.Type;

export const McpGetLoginStatusRequest = McpStartLoginRequest;
export type McpGetLoginStatusRequest = typeof McpGetLoginStatusRequest.Type;

export const McpStatusUpdatedReason = Schema.Literals([
  "updated",
  "reloaded",
  "applied",
  "oauth-completed",
  "login-completed",
  "runtime",
  /** An MCP hub connection or sign-in changed; only hub status and sign-in queries need a refresh. */
  "hub",
]);
export type McpStatusUpdatedReason = typeof McpStatusUpdatedReason.Type;

export const McpStatusUpdatedPayload = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  provider: Schema.optional(ProviderKind),
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  reason: McpStatusUpdatedReason,
  configVersion: Schema.optional(TrimmedNonEmptyString),
  serverName: Schema.optional(TrimmedNonEmptyString),
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

export const McpGetHubStatusRequest = Schema.Struct({
  /** Limits the result to connections serving this project. */
  projectId: Schema.optional(ProjectId),
});
export type McpGetHubStatusRequest = typeof McpGetHubStatusRequest.Type;

export const McpReconnectHubServerRequest = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type McpReconnectHubServerRequest = typeof McpReconnectHubServerRequest.Type;

export const McpListToolPinsRequest = Schema.Struct({
  serverName: TrimmedNonEmptyString,
});
export type McpListToolPinsRequest = typeof McpListToolPinsRequest.Type;

/** Accepts the current definition of changed or new tools, or of every tool when none are named. */
export const McpAcceptToolChangesRequest = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  identity: TrimmedNonEmptyString,
  /**
   * The tools the user reviewed and the definition each showed. A tool whose current
   * definition differs (it changed again) is not accepted and counts as stale.
   */
  reviewed: Schema.Array(
    Schema.Struct({ toolName: TrimmedNonEmptyString, definition: Schema.String }),
  ),
});
export type McpAcceptToolChangesRequest = typeof McpAcceptToolChangesRequest.Type;

export const MCP_ACTIVITY_PAGE_LIMIT = 200;

export const McpListActivityRequest = Schema.Struct({
  serverName: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  /** Limits calls, the summary and the stderr tail to this project. */
  projectId: Schema.optional(ProjectId),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MCP_ACTIVITY_PAGE_LIMIT })),
  ),
});
export type McpListActivityRequest = typeof McpListActivityRequest.Type;

export const McpGetThreadServersRequest = Schema.Struct({
  threadId: ThreadId,
});
export type McpGetThreadServersRequest = typeof McpGetThreadServersRequest.Type;

/** Turns a hub server off (or back on) for one conversation; no provider restart. */
export const McpSetThreadServerEnabledRequest = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type McpSetThreadServerEnabledRequest = typeof McpSetThreadServerEnabledRequest.Type;

/** Servers from `<project root>/.mcp.json`, with whether each is approved. */
export const McpGetRepositoryServersRequest = Schema.Struct({
  projectId: ProjectId,
});
export type McpGetRepositoryServersRequest = typeof McpGetRepositoryServersRequest.Type;

/**
 * Approves or revokes one repository server. Approval names the definition hash the
 * user reviewed, so a file changed since then is refused rather than approved unseen.
 */
export const McpSetRepositoryServerTrustRequest = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  trusted: Schema.Boolean,
  definitionHash: Schema.optional(TrimmedNonEmptyString),
});
export type McpSetRepositoryServerTrustRequest = typeof McpSetRepositoryServerTrustRequest.Type;

/** Searches the official MCP Registry; only sent when the Catalog is opened or searched. */
export const McpSearchCatalogRequest = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** The `nextCursor` of the previous page. */
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type McpSearchCatalogRequest = typeof McpSearchCatalogRequest.Type;

/** Most resources the composer lists per server. */
export const MCP_COMPOSER_RESOURCE_LIMIT = 200;
/** Most text a resource adds to a message; longer text is cut with a note. */
export const MCP_COMPOSER_RESOURCE_TEXT_BYTES = 256 * 1024;

/** Prompts and resources come from the hub servers this conversation's session is using. */
export const McpListComposerPromptsRequest = Schema.Struct({
  threadId: ThreadId,
});
export type McpListComposerPromptsRequest = typeof McpListComposerPromptsRequest.Type;

export const McpGetComposerPromptRequest = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpGetComposerPromptRequest = typeof McpGetComposerPromptRequest.Type;

/** Server-side suggestions for one prompt argument, given what is typed so far. */
export const McpCompleteComposerPromptRequest = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  argument: TrimmedNonEmptyString,
  value: Schema.String,
  /** Arguments already filled, for servers whose suggestions depend on them. */
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpCompleteComposerPromptRequest = typeof McpCompleteComposerPromptRequest.Type;

export const McpListComposerResourcesRequest = Schema.Struct({
  threadId: ThreadId,
});
export type McpListComposerResourcesRequest = typeof McpListComposerResourcesRequest.Type;

export const McpReadComposerResourceRequest = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
  uri: TrimmedNonEmptyString,
});
export type McpReadComposerResourceRequest = typeof McpReadComposerResourceRequest.Type;

/** Without a project, common servers are listed and signed in. */
export const McpGetHubAuthStatusRequest = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type McpGetHubAuthStatusRequest = typeof McpGetHubAuthStatusRequest.Type;

export const McpStartHubSignInRequest = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type McpStartHubSignInRequest = typeof McpStartHubSignInRequest.Type;

export const McpCompleteHubSignInRequest = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  /** The address the browser was sent to after authorizing, pasted by the user. */
  redirectedUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
});
export type McpCompleteHubSignInRequest = typeof McpCompleteHubSignInRequest.Type;

export const McpSignOutHubServerRequest = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type McpSignOutHubServerRequest = typeof McpSignOutHubServerRequest.Type;

export const McpInspectServerRequest = Schema.Struct({
  ...McpGetServerStatusesRequest.fields,
  provider: Schema.optional(ProviderKind),
  serverName: TrimmedNonEmptyString,
  ownership: Schema.optional(Schema.Literals(["managed", "external", "built-in"])),
});
export type McpInspectServerRequest = typeof McpInspectServerRequest.Type;

export const McpReconnectServerRequest = Schema.Struct({
  ...McpGetProviderStatusRequest.fields,
  provider: Schema.optional(ProviderKind),
  serverName: TrimmedNonEmptyString,
  threadIds: Schema.optional(Schema.Array(ThreadId)),
});
export type McpReconnectServerRequest = typeof McpReconnectServerRequest.Type;

const McpAccountRequestFields = {
  projectId: Schema.optional(ProjectId),
  instanceId: Schema.optional(ProviderInstanceId),
};
export const McpListImportCandidatesRequest = Schema.Struct({
  ...McpAccountRequestFields,
  /**
   * In a separate profile, also read the user's own home folder. Its configuration can hold
   * keys the profile otherwise never sees, so it is read only when the user asks.
   */
  includeUserHome: Schema.optional(Schema.Boolean),
});
export type McpListImportCandidatesRequest = typeof McpListImportCandidatesRequest.Type;
export const McpProbeServerRequest = Schema.Struct({
  ...McpAccountRequestFields,
  serverName: TrimmedNonEmptyString,
  server: McpServerDefinition,
});
export type McpProbeServerRequest = typeof McpProbeServerRequest.Type;
export const McpStoreSecretRequest = Schema.Struct({
  value: Schema.String.check(Schema.isMaxLength(16384)),
});
export type McpStoreSecretRequest = typeof McpStoreSecretRequest.Type;
