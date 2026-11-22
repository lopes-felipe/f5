// @effect-diagnostics nodeBuiltinImport:off - the tool-call normalizer is synchronous
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PositiveInt } from "@t3tools/contracts";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch, type StructuredPatchHunk } from "diff";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { toolCallRawInputCommand } from "./AcpRuntimeModel.ts";

const PRE_EDIT_FILE_LIMIT = 1024 * 1024;
// The live preview runs synchronously. One budget covers every chunk in a call: the generic
// ACP formatter's edit-distance limit, plus a size limit that skips diffing entirely.
const EDIT_DIFF_BUDGET = 1_000;
const EDIT_TEXT_BUDGET = 256 * 1024;

/** The edit is too large to preview cheaply; the turn's checkpoint diff still shows it. */
export const ANTIGRAVITY_EDIT_DIFF_OMITTED = Symbol("AntigravityEditDiffOmitted");
const SNIPPET_LABEL = " snippet, line unknown";

/** True when no chunk could be placed; a patch never mixes placed and unplaced chunks. */
export function isAntigravitySnippetPatch(patch: string): boolean {
  return /^@@ .* @@.*$/m.exec(patch)?.[0].endsWith(SNIPPET_LABEL) === true;
}

// The runtime reads a missing, 0 or invalid line as unspecified.
const Line = Schema.optional(Schema.Unknown);
const decodeLine = Schema.decodeUnknownOption(PositiveInt);
const lineOf = (value: unknown) => Option.getOrUndefined(decodeLine(value));
const ReplacementChunk = Schema.Struct({
  TargetContent: Schema.String,
  ReplacementContent: Schema.String,
  StartLine: Line,
  EndLine: Line,
});
// replace_file_content sends one chunk at the top level; multi_replace_file_content sends a list.
const decodeEditInput = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ ReplacementChunks: Schema.NonEmptyArray(ReplacementChunk) }),
    ReplacementChunk,
  ]),
);
const decodeLocations = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ line: Line })));
// The runtime accepts edit arguments in either casing.
const PASCAL_KEYS: Readonly<Record<string, string>> = {
  replacement_chunks: "ReplacementChunks",
  target_content: "TargetContent",
  replacement_content: "ReplacementContent",
  start_line: "StartLine",
  end_line: "EndLine",
};
const pascalKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(pascalKeys);
  if (typeof value !== "object" || value === null) return value;
  const fields: Record<string, unknown> = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const pascal = PASCAL_KEYS[key];
    // Like the runtime, a present PascalCase value wins over its snake_case alias.
    if (pascal === undefined) result[key] ??= pascalKeys(entry);
    else if (fields[pascal] == null) result[pascal] = pascalKeys(entry);
  }
  return result;
};

/** Reads a small file for snippet matching; edits to large or unreadable files stay unlocated. */
export function readAntigravityPreEditFile(path: string): string | undefined {
  try {
    const stat = NodeFS.statSync(path);
    return stat.isFile() && stat.size <= PRE_EDIT_FILE_LIMIT
      ? NodeFS.readFileSync(path, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}

/** The line of the snippet's only match starting within `from`..`to`, if it spans whole lines. */
function uniqueStartLine(
  text: string | undefined,
  snippet: string,
  from = 1,
  to = Number.POSITIVE_INFINITY,
): number | undefined {
  if (text === undefined || snippet === "") return undefined;
  let found: { readonly line: number; readonly whole: boolean } | undefined;
  let line = 1;
  let lineStart = 0;
  let nextBreak = text.indexOf("\n");
  for (let index = text.indexOf(snippet); index !== -1; index = text.indexOf(snippet, index + 1)) {
    while (nextBreak !== -1 && nextBreak < index) {
      line++;
      lineStart = nextBreak + 1;
      nextBreak = text.indexOf("\n", lineStart);
    }
    if (line > to) break;
    if (line < from) continue;
    if (found !== undefined) return undefined;
    const end = index + snippet.length;
    // A hunk replaces whole lines.
    const whole =
      index === lineStart && (end === text.length || snippet.endsWith("\n") || text[end] === "\n");
    found = { line, whole };
  }
  return found?.whole === true ? found.line : undefined;
}

function snippetHunks(
  oldText: string,
  newText: string,
  maxEditLength: number,
): StructuredPatchHunk[] | undefined {
  const before = oldText.replaceAll("\r\n", "\n");
  const after = newText.replaceAll("\r\n", "\n");
  // A target without its newline keeps the line's own newline, on both sides.
  const eol = before.endsWith("\n") ? "" : "\n";
  return structuredPatch("", "", before + eol, after + eol, undefined, undefined, {
    maxEditLength,
  })?.hunks;
}

const changedLines = (hunks: ReadonlyArray<StructuredPatchHunk>) =>
  hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.startsWith("+") || line.startsWith("-")).length,
    0,
  );

/**
 * Antigravity reports replacements as bare old/new snippets. `StartLine` only starts the
 * runtime's search range, so a chunk is placed at its unique match in the pre-edit file within
 * that range. All-unplaced chunks get hunks labeled as snippets; a mix is omitted.
 */
export function antigravityEditPatch(input: {
  readonly path: string;
  readonly rawInput: unknown;
  readonly locations?: unknown;
  /** Pass only while the edit is pending, when the file still holds the old text. */
  readonly readPreEditFile?: ((path: string) => string | undefined) | undefined;
}): string | typeof ANTIGRAVITY_EDIT_DIFF_OMITTED | undefined {
  const edit = Option.getOrUndefined(decodeEditInput(pascalKeys(input.rawInput)));
  if (edit === undefined) return undefined;
  const announced = lineOf(Option.getOrUndefined(decodeLocations(input.locations))?.[0]?.line);
  const listed = "ReplacementChunks" in edit ? edit.ReplacementChunks : [edit];
  const chunks = listed.map((chunk) => ({
    ...chunk,
    StartLine: lineOf(chunk.StartLine) ?? (listed.length === 1 ? announced : undefined),
    EndLine: lineOf(chunk.EndLine),
  }));
  let file: string | undefined;
  let fileRead = false;
  const textSize = chunks.reduce(
    (total, chunk) => total + chunk.TargetContent.length + chunk.ReplacementContent.length,
    0,
  );
  if (textSize > EDIT_TEXT_BUDGET) return ANTIGRAVITY_EDIT_DIFF_OMITTED;
  let budget = EDIT_DIFF_BUDGET;
  const placed: Array<{ readonly start: number; readonly hunks: StructuredPatchHunk[] }> = [];
  const snippets: StructuredPatchHunk[] = [];
  for (const chunk of chunks) {
    // Whether a changed final line break, or a cleared line, splits, joins or removes lines
    // depends on what follows the match. Only a whole-line delete is certain.
    const targetEndsLine = chunk.TargetContent.endsWith("\n");
    if (
      chunk.ReplacementContent === ""
        ? !targetEndsLine
        : targetEndsLine !== chunk.ReplacementContent.endsWith("\n")
    )
      return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    const hunks = snippetHunks(chunk.TargetContent, chunk.ReplacementContent, budget);
    // A change to the line ending alone leaves no LF hunk to show.
    if (
      hunks === undefined ||
      (hunks.length === 0 && chunk.TargetContent !== chunk.ReplacementContent)
    )
      return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    budget -= changedLines(hunks);
    if (budget < 0) return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    let start: number | undefined;
    if (input.readPreEditFile !== undefined) {
      // Line numbers do not depend on CRLF, so search with LF on both sides.
      if (!fileRead) file = input.readPreEditFile(input.path)?.replaceAll("\r\n", "\n");
      fileRead = true;
      start = uniqueStartLine(
        file,
        chunk.TargetContent.replaceAll("\r\n", "\n"),
        chunk.StartLine,
        chunk.EndLine,
      );
    }
    if (start === undefined) snippets.push(...hunks);
    else placed.push({ start, hunks });
  }
  // A placed hunk beside an unplaced one would still number the unplaced one from line 1.
  if (placed.length > 0 && snippets.length > 0) return ANTIGRAVITY_EDIT_DIFF_OMITTED;
  let shift = 0;
  const placedHunks = placed
    .toSorted((left, right) => left.start - right.start)
    .flatMap(({ start, hunks }) => {
      const shifted = hunks.map((hunk) => ({
        ...hunk,
        oldStart: hunk.oldStart + start - 1,
        newStart: hunk.newStart + start - 1 + shift,
      }));
      for (const hunk of hunks) shift += hunk.newLines - hunk.oldLines;
      return shifted;
    });
  const section = (hunks: StructuredPatchHunk[]) =>
    hunks.length === 0
      ? ""
      : formatPatch(
          {
            oldFileName: input.path,
            newFileName: input.path,
            oldHeader: undefined,
            newHeader: undefined,
            hunks,
          },
          FILE_HEADERS_ONLY,
        );
  const patch = [
    section(placedHunks),
    section(snippets).replace(/^@@ .* @@$/gm, `$&${SNIPPET_LABEL}`),
  ]
    .filter(Boolean)
    .join("\n");
  return patch || undefined;
}

/** Antigravity's file-edit tools, matched as the whole tool name at the start of the title. */
const EDIT_TOOL_TITLE = /^(?:replace_file_content|multi_replace_file_content|write_to_file)\b/;
/** Any of these means the request may execute something, whatever its kind says. */
const COMMAND_KEYS = [
  "CommandLine",
  "command_line",
  "commandLine",
  "command",
  "Command",
  "cmd",
  "Cwd",
  "cwd",
  "executable",
  "args",
  "script",
  "shell",
];
const TARGET_KEYS = ["TargetFile", "target_file", "AbsolutePath", "absolute_path", "FilePath"];

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A `..` segment would be applied lexically here but after links by the filesystem. */
const hasParentSegment = (target: string) => target.split(/[\\/]+/).includes("..");

/**
 * Realpath of the nearest existing ancestor, with the missing tail appended. Only components
 * the filesystem reports missing (`ENOENT`) are appended; any other resolution error, or a `..`
 * segment, is ambiguous and returns `undefined` so the request is asked.
 */
function canonicalTarget(target: string): string | undefined {
  if (hasParentSegment(target)) return undefined;
  let existing = NodePath.resolve(target);
  const tail: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      const resolved = NodeFS.realpathSync.native(existing);
      // Missing components can only be appended under a directory. Windows reports a file used
      // as a directory as ENOENT rather than ENOTDIR, so check the type explicitly.
      if (tail.length > 0 && !NodeFS.statSync(resolved).isDirectory()) return undefined;
      return NodePath.join(resolved, ...tail.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
      const parent = NodePath.dirname(existing);
      if (parent === existing) return undefined;
      tail.push(NodePath.basename(existing));
      existing = parent;
    }
  }
  return undefined;
}

function canonicalWorkspaceRoot(root: string): string | undefined {
  try {
    return NodeFS.realpathSync.native(root);
  } catch {
    return undefined;
  }
}

const isParentTraversal = (relative: string) =>
  relative === ".." || relative.startsWith(`..${NodePath.sep}`);
/** Git metadata such as hooks runs code later; edits there are always asked. */
const isGitMetadata = (relative: string) =>
  relative.split(NodePath.sep)[0]?.toLowerCase() === ".git";

/**
 * Auto-accept edits approves a request only when it is a recognised edit with no command
 * payload, names at least one target, and every target resolves under the canonical workspace
 * root (links followed). Anything else is asked.
 *
 * Recognised means the ACP kind is `edit` and the request also has an edit's shape: an
 * Antigravity edit tool name leading the title, or an edit target field in its input. A title or
 * kind alone never qualifies, and any command field (including the shared ACP command fields)
 * makes the request ambiguous, so it is asked.
 */
export function antigravityEditTargetsInWorkspace(
  toolCall: {
    readonly kind?: string | null | undefined;
    readonly title?: string | null | undefined;
    readonly rawInput?: unknown;
    readonly locations?: ReadonlyArray<{ readonly path: string }> | null | undefined;
    readonly content?: ReadonlyArray<unknown> | null | undefined;
  },
  workspaceRoot: string,
): boolean {
  if (toolCall.kind !== "edit") return false;
  const raw = recordOf(toolCall.rawInput);
  const hasTargetField = TARGET_KEYS.some((key) => typeof raw?.[key] === "string");
  if (!EDIT_TOOL_TITLE.test(toolCall.title?.trim() ?? "") && !hasTargetField) return false;
  if (raw && COMMAND_KEYS.some((key) => raw[key] !== undefined)) return false;
  if (toolCallRawInputCommand(toolCall.rawInput) !== undefined) return false;
  const targets = new Set<string>();
  for (const location of toolCall.locations ?? []) targets.add(location.path);
  for (const entry of toolCall.content ?? []) {
    const fields = recordOf(entry);
    if (fields?.type === "diff" && typeof fields.path === "string") targets.add(fields.path);
  }
  for (const key of TARGET_KEYS) if (typeof raw?.[key] === "string") targets.add(raw[key]);
  if (targets.size === 0) return false;
  const root = canonicalWorkspaceRoot(workspaceRoot);
  if (!root) return false;
  for (const target of targets) {
    if (!target || target.includes("\0") || !NodePath.isAbsolute(target)) return false;
    const canonical = canonicalTarget(target);
    if (!canonical) return false;
    const relative = NodePath.relative(root, canonical);
    if (
      relative === "" ||
      isParentTraversal(relative) ||
      NodePath.isAbsolute(relative) ||
      isGitMetadata(relative)
    )
      return false;
  }
  return true;
}
