import { formatPatch, OMIT_HEADERS, structuredPatch } from "diff";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  ANTIGRAVITY_EDIT_DIFF_OMITTED,
  antigravityEditPatch,
  isAntigravitySnippetPatch,
  readAntigravityPreEditFile,
} from "./AntigravityEditLocation.ts";
import { antigravityArtifactWrite } from "./AntigravityPlanArtifacts.ts";

const CUT = "[Earlier output truncated]\n\n";
export const boundAntigravityToolText = (text: string) =>
  text.length <= 8000 ? text : CUT + text.slice(-8000);
export const isCutAntigravityToolText = (text: string) => text.includes(CUT);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function sanitizeAntigravityToolPayload(value: unknown): unknown {
  const budget = { nodes: 512, text: 64000 };
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 12 || budget.nodes-- <= 0) return undefined;
    if (typeof input === "string") {
      if (/^data:image\//i.test(input) || budget.text <= 0) return undefined;
      const bounded = boundAntigravityToolText(input).slice(-budget.text);
      budget.text -= bounded.length;
      return bounded;
    }
    if (Array.isArray(input))
      return input
        .slice(0, 512)
        .map((item) => visit(item, depth + 1))
        .filter((item) => item !== undefined);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input)
        .slice(0, 512)
        .flatMap(([key, item]) => {
          if ((key === "data" || key === "blob") && record(input).type === "image") return [];
          const next = visit(item, depth + 1);
          return next === undefined ? [] : [[key, next]];
        }),
    );
  };
  return visit(value, 0);
}

const OMITTED_PATCH = { format: "omitted" } as const;
// One budget per update, shared by its entries: the diffs run synchronously on the event loop
// and their patches are attached after the sanitizer's own payload budget.
const FULL_TEXT_PATCH_BUDGET_CHARS = 64 * 1024;
const FULL_TEXT_DIFF_BUDGET_MS = 200;

/** How one diff entry is shown: its patch, plus the change kind when it adds a file. */
interface DiffResolution {
  readonly patch?: unknown;
  readonly changes?: ReadonlyArray<Record<string, unknown>>;
}

const editKind = (tool: AcpToolCallState) => {
  if (tool.kind !== "other" && tool.kind) return tool.kind;
  const title = tool.title ?? "";
  return /(?:replace_file_content|write_to_file)/.test(title)
    ? "edit"
    : /(?:view_file|read_file)/.test(title)
      ? "read"
      : /(?:run_command|command_status)/.test(title)
        ? "execute"
        : tool.kind;
};

/** The replaced snippets an edit names, in any casing the runtime accepts. */
function snippetTargets(rawInput: unknown): ReadonlyArray<string> {
  const raw = record(rawInput);
  const chunks = [raw.ReplacementChunks, raw.replacement_chunks].flatMap((value) =>
    Array.isArray(value) ? value.map(record) : [],
  );
  return [raw, ...chunks].flatMap((chunk) =>
    [chunk.TargetContent, chunk.target_content, chunk.Target].filter(
      (value): value is string => typeof value === "string",
    ),
  );
}

interface DiffBudget {
  chars: number;
  readonly deadline: number;
}

/** Hunks only; `acpFileChanges` adds the file headers. Undefined when nothing changed. */
function hunkPatch(path: string, oldText: string, newText: string, budget: DiffBudget): unknown {
  if (oldText === newText) return undefined;
  const remainingMs = budget.deadline - performance.now();
  if (remainingMs <= 0 || budget.chars <= 0) return OMITTED_PATCH;
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, {
    context: 3,
    maxEditLength: 100_000,
    timeout: Math.min(100, Math.ceil(remainingMs)),
  });
  if (!patch) return OMITTED_PATCH;
  if (patch.hunks.length === 0) return undefined;
  const text = formatPatch(patch, OMIT_HEADERS);
  if (text.length > budget.chars) return OMITTED_PATCH;
  budget.chars -= text.length;
  return { text };
}

const normalizeEol = (text: string) => text.replaceAll("\r\n", "\n");

/**
 * Current releases complete an edit with the whole file before and after it, and a write with
 * the whole new file. Older releases sent the replaced snippet as `oldText`. So `oldText` counts
 * as the whole file only when it is not a snippet itself and contains every replaced snippet;
 * anything else keeps the snippet path.
 */
function fullTextKind(
  entry: Record<string, unknown>,
  rawInput: unknown,
): "edit" | "add" | "overwrite" | undefined {
  const { path, oldText, newText } = entry;
  if (typeof path !== "string" || typeof newText !== "string") return undefined;
  const snippets = snippetTargets(rawInput);
  if (typeof oldText === "string") {
    const file = normalizeEol(oldText);
    const targets = snippets.map(normalizeEol);
    if (targets.length === 0 || targets.includes(file)) return undefined;
    return targets.every((target) => file.includes(target)) ? "edit" : undefined;
  }
  if (oldText != null || snippets.length > 0) return undefined;
  const raw = record(rawInput);
  return (raw.Overwrite ?? raw.overwrite) === true ? "overwrite" : "add";
}

/** Only a completed update is diffed; earlier ones name the file and nothing more. */
function fullTextDiff(
  entry: Record<string, unknown>,
  kind: "edit" | "add" | "overwrite",
  completed: boolean,
  budget: DiffBudget,
): DiffResolution {
  const path = entry.path as string;
  const newText = entry.newText as string;
  // An overwrite replaced content this update does not carry; the checkpoint diff shows it.
  if (kind === "overwrite" || !completed) return { patch: OMITTED_PATCH };
  if (kind === "add")
    return {
      // An empty new file has no hunks; keep its path rather than drop the entry.
      patch: hunkPatch(path, "", newText, budget) ?? OMITTED_PATCH,
      changes: [{ path, operation: "add" }],
    };
  return { patch: hunkPatch(path, entry.oldText as string, newText, budget) };
}

/**
 * Retain pending diff locations before native edits change the source file.
 * Writes into the brain directories under `brainRoots` are Antigravity's own
 * artifacts, not workspace changes.
 */
export function makeAntigravityToolNormalizer(
  readFile = readAntigravityPreEditFile,
  brainRoots: ReadonlyArray<string> = [],
) {
  const patches = new Map<string, unknown>();
  const resolutions = new Map<string, DiffResolution>();
  const remember = (key: string, resolution: DiffResolution) => {
    resolutions.set(key, resolution);
    if (resolutions.size > 256) resolutions.delete(resolutions.keys().next().value!);
    return resolution;
  };
  return (tool: AcpToolCallState): AcpToolCallState => {
    const artifact = antigravityArtifactWrite(tool, brainRoots);
    if (artifact) {
      const raw = record(tool.data.rawInput);
      const summary = record(raw.ArtifactMetadata).Summary;
      return {
        ...tool,
        kind: "other",
        title: `${artifact.requestsFeedback ? "Updated plan artifact" : "Updated artifact"} ${artifact.basename}`,
        data: {
          rawInput: {
            Path: artifact.path,
            ...(typeof summary === "string" && summary.trim()
              ? { summary: boundAntigravityToolText(summary.trim()) }
              : {}),
          },
        },
      };
    }
    const kind = editKind(tool);
    // Full before/after texts become a patch before sanitizing, which keeps only each string's
    // last 8000 characters; the texts themselves are dropped, never stored cut.
    const fullText = new Map<number, DiffResolution>();
    let source: unknown = tool.data;
    if (kind === "edit" && Array.isArray(tool.data.content)) {
      const rawContent = tool.data.content;
      const completed = tool.status === "completed";
      const budget: DiffBudget = {
        chars: FULL_TEXT_PATCH_BUDGET_CHARS,
        deadline: performance.now() + FULL_TEXT_DIFF_BUDGET_MS,
      };
      source = {
        ...tool.data,
        content: rawContent.map((item, index) => {
          const entry = record(item);
          if (entry.type !== "diff" || typeof entry.path !== "string") return item;
          const key = tool.toolCallId + ":" + index;
          const textKind = fullTextKind(entry, tool.data.rawInput);
          // Only completed patches are cached, so a preview never shadows the final texts.
          // A later update without texts reuses the completed result.
          let resolution = resolutions.get(key);
          if (!resolution && textKind) {
            resolution = fullTextDiff(entry, textKind, completed, budget);
            if (completed && resolution.patch !== undefined) remember(key, resolution);
          }
          if (!resolution) return item;
          fullText.set(index, resolution);
          const { oldText: _oldText, newText: _newText, ...rest } = entry;
          return rest;
        }),
      };
    }
    const data = record(sanitizeAntigravityToolPayload(source));
    const raw = record(data.rawInput);
    const command = raw.CommandLine ?? raw.command_line ?? raw.command;
    if (typeof command === "string") data.command = command;
    // Antigravity's own one-line summary ("Inspect repository top-level layout") becomes the
    // card header; F5 otherwise derives a generic label from the command. Commands only: other
    // tools' `input.description` already titles subagent and task cards.
    const summary =
      kind === "execute" && typeof raw.toolSummary === "string" ? raw.toolSummary.trim() : "";
    const input = record(data.input);
    if (summary && typeof input.description !== "string")
      data.input = { ...input, description: summary };
    if (kind === "edit") {
      const content = Array.isArray(data.content) ? data.content : [];
      data.content = content.map((item, index) => {
        const entry = record(item);
        if (entry.type !== "diff" || typeof entry.path !== "string") return item;
        const exact = fullText.get(index);
        if (exact) {
          const { patch: _patch, ...rest } = entry;
          return {
            ...rest,
            ...(exact.patch ? { patch: exact.patch } : {}),
            ...(exact.changes ? { changes: exact.changes } : {}),
          };
        }
        const key = tool.toolCallId + ":" + index;
        let patch = patches.get(key) ?? entry.patch;
        if (!patch) {
          const text = antigravityEditPatch({
            path: entry.path,
            rawInput: data.rawInput,
            locations: data.locations,
            readPreEditFile: tool.status === "pending" ? readFile : undefined,
          });
          patch =
            text === ANTIGRAVITY_EDIT_DIFF_OMITTED ||
            (typeof text === "string" && (text.length > 8000 || isAntigravitySnippetPatch(text)))
              ? { format: "omitted" }
              : typeof text === "string"
                ? { text }
                : { format: "omitted" };
          patches.set(key, patch);
          if (patches.size > 256) patches.delete(patches.keys().next().value!);
        }
        return { ...entry, patch };
      });
    }
    return { ...tool, ...(kind ? { kind } : {}), data };
  };
}
