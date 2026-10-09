import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
  "image_generation",
  "sleep",
] as const;

/** Inline limit for a retained structured tool output (serialized JSON bytes). */
export const TOOL_COMPLETION_INLINE_OUTPUT_MAX_BYTES = 64 * 1024;
/** Inline limit for the correlated tool input carried with a completion. */
export const TOOL_COMPLETION_INLINE_INPUT_MAX_BYTES = 16 * 1024;

/**
 * Managed, thread-scoped artifact holding an oversize structured output. It is
 * an attachment id (served by the authenticated attachments route and removed
 * with its thread), never a filesystem path.
 */
export const ToolCompletionOutputArtifact = Schema.Struct({
  kind: Schema.Literal("attachment"),
  attachmentId: TrimmedNonEmptyString,
  mimeType: Schema.Literal("application/json"),
});
export type ToolCompletionOutputArtifact = typeof ToolCompletionOutputArtifact.Type;

export const ToolCompletionOmissionReason = Schema.Literals([
  // The tool's structured output is not retained by policy (the native log keeps it).
  "not-retained",
  // Larger than the inline limit; see `artifact` when it was stored.
  "too-large",
  // The message carried several tool results, so the output cannot be correlated.
  "uncorrelated",
  // Not representable as JSON.
  "unserializable",
]);
export type ToolCompletionOmissionReason = typeof ToolCompletionOmissionReason.Type;

export const ToolCompletionOmission = Schema.Struct({
  reason: ToolCompletionOmissionReason,
  bytes: Schema.optional(NonNegativeInt),
  sha256: Schema.optional(TrimmedNonEmptyString),
  artifact: Schema.optional(ToolCompletionOutputArtifact),
});
export type ToolCompletionOmission = typeof ToolCompletionOmission.Type;

/**
 * Typed result of one native tool call, attached once to `item.completed`.
 * `transportError` is the native error flag; `semanticSuccess` is false also
 * when a tool reports failure in its structured output (for example Claude
 * TaskUpdate `{ success: false }` without `is_error`).
 */
export const ToolCompletionEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  nativeCallId: TrimmedNonEmptyString,
  /** Native session that produced the result; consumers fence stale sessions on it. */
  nativeSessionId: Schema.optional(TrimmedNonEmptyString),
  toolName: TrimmedNonEmptyString,
  input: Schema.optional(Schema.Unknown),
  inputOmission: Schema.optional(ToolCompletionOmission),
  structuredOutput: Schema.optional(Schema.Unknown),
  outputOmission: Schema.optional(ToolCompletionOmission),
  transportError: Schema.Boolean,
  semanticSuccess: Schema.Boolean,
  semanticError: Schema.optional(Schema.String),
});
export type ToolCompletionEnvelope = typeof ToolCompletionEnvelope.Type;
