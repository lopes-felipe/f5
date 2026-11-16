import { McpConfigScope } from "./mcpConfigScope";
export * from "./mcpConfigScope";
export * from "./mcpResults";
import { ProviderInstanceId } from "./providerInstance";
import { Schema } from "effect";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { McpServerDefinition, McpProjectServersConfig } from "./mcpServer";

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
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpGetProviderStatusRequest = typeof McpGetProviderStatusRequest.Type;

export const McpGetServerStatusesRequest = Schema.Struct({
  ...McpGetProviderStatusRequest.fields,
  threadId: Schema.optional(ThreadId),
});

export type McpGetServerStatusesRequest = typeof McpGetServerStatusesRequest.Type;

export const McpCodexEnvironmentOptions = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpCodexEnvironmentOptions = typeof McpCodexEnvironmentOptions.Type;

export const McpGetCodexStatusRequest = Schema.Struct({
  projectId: ProjectId,
  instanceId: Schema.optional(ProviderInstanceId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpGetCodexStatusRequest = typeof McpGetCodexStatusRequest.Type;

export const McpReloadProjectRequest = McpGetCodexStatusRequest;
export type McpReloadProjectRequest = typeof McpReloadProjectRequest.Type;

export const McpApplyToLiveSessionsRequest = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  instanceId: Schema.optional(ProviderInstanceId),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  retryUnchanged: Schema.optional(Schema.Boolean),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpApplyToLiveSessionsRequest = typeof McpApplyToLiveSessionsRequest.Type;

export const McpStartLoginRequest = Schema.Struct({
  provider: ProviderKind,
  projectId: ProjectId,
  serverName: Schema.optional(TrimmedNonEmptyString),
  instanceId: Schema.optional(ProviderInstanceId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  /** Running conversation that performs a session-routed sign-in (Claude). */
  threadId: Schema.optional(ThreadId),
});
export type McpStartLoginRequest = typeof McpStartLoginRequest.Type;

export const McpGetLoginStatusRequest = McpStartLoginRequest;
export type McpGetLoginStatusRequest = typeof McpGetLoginStatusRequest.Type;

export const McpStartOauthLoginRequest = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  instanceId: Schema.optional(ProviderInstanceId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpStartOauthLoginRequest = typeof McpStartOauthLoginRequest.Type;

export const McpOauthLoginStatusRequest = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  instanceId: Schema.optional(ProviderInstanceId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpOauthLoginStatusRequest = typeof McpOauthLoginStatusRequest.Type;

export const McpStatusUpdatedReason = Schema.Literals([
  "updated",
  "reloaded",
  "applied",
  "oauth-completed",
  "login-completed",
  "runtime",
]);
export type McpStatusUpdatedReason = typeof McpStatusUpdatedReason.Type;

export const McpStatusUpdatedPayload = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  provider: Schema.optional(ProviderKind),
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  reason: McpStatusUpdatedReason,
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

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

export const McpListImportCandidatesRequest = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  instanceId: Schema.optional(ProviderInstanceId),
});
export type McpListImportCandidatesRequest = typeof McpListImportCandidatesRequest.Type;
export const McpProbeServerRequest = Schema.Struct({
  ...McpListImportCandidatesRequest.fields,
  serverName: TrimmedNonEmptyString,
  server: McpServerDefinition,
});
export type McpProbeServerRequest = typeof McpProbeServerRequest.Type;
export const McpStoreSecretRequest = Schema.Struct({
  value: Schema.String.check(Schema.isMaxLength(16384)),
});
export type McpStoreSecretRequest = typeof McpStoreSecretRequest.Type;
