import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  TOOL_COMPLETION_INLINE_INPUT_MAX_BYTES,
  TOOL_COMPLETION_INLINE_OUTPUT_MAX_BYTES,
  type ToolCompletionEnvelope,
  type ToolCompletionOmission,
} from "@t3tools/contracts";

import { createAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";

/**
 * Claude's native task-tracking tools (the `CLAUDE_CODE_ENABLE_TASKS` surface).
 * Not to be confused with the legacy `Task` sub-agent delegation tool.
 */
export const CLAUDE_TASK_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
export type ClaudeTaskToolName = (typeof CLAUDE_TASK_TOOL_NAMES)[number];

const TASK_TOOL_NAME_SET: ReadonlySet<string> = new Set(CLAUDE_TASK_TOOL_NAMES);

export function isClaudeTaskToolName(value: unknown): value is ClaudeTaskToolName {
  return typeof value === "string" && TASK_TOOL_NAME_SET.has(value);
}

/**
 * Tools whose structured output F5 consumes and therefore persists. Other tools
 * get an envelope with ids and success flags only; their output stays in the
 * native event log, so ordinary Read/Bash results never bloat thread storage.
 */
function retainsStructuredOutput(toolName: string): boolean {
  return isClaudeTaskToolName(toolName);
}

interface SerializedValue {
  readonly json: string;
  readonly bytes: number;
}

function serialize(value: unknown): SerializedValue | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    return { json, bytes: Buffer.byteLength(json, "utf8") };
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readSemanticFailure(output: unknown): { readonly error?: string } | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  if (record.success !== false) return undefined;
  return typeof record.error === "string" && record.error.trim().length > 0
    ? { error: record.error.trim() }
    : {};
}

export interface ClaudeToolCompletionDraft {
  readonly envelope: ToolCompletionEnvelope;
  /** Present when retained output exceeded the inline limit and should be stored. */
  readonly oversizeOutput?: {
    readonly json: string;
    readonly bytes: number;
    readonly sha256: string;
  };
}

/**
 * Build the typed completion for one native tool result. `structuredOutput` is
 * the message-level `tool_use_result`; pass `correlated: false` when the
 * message carried several tool results and the output cannot be attributed.
 */
export function buildClaudeToolCompletion(input: {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly structuredOutput: unknown;
  readonly correlated: boolean;
  readonly isError: boolean;
  readonly nativeSessionId?: string | undefined;
}): ClaudeToolCompletionDraft {
  const retained = retainsStructuredOutput(input.toolName);
  const hasOutput = input.structuredOutput !== undefined && input.structuredOutput !== null;
  const failure =
    input.correlated && hasOutput ? readSemanticFailure(input.structuredOutput) : undefined;

  let structuredOutput: unknown;
  let outputOmission: ToolCompletionOmission | undefined;
  let oversizeOutput: ClaudeToolCompletionDraft["oversizeOutput"];
  if (hasOutput && !input.correlated) {
    outputOmission = { reason: "uncorrelated" };
  } else if (hasOutput) {
    const serialized = serialize(input.structuredOutput);
    if (!serialized) {
      outputOmission = { reason: "unserializable" };
    } else if (!retained) {
      outputOmission = { reason: "not-retained", bytes: serialized.bytes };
    } else if (serialized.bytes > TOOL_COMPLETION_INLINE_OUTPUT_MAX_BYTES) {
      const digest = sha256(serialized.json);
      outputOmission = { reason: "too-large", bytes: serialized.bytes, sha256: digest };
      oversizeOutput = { json: serialized.json, bytes: serialized.bytes, sha256: digest };
    } else {
      structuredOutput = JSON.parse(serialized.json) as unknown;
    }
  }

  let correlatedInput: unknown;
  let inputOmission: ToolCompletionOmission | undefined;
  if (retained) {
    const serializedInput = serialize(input.toolInput);
    if (!serializedInput) {
      inputOmission = { reason: "unserializable" };
    } else if (serializedInput.bytes > TOOL_COMPLETION_INLINE_INPUT_MAX_BYTES) {
      inputOmission = { reason: "too-large", bytes: serializedInput.bytes };
    } else {
      correlatedInput = JSON.parse(serializedInput.json) as unknown;
    }
  }

  const envelope: ToolCompletionEnvelope = {
    version: 1,
    nativeCallId: input.toolUseId,
    ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    toolName: input.toolName,
    ...(correlatedInput !== undefined ? { input: correlatedInput } : {}),
    ...(inputOmission ? { inputOmission } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(outputOmission ? { outputOmission } : {}),
    transportError: input.isError,
    semanticSuccess: !input.isError && failure === undefined,
    ...(failure?.error ? { semanticError: failure.error } : {}),
  };
  return { envelope, ...(oversizeOutput ? { oversizeOutput } : {}) };
}

/**
 * Store an oversize structured output as a thread-scoped JSON attachment and
 * return the envelope with an artifact reference. On failure the envelope keeps
 * its omission metadata without a reference; the native log still has the data.
 */
export async function storeClaudeToolCompletionArtifact(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly draft: ClaudeToolCompletionDraft;
}): Promise<ToolCompletionEnvelope> {
  const { envelope, oversizeOutput } = input.draft;
  if (!oversizeOutput || !envelope.outputOmission) return envelope;
  const attachmentId = createAttachmentId(input.threadId);
  if (!attachmentId) return envelope;
  const filePath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${attachmentId}.json`,
  });
  if (!filePath) return envelope;
  await NodeFs.mkdir(NodePath.dirname(filePath), { recursive: true });
  // `wx` refuses to overwrite: ids are fresh UUIDs, so a collision is a bug.
  await NodeFs.writeFile(filePath, oversizeOutput.json, { encoding: "utf8", flag: "wx" });
  return {
    ...envelope,
    outputOmission: {
      ...envelope.outputOmission,
      artifact: { kind: "attachment", attachmentId, mimeType: "application/json" },
    },
  };
}
