/** Pinned release certification; never float with the installed package. */
export const CLAUDE_SDK_BASELINE_VERSION = "0.3.295";
export type ClaudeSdkDisposition = "canonical" | "diagnostics-only" | "ignored";

export const CLAUDE_SDK_MESSAGE_DISPOSITIONS = {
  assistant: "canonical",
  auth_status: "canonical",
  conversation_reset: "canonical",
  prompt_suggestion: "canonical", // Release 4: opt-in suggestions.
  rate_limit_event: "canonical",
  result: "canonical",
  stream_event: "canonical",
  user: "canonical",
  tool_progress: "canonical",
  tool_use_summary: "canonical",
  "system/api_retry": "canonical",
  "system/background_tasks_changed": "canonical",
  "system/commands_changed": "canonical",
  "system/compact_boundary": "canonical",
  "system/control_request_progress": "ignored",
  "system/elicitation_complete": "ignored", // Release 3: private elicitation transport.
  "system/files_persisted": "canonical",
  "system/hook_progress": "canonical",
  "system/hook_response": "canonical",
  "system/hook_started": "canonical",
  "system/informational": "diagnostics-only",
  "system/init": "canonical",
  "system/local_command_output": "ignored",
  "system/memory_recall": "ignored",
  "system/mirror_error": "ignored",
  "system/model_refusal_fallback": "diagnostics-only",
  "system/model_refusal_no_fallback": "diagnostics-only",
  "system/notification": "diagnostics-only",
  "system/permission_denied": "diagnostics-only",
  "system/plugin_install": "ignored",
  "system/session_state_changed": "canonical",
  "system/status": "canonical",
  "system/task_notification": "canonical",
  "system/task_progress": "canonical",
  "system/task_started": "canonical",
  "system/task_updated": "canonical",
  "system/thinking_tokens": "canonical",
  "system/worker_shutting_down": "ignored",
} as const satisfies Record<string, ClaudeSdkDisposition>;
