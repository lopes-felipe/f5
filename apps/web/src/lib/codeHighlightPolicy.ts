/**
 * How a fenced code block is highlighted, decided before any highlighter code
 * loads. Small blocks highlight inline, larger ones in a web worker, and huge
 * ones render as plain text until the user asks for highlighting.
 */

/** Above either limit a block renders as plain text with highlight-on-demand. */
export const CODE_HIGHLIGHT_ON_DEMAND_MIN_BYTES = 200 * 1024;
export const CODE_HIGHLIGHT_ON_DEMAND_MIN_LINES = 4_000;
/** Above either limit (and below on-demand) highlighting runs in a worker. */
export const CODE_HIGHLIGHT_WORKER_MIN_CHARS = 16 * 1024;
export const CODE_HIGHLIGHT_WORKER_MIN_LINES = 400;

export type CodeHighlightMode = "inline" | "worker" | "on-demand";

/** Counts lines without allocating a split array; stops once past `limit`. */
function countLinesUpTo(code: string, limit: number): number {
  let lines = 1;
  for (
    let index = code.indexOf("\n");
    index !== -1 && lines <= limit;
    index = code.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines;
}

export function classifyCodeHighlight(code: string): CodeHighlightMode {
  // UTF-16 length is a lower bound on UTF-8 bytes, which is close enough here.
  if (code.length > CODE_HIGHLIGHT_ON_DEMAND_MIN_BYTES) return "on-demand";
  const lines = countLinesUpTo(code, CODE_HIGHLIGHT_ON_DEMAND_MIN_LINES);
  if (lines > CODE_HIGHLIGHT_ON_DEMAND_MIN_LINES) return "on-demand";
  if (code.length > CODE_HIGHLIGHT_WORKER_MIN_CHARS || lines > CODE_HIGHLIGHT_WORKER_MIN_LINES) {
    return "worker";
  }
  return "inline";
}

// Fence names that differ from Shiki's ids or aliases.
const FENCE_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685).
  gitignore: "ini",
  dockerignore: "ini",
  plaintext: "text",
  plain: "text",
  txt: "text",
};

const FENCE_LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9_+#.-]*$/;

/**
 * One cache and highlighter key per language: lower-cased, attribute suffixes
 * such as `ts{1,3}` or `js:title` dropped, and aliases mapped. Anything that
 * is not a plausible language name becomes `text`.
 */
export function normalizeFenceLanguage(raw: string | undefined): string {
  if (!raw) return "text";
  const name =
    raw
      .trim()
      .toLowerCase()
      .split(/[{:,\s]/, 1)[0] ?? "";
  if (!FENCE_LANGUAGE_PATTERN.test(name) || name.length > 32) return "text";
  return FENCE_LANGUAGE_ALIASES[name] ?? name;
}
