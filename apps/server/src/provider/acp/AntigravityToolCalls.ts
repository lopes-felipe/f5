import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  ANTIGRAVITY_EDIT_DIFF_OMITTED,
  antigravityEditPatch,
  isAntigravitySnippetPatch,
  readAntigravityPreEditFile,
} from "./AntigravityEditLocation.ts";

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

/** Retain pending diff locations before native edits change the source file. */
export function makeAntigravityToolNormalizer(readFile = readAntigravityPreEditFile) {
  const patches = new Map<string, unknown>();
  return (tool: AcpToolCallState): AcpToolCallState => {
    const data = record(sanitizeAntigravityToolPayload(tool.data));
    const raw = record(data.rawInput);
    const title = tool.title ?? "";
    const kind =
      tool.kind === "other" || !tool.kind
        ? /(?:replace_file_content|write_to_file)/.test(title)
          ? "edit"
          : /(?:view_file|read_file)/.test(title)
            ? "read"
            : /(?:run_command|command_status)/.test(title)
              ? "execute"
              : tool.kind
        : tool.kind;
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
