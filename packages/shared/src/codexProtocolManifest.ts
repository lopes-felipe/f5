/**
 * Version-specific inventory of the Codex app-server protocol surface F5 has
 * audited. Keep this list exhaustive: a new method or item must receive an
 * explicit disposition before it can be treated as understood.
 */
export const CODEX_PROTOCOL_BASELINE_VERSION = "0.144.3" as const;

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
  "skills/changed",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/settings/updated",
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
  "item/completed",
  "rawResponseItem/completed",
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
  "account/updated",
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
  "skills/changed": "state-only",
  "thread/name/updated": "state-only",
  "thread/goal/updated": "state-only",
  "thread/goal/cleared": "state-only",
  "thread/settings/updated": "state-only",
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
  "item/completed": "canonical",
  "rawResponseItem/completed": "internal-duplicate",
  "item/agentMessage/delta": "canonical",
  "item/plan/delta": "canonical",
  "command/exec/outputDelta": "state-only",
  "process/outputDelta": "state-only",
  "process/exited": "state-only",
  "item/commandExecution/outputDelta": "canonical",
  "item/commandExecution/terminalInteraction": "canonical",
  "item/fileChange/outputDelta": "canonical",
  "item/fileChange/patchUpdated": "canonical",
  "serverRequest/resolved": "canonical",
  "item/mcpToolCall/progress": "canonical",
  "mcpServer/oauthLogin/completed": "canonical",
  "mcpServer/startupStatus/updated": "canonical",
  "account/updated": "state-only",
  "account/rateLimits/updated": "state-only",
  "app/list/updated": "state-only",
  "remoteControl/status/changed": "state-only",
  "externalAgentConfig/import/progress": "state-only",
  "externalAgentConfig/import/completed": "state-only",
  "fs/changed": "state-only",
  "item/reasoning/summaryTextDelta": "canonical",
  "item/reasoning/summaryPartAdded": "canonical",
  "item/reasoning/textDelta": "canonical",
  "thread/compacted": "canonical",
  "model/rerouted": "canonical",
  "model/verification": "diagnostics-only",
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

export const CODEX_THREAD_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
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
