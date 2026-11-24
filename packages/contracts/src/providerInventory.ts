import { Schema } from "effect";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";

/**
 * Where an inventory entry is configured. Ownership follows the catalog rules:
 * `project` entries live in repository files and are shared by every instance;
 * `local` (project-local, untracked) and `instance` (the instance's private
 * home/config dir) belong to one provider instance; `managed` comes from
 * administrator policy; `plugin` entries are contributed by an installed plugin.
 */
export const ProviderInventorySource = Schema.Literals([
  "project",
  "local",
  "instance",
  "managed",
  "plugin",
  "unknown",
]);
export type ProviderInventorySource = typeof ProviderInventorySource.Type;

const BoundedText = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

/**
 * Codex hook trust (`HookTrustStatus`). `modified` and `untrusted` hooks do not
 * run until the user approves their current contents; `managed` hooks come from
 * administrator policy and never need approval.
 */
export const ProviderInventoryHookTrustStatus = Schema.Literals([
  "managed",
  "trusted",
  "modified",
  "untrusted",
]);
export type ProviderInventoryHookTrustStatus = typeof ProviderInventoryHookTrustStatus.Type;

export const ProviderInventoryHook = Schema.Struct({
  environmentId: Schema.optional(BoundedText),
  event: BoundedText,
  matcher: Schema.optional(BoundedText),
  handlerType: Schema.optional(BoundedText),
  /** Program name only; arguments are omitted because they may carry secrets. */
  program: Schema.optional(BoundedText),
  source: ProviderInventorySource,
  sourcePath: Schema.optional(BoundedText),
  enabled: Schema.optional(Schema.Boolean),
  pluginId: Schema.optional(BoundedText),
  /** Provider-assigned hook identity; the handle a trust request names. */
  key: Schema.optional(BoundedText),
  /** Absent when the provider does not report trust (older Codex CLIs, Claude). */
  trustStatus: Schema.optional(ProviderInventoryHookTrustStatus),
});
export type ProviderInventoryHook = typeof ProviderInventoryHook.Type;

export const ProviderInventoryPlugin = Schema.Struct({
  id: BoundedText,
  name: BoundedText,
  version: Schema.optional(BoundedText),
  marketplace: Schema.optional(BoundedText),
  enabled: Schema.optional(Schema.Boolean),
  source: ProviderInventorySource,
  sourcePath: Schema.optional(BoundedText),
});
export type ProviderInventoryPlugin = typeof ProviderInventoryPlugin.Type;

export const ProviderInventoryConnector = Schema.Struct({
  name: BoundedText,
  /** stdio, http, sse, app, ... as reported by the provider. */
  kind: Schema.optional(BoundedText),
  enabled: Schema.optional(Schema.Boolean),
  status: Schema.optional(BoundedText),
  source: ProviderInventorySource,
  sourcePath: Schema.optional(BoundedText),
});
export type ProviderInventoryConnector = typeof ProviderInventoryConnector.Type;

export const ClaudeAgentMemoryScope = Schema.Literals(["user", "project", "local"]);
export type ClaudeAgentMemoryScope = typeof ClaudeAgentMemoryScope.Type;

export const ProviderInventoryAgent = Schema.Struct({
  name: BoundedText,
  description: Schema.optional(BoundedText),
  source: ProviderInventorySource,
  definitionPath: BoundedText,
  memoryScope: Schema.optional(ClaudeAgentMemoryScope),
  /** Directory the agent's memory lives in; resolved through the instance config dir. */
  memoryPath: Schema.optional(BoundedText),
  memoryExists: Schema.optional(Schema.Boolean),
});
export type ProviderInventoryAgent = typeof ProviderInventoryAgent.Type;

export const ProviderInstanceInventory = Schema.Struct({
  feedbackSupported: Schema.optional(Schema.Boolean),
  account: Schema.optional(
    Schema.Struct({
      type: Schema.Literals(["apiKey", "chatgpt", "gcp", "unknown"]),
      email: Schema.optional(BoundedText),
      workspaceName: Schema.optional(BoundedText),
    }),
  ),
  accountWorkspaces: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: BoundedText,
        kind: Schema.optional(BoundedText),
        active: Schema.Boolean,
      }),
    ),
  ),
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  generatedAt: IsoDateTime,
  projectId: Schema.optional(ProjectId),
  hooks: Schema.Array(ProviderInventoryHook),
  plugins: Schema.Array(ProviderInventoryPlugin),
  connectors: Schema.Array(ProviderInventoryConnector),
  agents: Schema.Array(ProviderInventoryAgent),
  /** Non-fatal read problems (unreadable or malformed files, unsupported methods). */
  warnings: Schema.Array(BoundedText),
});
export type ProviderInstanceInventory = typeof ProviderInstanceInventory.Type;

export const ServerGetProviderInventoryInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Resolved server-side to the project's workspace root; paths are never accepted. */
  projectId: Schema.optional(ProjectId),
});
export type ServerGetProviderInventoryInput = typeof ServerGetProviderInventoryInput.Type;

export const ServerSaveProviderFeedbackInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ServerSaveProviderFeedbackInput = typeof ServerSaveProviderFeedbackInput.Type;

export const MAX_TRUST_PROVIDER_HOOK_KEYS = 64;

export const ServerTrustProviderHooksInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Resolved server-side to the project's workspace root; paths are never accepted. */
  projectId: Schema.optional(ProjectId),
  /**
   * Hook keys from the inventory. Hashes are never accepted: the server trusts
   * what the provider reports for each key at the moment of the write.
   */
  keys: Schema.Array(BoundedText).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_TRUST_PROVIDER_HOOK_KEYS),
  ),
});
export type ServerTrustProviderHooksInput = typeof ServerTrustProviderHooksInput.Type;

export const ServerTrustProviderHooksResult = Schema.Struct({
  trusted: Schema.Array(BoundedText),
  /** Requested keys that were unknown, managed, or already trusted. */
  skipped: Schema.Array(BoundedText),
});
export type ServerTrustProviderHooksResult = typeof ServerTrustProviderHooksResult.Type;
