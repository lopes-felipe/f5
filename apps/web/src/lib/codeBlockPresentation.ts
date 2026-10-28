/**
 * Header and fold presentation for fenced code blocks in chat markdown. The
 * language input is already normalized by `normalizeFenceLanguage`.
 */

/** Blocks with more lines than this fold on settled, non-latest assistant messages. */
export const CODE_BLOCK_FOLD_MIN_LINES = 30;
/** Lines left visible above the fade while a block is folded. */
export const CODE_BLOCK_FOLD_VISIBLE_LINES = 18;
/** The header shows a line count from this many lines. */
export const CODE_BLOCK_LINE_COUNT_MIN_LINES = 10;
const MAX_CODE_BLOCK_FILE_PATH_LENGTH = 256;

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  ts: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  python: "Python",
  py: "Python",
  shell: "Shell",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  console: "Shell",
  shellscript: "Shell",
  "shell-session": "Shell",
  json: "JSON",
  jsonc: "JSON",
  yaml: "YAML",
  yml: "YAML",
  markdown: "Markdown",
  md: "Markdown",
  diff: "Diff",
  patch: "Diff",
  go: "Go",
  rust: "Rust",
  rs: "Rust",
  ruby: "Ruby",
  rb: "Ruby",
  kotlin: "Kotlin",
  kt: "Kotlin",
  swift: "Swift",
  java: "Java",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  toml: "TOML",
  dockerfile: "Dockerfile",
  text: "Text",
};

export function codeBlockLanguageLabel(normalized: string): string {
  if (!normalized) return "Text";
  return LANGUAGE_LABELS[normalized] ?? normalized;
}

/**
 * The path in a ```` ```ts:src/a.ts ```` info string. A path with spaces splits
 * into fence meta, which shows no path rather than half of one.
 */
export function codeBlockFilePath(
  lang: string | null | undefined,
  meta: string | null | undefined,
): string | null {
  if (!lang || (meta != null && meta.trim() !== "")) return null;
  const separator = lang.indexOf(":");
  if (separator === -1) return null;
  const path = lang.slice(separator + 1);
  return path.length > 0 && path.length <= MAX_CODE_BLOCK_FILE_PATH_LENGTH ? path : null;
}

/** Source lines, ignoring the single trailing newline a fence body carries. */
export function codeLineCount(code: string): number {
  const body = code.endsWith("\n") ? code.slice(0, -1) : code;
  if (body.length === 0) return code.length === 0 ? 0 : 1;
  let lines = 1;
  for (let index = body.indexOf("\n"); index !== -1; index = body.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}
