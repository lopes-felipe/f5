/**
 * Version-specific inventory of the Codex app-server protocol surface F5 has
 * audited. Keep this list exhaustive: a new method or item must receive an
 * explicit disposition before it can be treated as understood.
 */
export const CODEX_PROTOCOL_BASELINE_VERSION = "0.162.0" as const;

/**
 * Oldest release whose full surface F5 audited before 0.162.0. Older CLIs are
 * still permitted (the runtime minimum lives in codexCliVersion.ts) but their
 * behavior is unverified. Runtime handlers for methods removed after this
 * release stay in place for those CLIs.
 */
export const CODEX_PROTOCOL_PREVIOUS_BASELINE_VERSION = "0.144.3" as const;

export const CODEX_PROTOCOL_DISPOSITIONS = [
  "canonical",
  "state-only",
  "diagnostics-only",
  "internal-duplicate",
  "capability-gated",
  "unsupported",
] as const;

export type CodexProtocolDisposition = (typeof CODEX_PROTOCOL_DISPOSITIONS)[number];

export const CODEX_NOTIFICATION_METHODS = [
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/closed",
  "thread/reverted",
  "skills/changed",
  "thread/name/updated",
  "thread/attachment/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/queue/changed",
  "project/changed",
  "thread/project/updated",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
  "thread/prediction/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "hook/started",
  "turn/completed",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "autoApprovalReview/strictReviewRequired",
  "item/completed",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "serverRequest/resolved",
  "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification",
  "account/updated",
  "account/gatewayOAuth/changed",
  "account/rateLimits/updated",
  "app/list/updated",
  "remoteControl/status/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "fs/changed",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/compacted",
  "model/rerouted",
  "model/verification",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
  "turn/moderationMetadata",
  "model/safetyBuffering/updated",
  "warning",
  "guardianWarning",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "account/login/completed",
] as const;

export type CodexNotificationMethod = (typeof CODEX_NOTIFICATION_METHODS)[number];

export const CODEX_NOTIFICATION_DISPOSITIONS = {
  error: "canonical",
  "thread/started": "canonical",
  "thread/status/changed": "canonical",
  "thread/archived": "state-only",
  "thread/deleted": "state-only",
  "thread/unarchived": "state-only",
  "thread/closed": "canonical",
  // F5 validates retained history through its own paged read-back after
  // thread/revert, so the announcement only mirrors state F5 already owns.
  "thread/reverted": "state-only",
  "skills/changed": "state-only",
  "thread/name/updated": "state-only",
  "thread/attachment/updated": "canonical",
  "thread/goal/updated": "canonical",
  "thread/goal/cleared": "canonical",
  // Native queue, projects and environments would create a second owner for
  // F5's queue, project and workspace model; they are deliberately not mapped.
  "thread/queue/changed": "state-only",
  "project/changed": "state-only",
  "thread/project/updated": "state-only",
  "thread/environment/connected": "state-only",
  "thread/environment/disconnected": "state-only",
  "thread/settings/updated": "state-only",
  // Native predictions are observed only; F5 does not enable a second prompt producer.
  "thread/prediction/updated": "state-only",
  "thread/tokenUsage/updated": "canonical",
  "turn/started": "canonical",
  "hook/started": "diagnostics-only",
  "turn/completed": "canonical",
  "hook/completed": "diagnostics-only",
  "turn/diff/updated": "canonical",
  "turn/plan/updated": "canonical",
  "item/started": "canonical",
  "item/autoApprovalReview/started": "diagnostics-only",
  "item/autoApprovalReview/completed": "diagnostics-only",
  "autoApprovalReview/strictReviewRequired": "diagnostics-only",
  "item/completed": "canonical",
  // Raw Responses API items duplicate the typed item/* stream (F5 starts
  // threads with experimentalRawEvents:false).
  "rawResponseItem/completed": "internal-duplicate",
  // Internal per-completion usage. thread/tokenUsage/updated already carries
  // the aggregated usage F5 records, so this is not a second usage source.
  "rawResponse/completed": "internal-duplicate",
  "item/agentMessage/delta": "canonical",
  "item/plan/delta": "canonical",
  "command/exec/outputDelta": "state-only",
  "process/outputDelta": "state-only",
  "process/exited": "state-only",
  "item/commandExecution/outputDelta": "canonical",
  "item/commandExecution/terminalInteraction": "canonical",
  // No longer emitted by current servers; kept (and still mapped by the
  // adapter) for persisted logs and older CLIs.
  "item/fileChange/outputDelta": "diagnostics-only",
  "item/fileChange/patchUpdated": "canonical",
  "serverRequest/resolved": "canonical",
  "item/mcpToolCall/progress": "canonical",
  "mcpServer/oauthLogin/completed": "canonical",
  "mcpServer/startupStatus/updated": "canonical",
  "mcpServer/event/stream/notification": "state-only",
  "account/updated": "state-only",
  "account/gatewayOAuth/changed": "state-only",
  "account/rateLimits/updated": "state-only",
  "app/list/updated": "state-only",
  "remoteControl/status/changed": "state-only",
  "externalAgentConfig/import/progress": "state-only",
  "externalAgentConfig/import/completed": "state-only",
  "fs/changed": "state-only",
  "item/reasoning/summaryTextDelta": "canonical",
  "item/reasoning/summaryPartAdded": "canonical",
  "item/reasoning/textDelta": "canonical",
  // Deprecated upstream in favor of the contextCompaction item. It still marks
  // the thread state as compacted, and older CLIs only send this notification.
  "thread/compacted": "canonical",
  "model/rerouted": "canonical",
  "model/verification": "diagnostics-only",
  "modelProvider/authRecoveryStarted": "diagnostics-only",
  "modelProvider/authRecoveryCompleted": "diagnostics-only",
  "turn/moderationMetadata": "state-only",
  "model/safetyBuffering/updated": "state-only",
  warning: "diagnostics-only",
  guardianWarning: "diagnostics-only",
  deprecationNotice: "diagnostics-only",
  configWarning: "diagnostics-only",
  "fuzzyFileSearch/sessionUpdated": "state-only",
  "fuzzyFileSearch/sessionCompleted": "state-only",
  "thread/realtime/started": "state-only",
  "thread/realtime/itemAdded": "state-only",
  "thread/realtime/item/started": "state-only",
  "thread/realtime/item/transcript/delta": "state-only",
  "thread/realtime/item/completed": "state-only",
  "thread/realtime/transcript/delta": "state-only",
  "thread/realtime/transcript/done": "state-only",
  "thread/realtime/outputAudio/delta": "state-only",
  "thread/realtime/sdp": "state-only",
  "thread/realtime/error": "diagnostics-only",
  "thread/realtime/closed": "state-only",
  "windows/worldWritableWarning": "diagnostics-only",
  "windowsSandbox/setupCompleted": "state-only",
  "account/login/completed": "state-only",
} as const satisfies Record<CodexNotificationMethod, CodexProtocolDisposition>;

export const CODEX_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

export type CodexServerRequestMethod = (typeof CODEX_SERVER_REQUEST_METHODS)[number];

export const CODEX_SERVER_REQUEST_DISPOSITIONS = {
  "item/commandExecution/requestApproval": "canonical",
  "item/fileChange/requestApproval": "canonical",
  "item/tool/requestUserInput": "canonical",
  "mcpServer/elicitation/request": "capability-gated",
  "item/permissions/requestApproval": "canonical",
  "item/tool/call": "capability-gated",
  "account/chatgptAuthTokens/refresh": "unsupported",
  "attestation/generate": "capability-gated",
  "currentTime/read": "canonical",
  applyPatchApproval: "canonical",
  execCommandApproval: "canonical",
} as const satisfies Record<CodexServerRequestMethod, CodexProtocolDisposition>;

/**
 * Client requests F5 sends to the app-server. Each group lists the methods that
 * can serve one need, preferred first; F5 falls back down the list when the CLI
 * rejects a method as unknown. The audit fails when no method in a group exists,
 * so a renamed or removed method is caught before users hit it.
 */
export const CODEX_CLIENT_REQUEST_METHODS = [
  ["review/start"],
  ["thread/name/set"],
  ["thread/compact/start"],
  ["thread/goal/set"],
  ["thread/goal/get"],
  ["thread/goal/clear"],
  ["thread/attachment/list"],
  ["thread/items/list"],
  ["initialize"],
  ["thread/start"],
  ["thread/resume"],
  ["turn/start"],
  ["turn/steer"],
  ["turn/interrupt"],
  ["thread/turns/list", "thread/read"],
  ["thread/revert", "thread/rollback", "thread/fork"],
  ["thread/unsubscribe"],
  ["model/list"],
  ["skills/list"],
  ["account/read"],
  ["account/usage/read"],
  ["account/rateLimits/read"],
  ["account/rateLimitResetCredit/consume"],
  ["config/read"],
  ["config/batchWrite"],
  ["config/mcpServer/reload"],
  ["mcpServer/oauth/login"],
  ["mcpServerStatus/list"],
  // Read-only instance inventory (Release 2).
  ["hooks/list"],
  ["plugin/list"],
  ["app/list"],
] as const satisfies ReadonlyArray<readonly [string, ...string[]]>;

/**
 * Response fields F5 decodes, certified against the baseline's generated JSON
 * schemas (`codex app-server generate-json-schema --experimental`). Keys are
 * request methods; fields are dot paths where `[]` steps into array items.
 * Only fields F5 actually reads belong here: the audit fails when one is
 * missing, so an upstream rename is caught before decoding silently degrades.
 * Methods the audited CLI does not offer (a fallback such as thread/revert on
 * 0.147) are skipped and reported by the client-request check instead.
 */
export const CODEX_DECODED_RESPONSE_FIELDS = {
  "thread/start": { schema: "v2/ThreadStartResponse.json", fields: ["thread.id"] },
  "thread/resume": { schema: "v2/ThreadResumeResponse.json", fields: ["thread.id"] },
  "thread/fork": { schema: "v2/ThreadForkResponse.json", fields: ["thread.id"] },
  "thread/revert": { schema: "v2/ThreadRevertResponse.json", fields: ["thread.id"] },
  "thread/read": {
    schema: "v2/ThreadReadResponse.json",
    fields: ["thread.id", "thread.turns[].id", "thread.turns[].items"],
  },
  "thread/turns/list": {
    schema: "v2/ThreadTurnsListResponse.json",
    fields: ["data[].id", "data[].items", "data[].itemsView", "nextCursor"],
  },
  "turn/start": { schema: "v2/TurnStartResponse.json", fields: ["turn.id"] },
  "turn/steer": { schema: "v2/TurnSteerResponse.json", fields: ["turnId"] },
  "model/list": {
    schema: "v2/ModelListResponse.json",
    fields: [
      "data[].id",
      "data[].model",
      "data[].displayName",
      "data[].hidden",
      "data[].supportedReasoningEfforts[].reasoningEffort",
      "data[].defaultReasoningEffort",
      "data[].serviceTiers[].id",
      "data[].serviceTiers[].name",
      "data[].serviceTiers[].description",
      "data[].defaultServiceTier",
      "data[].upgrade",
      "nextCursor",
    ],
  },
  "account/read": {
    schema: "v2/GetAccountResponse.json",
    fields: ["account.type", "account.planType"],
  },
  "skills/list": {
    schema: "v2/SkillsListResponse.json",
    fields: [
      "data[].skills[].name",
      "data[].skills[].enabled",
      "data[].skills[].description",
      "data[].skills[].shortDescription",
      "data[].skills[].interface.shortDescription",
      "data[].skills[].path",
      "data[].skills[].scope",
    ],
  },
  "account/rateLimits/read": {
    schema: "v2/GetAccountRateLimitsResponse.json",
    fields: ["rateLimits"],
  },
  "account/usage/read": { schema: "v2/GetAccountTokenUsageResponse.json", fields: ["summary"] },
  "config/read": { schema: "v2/ConfigReadResponse.json", fields: ["config", "origins", "layers"] },
  "config/batchWrite": {
    schema: "v2/ConfigWriteResponse.json",
    fields: ["version", "status", "filePath", "overriddenMetadata"],
  },
  "mcpServerStatus/list": {
    schema: "v2/ListMcpServerStatusResponse.json",
    fields: ["data[].name", "nextCursor"],
  },
  "hooks/list": {
    schema: "v2/HooksListResponse.json",
    fields: [
      "data[].hooks[].key",
      "data[].hooks[].eventName",
      "data[].hooks[].matcher",
      "data[].hooks[].handlerType",
      "data[].hooks[].command",
      "data[].hooks[].source",
      "data[].hooks[].sourcePath",
      "data[].hooks[].enabled",
      "data[].hooks[].isManaged",
      "data[].hooks[].pluginId",
    ],
  },
  "plugin/list": {
    schema: "v2/PluginListResponse.json",
    fields: [
      "marketplaces[].name",
      "marketplaces[].path",
      "marketplaces[].plugins[].id",
      "marketplaces[].plugins[].name",
      "marketplaces[].plugins[].installed",
      "marketplaces[].plugins[].enabled",
    ],
  },
  "app/list": {
    schema: "v2/AppsListResponse.json",
    fields: ["data[].id", "data[].name", "data[].isEnabled", "data[].isAccessible", "nextCursor"],
  },
} as const satisfies Record<
  string,
  { readonly schema: string; readonly fields: ReadonlyArray<string> }
>;

export const CODEX_THREAD_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
] as const;

export type CodexThreadItemType = (typeof CODEX_THREAD_ITEM_TYPES)[number];

export const CODEX_THREAD_ITEM_DISPOSITIONS = {
  userMessage: "canonical",
  hookPrompt: "internal-duplicate",
  agentMessage: "canonical",
  // Raw function outputs duplicate the typed tool items (commandExecution,
  // mcpToolCall, dynamicToolCall) that F5 already renders.
  functionCallOutput: "internal-duplicate",
  plan: "canonical",
  reasoning: "canonical",
  commandExecution: "canonical",
  fileChange: "canonical",
  mcpToolCall: "canonical",
  dynamicToolCall: "canonical",
  collabAgentToolCall: "canonical",
  subAgentActivity: "canonical",
  webSearch: "canonical",
  imageView: "canonical",
  sleep: "canonical",
  imageGeneration: "canonical",
  enteredReviewMode: "canonical",
  exitedReviewMode: "canonical",
  contextCompaction: "canonical",
} as const satisfies Record<CodexThreadItemType, CodexProtocolDisposition>;

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function codexNotificationDisposition(method: string): CodexProtocolDisposition | undefined {
  return hasOwn(CODEX_NOTIFICATION_DISPOSITIONS, method)
    ? CODEX_NOTIFICATION_DISPOSITIONS[method]
    : undefined;
}

export function codexServerRequestDisposition(
  method: string,
): CodexProtocolDisposition | undefined {
  return hasOwn(CODEX_SERVER_REQUEST_DISPOSITIONS, method)
    ? CODEX_SERVER_REQUEST_DISPOSITIONS[method]
    : undefined;
}

export function codexThreadItemDisposition(itemType: string): CodexProtocolDisposition | undefined {
  return hasOwn(CODEX_THREAD_ITEM_DISPOSITIONS, itemType)
    ? CODEX_THREAD_ITEM_DISPOSITIONS[itemType]
    : undefined;
}
