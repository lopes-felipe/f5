/**
 * Synthesizes Codex-shaped structured file-change `changes` for Claude's
 * built-in editing tools (Write/Edit/MultiEdit/NotebookEdit) from their tool
 * input.
 *
 * The Claude Agent SDK does not emit a unified-diff patch with its file edits
 * (unlike Codex's `patch_apply` events), so file-change records would otherwise
 * have an empty patch and could not render an inline diff. Producing the same
 * `changes` shape the Codex path uses lets the shared ProviderRuntimeIngestion
 * patch synthesis build a patch, so Claude file changes render through the same
 * robust exact-diff path as Codex.
 *
 * @module claudeFileChangePatch
 */

function asInputString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

import { buildReplaceHunk as buildClaudeReplaceHunk } from "../fileChangeHunk";
export { buildClaudeReplaceHunk };

/**
 * Returns Codex-shaped structured `changes` for a Claude file-editing tool, or
 * `undefined` when the tool/input is not a recognized file edit. The result is
 * consumed by `synthesizeStructuredFileChangePatch` in ProviderRuntimeIngestion.
 */
export function buildClaudeFileChangeStructuredChanges(
  toolName: string,
  toolInput: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> | undefined {
  const normalized = toolName.trim().toLowerCase();
  const path =
    asInputString(toolInput.file_path) ??
    asInputString(toolInput.path) ??
    asInputString(toolInput.notebook_path);
  if (!path) {
    return undefined;
  }

  // `type` (not `kind`) is the field ProviderRuntimeIngestion's
  // `toStructuredFileChangePatchInput` reads to classify the change.
  if (normalized === "write") {
    return [{ path, type: "add", content: asInputString(toolInput.content) ?? "" }];
  }

  if (normalized === "edit" || normalized === "notebookedit") {
    const oldString =
      asInputString(toolInput.old_string) ?? asInputString(toolInput.old_source) ?? "";
    const newString =
      asInputString(toolInput.new_string) ?? asInputString(toolInput.new_source) ?? "";
    if (oldString.length === 0 && newString.length === 0) {
      return undefined;
    }
    return [{ path, type: "update", diff: buildClaudeReplaceHunk(oldString, newString) }];
  }

  if (normalized === "multiedit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    const hunks: Array<string> = [];
    for (const entry of edits) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const oldString = asInputString(record.old_string) ?? "";
      const newString = asInputString(record.new_string) ?? "";
      if (oldString.length === 0 && newString.length === 0) {
        continue;
      }
      hunks.push(buildClaudeReplaceHunk(oldString, newString));
    }
    if (hunks.length === 0) {
      return undefined;
    }
    return [{ path, type: "update", diff: hunks.join("\n") }];
  }

  return undefined;
}
