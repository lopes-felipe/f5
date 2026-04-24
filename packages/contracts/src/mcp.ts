import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { McpProjectServersConfig } from "./mcpServer";

export const McpConfigScope = Schema.Literals(["common", "project"]);
export type McpConfigScope = typeof McpConfigScope.Type;

export const McpCommonConfigResult = Schema.Struct({
  version: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
});
export type McpCommonConfigResult = typeof McpCommonConfigResult.Type;

export const McpProjectConfigResult = Schema.Struct({
  projectId: ProjectId,
  version: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
});
export type McpProjectConfigResult = typeof McpProjectConfigResult.Type;

export const McpEffectiveConfigResult = Schema.Struct({
  projectId: ProjectId,
  commonVersion: Schema.optional(TrimmedNonEmptyString),
  projectVersion: Schema.optional(TrimmedNonEmptyString),
  effectiveVersion: TrimmedNonEmptyString,
  servers: McpProjectServersConfig,
});
export type McpEffectiveConfigResult = typeof McpEffectiveConfigResult.Type;

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
  projectId: ProjectId,
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
  servers: McpProjectServersConfig,
});
export type McpReplaceProjectConfigRequest = typeof McpReplaceProjectConfigRequest.Type;

export const McpGetEffectiveConfigRequest = Schema.Struct({
  projectId: ProjectId,
});
export type McpGetEffectiveConfigRequest = typeof McpGetEffectiveConfigRequest.Type;

export const McpProjectStatusSupport = Schema.Literals(["supported", "unsupported", "unavailable"]);
export type McpProjectStatusSupport = typeof McpProjectStatusSupport.Type;

export const McpCodexEnvironmentOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpCodexEnvironmentOptions = typeof McpCodexEnvironmentOptions.Type;

export const McpGetCodexStatusRequest = Schema.Struct({
  projectId: ProjectId,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpGetCodexStatusRequest = typeof McpGetCodexStatusRequest.Type;

export const McpCodexStatusResult = Schema.Struct({
  projectId: ProjectId,
  support: McpProjectStatusSupport,
  supportMessage: Schema.optional(TrimmedNonEmptyString),
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpCodexStatusResult = typeof McpCodexStatusResult.Type;

export const McpReloadProjectRequest = McpGetCodexStatusRequest;
export type McpReloadProjectRequest = typeof McpReloadProjectRequest.Type;

export const McpApplyToLiveSessionsRequest = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpApplyToLiveSessionsRequest = typeof McpApplyToLiveSessionsRequest.Type;

export const McpApplyToLiveSessionsResult = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  codexReloaded: NonNegativeInt,
  claudeRestarted: NonNegativeInt,
  skipped: NonNegativeInt,
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpApplyToLiveSessionsResult = typeof McpApplyToLiveSessionsResult.Type;

export const McpStartOauthLoginRequest = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpStartOauthLoginRequest = typeof McpStartOauthLoginRequest.Type;

export const McpOauthLoginStatusRequest = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type McpOauthLoginStatusRequest = typeof McpOauthLoginStatusRequest.Type;

export const McpOauthLoginStatus = Schema.Literals(["idle", "pending", "completed", "failed"]);
export type McpOauthLoginStatus = typeof McpOauthLoginStatus.Type;

export const McpOauthLoginStatusResult = Schema.Struct({
  projectId: ProjectId,
  serverName: TrimmedNonEmptyString,
  status: McpOauthLoginStatus,
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type McpOauthLoginStatusResult = typeof McpOauthLoginStatusResult.Type;

export const McpStatusUpdatedReason = Schema.Literals([
  "updated",
  "reloaded",
  "applied",
  "oauth-completed",
]);
export type McpStatusUpdatedReason = typeof McpStatusUpdatedReason.Type;

export const McpStatusUpdatedPayload = Schema.Struct({
  provider: Schema.optional(ProviderKind),
  scope: McpConfigScope,
  projectId: Schema.optional(ProjectId),
  reason: McpStatusUpdatedReason,
  configVersion: Schema.optional(TrimmedNonEmptyString),
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;
