/**
 * How a command's output is presented in the transcript card: file content,
 * search results, a diff, JSON, ANSI-colored text, or plain text. Derived from
 * the command and the output alone, and conservative: anything that does not
 * parse cleanly is plain text. Presentations never change the output's text
 * except to move line-number prefixes into a gutter and drop escape codes.
 */
import {
  isDiffCommand,
  parseFileReadSegments,
  parseSearchOutputCommand,
  type SearchOutputCommand,
} from "@t3tools/shared/commandSummary";
import { getFiletypeFromFileName } from "@pierre/diffs";

import { hasAnsiEscapes, parseAnsiOutput, stripAnsi, type AnsiSpan } from "./ansiOutput";
import { resolvePathLinkTarget } from "../terminal-links";

export type CommandOutputStatus = "running" | "completed" | "failed" | "interrupted" | "declined";

export interface ClassifyCommandOutputInput {
  readonly command: string;
  /** The output text being shown, possibly a shortened preview. */
  readonly output: string;
  readonly status: CommandOutputStatus;
  readonly cwd?: string | null | undefined;
  readonly exitCode?: number | null | undefined;
  /**
   * Lines are missing from `output`: a client head/tail preview, or output the
   * server compacted around a marker. Line numbers and totals are unreliable.
   */
  readonly shortened?: boolean | undefined;
}

/** `[start, end)` character range within a line's text. */
export type MatchRange = readonly [number, number];

export interface SearchLine {
  readonly lineNumber: number;
  readonly text: string;
  /** A matching line (`:`) rather than a context line (`-`). */
  readonly isMatch: boolean;
  readonly matches: ReadonlyArray<MatchRange>;
}

export type SearchSegment =
  | {
      readonly type: "group";
      /** The path as printed, or the single searched file. */
      readonly displayPath: string;
      /**
       * Resolved against the command's cwd, for opening; null without a path
       * (`grep -h`) or when a `cd` before the search may have failed.
       */
      readonly filePath: string | null;
      readonly language: string;
      /** False when the previous group is the same file. */
      readonly showHeader: boolean;
      readonly lines: ReadonlyArray<SearchLine>;
    }
  | { readonly type: "separator" }
  | { readonly type: "plain"; readonly text: string };

export type DiffRowKind = "meta" | "hunk" | "add" | "del" | "context";

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** The whole line, including its `+`/`-`/space prefix. */
  readonly text: string;
  /** New-side number for added and context rows, old-side for removed rows. */
  readonly lineNumber: number | null;
}

export interface DiffFileSection {
  /** Null for leading text such as `git log -p` commit headers. */
  readonly displayPath: string | null;
  readonly language: string;
  readonly rows: ReadonlyArray<DiffRow>;
}

export type CommandOutputPresentation =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "json"; readonly text: string }
  | {
      readonly kind: "ansi";
      readonly text: string;
      readonly lines: ReadonlyArray<ReadonlyArray<AnsiSpan>>;
    }
  | {
      readonly kind: "file";
      /**
       * The one file read, or null when the command read several files.
       * `filePath` is null when where it ran is unknown, so it cannot be opened.
       */
      readonly file: { readonly displayPath: string; readonly filePath: string | null } | null;
      readonly fileCount: number;
      readonly language: string;
      /** The file text shown, without any line-number prefixes. */
      readonly code: string;
      /** One per line of `code`, or null when the numbers are unknown. */
      readonly lineNumbers: ReadonlyArray<number> | null;
    }
  | {
      readonly kind: "search";
      readonly segments: ReadonlyArray<SearchSegment>;
      readonly matchCount: number;
      readonly fileCount: number;
      /** Counts cover only the lines shown, not the whole output. */
      readonly partial: boolean;
    }
  | {
      readonly kind: "diff";
      readonly files: ReadonlyArray<DiffFileSection>;
      readonly additions: number;
      readonly deletions: number;
      readonly showLineNumbers: boolean;
      /** Counts cover only the lines shown, not the whole output. */
      readonly partial: boolean;
    };

/**
 * Above this many lines the output renders as one plain block: a row per
 * line would cost far more than the text, and nobody scans that much.
 */
export const MAX_PRESENTED_LINES = 4_000;

/** Counts output rows like `outputLines`: a final line break ends the last row. */
function countLinesUpTo(output: string, limit: number): number {
  const text = output.endsWith("\n") ? output.slice(0, output.endsWith("\r\n") ? -2 : -1) : output;
  let lines = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1 && lines <= limit;
    index = text.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines;
}

/** Language id for syntax highlighting, or "text" when unknown. */
export function languageForPath(path: string): string {
  try {
    return getFiletypeFromFileName(path) ?? "text";
  } catch {
    return "text";
  }
}

/** Output lines without the line break after the last one. */
function outputLines(output: string): string[] {
  const lines = output.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeDotSegments(path: string): string {
  if (!path.includes("/.")) return path;
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "." || (part === "" && parts.length > 0)) continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      if (!(absolute && parts.length === 1 && parts[0] === "")) parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute && !joined.startsWith("/") ? `/${joined}` : joined;
}

/** Resolves a path printed by a command against its cwd and any `cd` in it. */
export function resolveCommandPath(
  path: string,
  cwd: string | null | undefined,
  cwdOffset: string | null,
): string {
  const base = cwdOffset ? (cwd ? resolvePathLinkTarget(cwdOffset, cwd) : cwdOffset) : cwd;
  if (!base) return path;
  return normalizeDotSegments(resolvePathLinkTarget(path, base));
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ---------------------------------------------------------------------------
// File reads

const NUMBERED_LINE_PATTERN = /^\s*(\d+)\t(.*)$/;

function classifyFileRead(input: ClassifyCommandOutputInput): CommandOutputPresentation | null {
  const parsed = parseFileReadSegments(input.command);
  if (!parsed) return null;
  const languages = new Set(parsed.segments.map((segment) => languageForPath(segment.filePath)));
  if (languages.size !== 1) return null;
  const [first] = parsed.segments;
  if (!first || input.output.length === 0) return null;
  const language = [...languages][0]!;
  const single = parsed.segments.length === 1;
  const lines = outputLines(input.output);

  let code = input.output;
  let lineNumbers: number[] | null = null;
  if (parsed.segments.every((segment) => segment.numberedOutput)) {
    const numbers: number[] = [];
    const texts: string[] = [];
    for (const line of lines) {
      const match = NUMBERED_LINE_PATTERN.exec(line);
      if (!match) {
        // `nl -ba` numbers every line; an unnumbered one means the output is
        // not what we think (an error message, a shortened preview marker).
        if (line.trim().length === 0) {
          texts.push(line);
          numbers.push(numbers.length > 0 ? numbers[numbers.length - 1]! + 1 : 1);
          continue;
        }
        return null;
      }
      numbers.push(Number.parseInt(match[1]!, 10));
      texts.push(match[2]!);
    }
    code = texts.join("\n");
    lineNumbers = numbers;
  } else if (parsed.segments.some((segment) => segment.numberedOutput)) {
    return null;
  } else {
    code = lines.join("\n");
    if (single && first.startLine !== null && !input.shortened) {
      lineNumbers = lines.map((_, index) => first.startLine! + index);
    }
  }

  // Reads of different files in one language are highlighted together, but
  // no single file can be named or opened for them. A read after `cd x;` may
  // have run in either directory, so it is named but cannot be opened.
  const filePaths = new Set(
    parsed.segments.map((segment) =>
      resolveCommandPath(segment.filePath, input.cwd, segment.cwdOffset),
    ),
  );
  const displayPaths = new Set(parsed.segments.map((segment) => segment.filePath));
  const cwdKnown = parsed.segments.every((segment) => segment.cwdKnown);
  const file =
    filePaths.size === 1 && cwdKnown
      ? {
          displayPath: first.filePath,
          filePath: resolveCommandPath(first.filePath, input.cwd, first.cwdOffset),
        }
      : displayPaths.size === 1
        ? { displayPath: first.filePath, filePath: null }
        : null;
  return {
    kind: "file",
    file,
    fileCount: displayPaths.size,
    language,
    code,
    lineNumbers: single ? lineNumbers : null,
  };
}

// ---------------------------------------------------------------------------
// Search results

const BRE_LITERAL_IN_JS = new Set(["(", ")", "{", "}", "|", "+", "?"]);
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  space: "\\s",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** POSIX basic regex to JS: `\|`, `\(`, `\{`, `\+` and `\?` are the operators. */
function basicRegexToJs(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      const next = pattern[index + 1];
      if (next === undefined) return `${result}\\\\`;
      result += BRE_LITERAL_IN_JS.has(next) ? next : `\\${next}`;
      index += 1;
      continue;
    }
    result += BRE_LITERAL_IN_JS.has(char) ? `\\${char}` : char;
  }
  return result;
}

function posixClassesToJs(pattern: string): string {
  return pattern.replace(/\[:([a-z]+):\]/g, (whole, name: string) => POSIX_CLASSES[name] ?? whole);
}

/** Quantifiers that can repeat without limit (`*`, `+`, `{n,}`, large `{n,m}`). */
const MAX_UNBOUNDED_QUANTIFIERS = 2;
/** All quantifiers, `?` and `{n}` included. */
const MAX_QUANTIFIERS = 8;
/** A `{n,m}` bound above this counts as unbounded. */
const LARGE_REPEAT_BOUND = 32;
const QUANTIFIER_PATTERN = /^(?:[*+?]|\{(\d+)(?:(,)(\d*))?\})/;

/**
 * Whether a JS regex source could backtrack badly. grep and ripgrep match in
 * linear time, but this runs in the UI thread's backtracking engine, so these
 * get no match marks rather than a chance to hang:
 * - backreferences;
 * - a quantified group that contains any quantifier or an alternation, such
 *   as `(a+)*`, `(a|ab)+`, `(a?){30}` or `(a{0,30}){0,30}`;
 * - more than {@link MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers
 *   (`.*.*.*x`), or more than {@link MAX_QUANTIFIERS} quantifiers of any kind
 *   (thirty `a?` in a row).
 */
export function isRiskyRegexSource(source: string): boolean {
  if (/\\[1-9]|\\k</.test(source)) return true;
  // Each open group records whether it contains a quantifier or alternation.
  const groups: boolean[] = [];
  let unbounded = 0;
  let quantifiers = 0;
  let inClass = false;
  // Whether the previous token can take a quantifier (so `?` after `(` or
  // after another quantifier is syntax, not a repeat).
  let quantifiable = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      index += 1;
      quantifiable = true;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
        quantifiable = true;
      }
      continue;
    }
    const quantifier = quantifiable ? QUANTIFIER_PATTERN.exec(source.slice(index)) : null;
    if (quantifier) {
      const [text, min, comma, max] = quantifier;
      const isUnbounded =
        text === "*" ||
        text === "+" ||
        (comma === "," && (max === "" || Number(max) > LARGE_REPEAT_BOUND)) ||
        Number(min ?? 0) > LARGE_REPEAT_BOUND;
      quantifiers += 1;
      if (isUnbounded) unbounded += 1;
      groups.fill(true);
      index += text.length - 1;
      // A lazy or possessive suffix (`+?`) is part of this quantifier.
      if (source[index + 1] === "?") index += 1;
      quantifiable = false;
      continue;
    }
    quantifiable = true;
    if (char === "[") {
      inClass = true;
      quantifiable = false;
    } else if (char === "(") {
      groups.push(false);
      quantifiable = false;
    } else if (char === "|") {
      groups.fill(true);
      quantifiable = false;
    } else if (char === ")") {
      const repeatsInside = groups.pop() ?? false;
      if (repeatsInside && QUANTIFIER_PATTERN.test(source.slice(index + 1))) return true;
    }
  }
  return unbounded > MAX_UNBOUNDED_QUANTIFIERS || quantifiers > MAX_QUANTIFIERS;
}

/** A global matcher for the search's patterns, or null when they do not translate. */
export function buildSearchMatcher(
  search: Pick<
    SearchOutputCommand,
    "patterns" | "fixedStrings" | "ignoreCase" | "extendedRegex" | "perlRegex"
  >,
): RegExp | null {
  if (search.perlRegex && !search.fixedStrings) return null;
  const sources = search.patterns
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => {
      if (search.fixedStrings) return escapeRegExp(pattern);
      const source = search.extendedRegex ? pattern : basicRegexToJs(pattern);
      return posixClassesToJs(source);
    });
  if (sources.length === 0) return null;
  const source = sources.map((part) => `(?:${part})`).join("|");
  if (!search.fixedStrings && isRiskyRegexSource(source)) return null;
  try {
    const matcher = new RegExp(source, search.ignoreCase ? "gi" : "g");
    // A pattern that matches the empty string would mark nothing useful.
    return matcher.test("") ? null : ((matcher.lastIndex = 0), matcher);
  } catch {
    return null;
  }
}

const MAX_MATCHES_PER_LINE = 64;
/** Matching stops here even for safe patterns, bounding work per line. */
const MAX_MATCH_TEXT_CHARS = 1_000;
/** Lines beyond this many get no marks, bounding work per output. */
const MAX_MARKED_LINES = 200;

export function findMatchRanges(text: string, matcher: RegExp | null): MatchRange[] {
  if (!matcher) return [];
  const ranges: MatchRange[] = [];
  const searched = text.slice(0, MAX_MATCH_TEXT_CHARS);
  matcher.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(searched)) !== null && ranges.length < MAX_MATCHES_PER_LINE) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
  }
  matcher.lastIndex = 0;
  return ranges;
}

const PATH_LINE_PATTERN = /^((?:[A-Za-z]:)?[^:\n]+):(\d+)([:-])(.*)$/;
const NUMBER_LINE_PATTERN = /^(\d+)([:-])(.*)$/;

function searchesSingleFile(search: SearchOutputCommand): boolean {
  const [target] = search.targets;
  if (search.targets.length !== 1 || !target) return false;
  if (search.tool === "grep") return !search.recursive;
  // ripgrep prints no path for a lone file argument; guess files by extension.
  return /\.[A-Za-z0-9]+$/.test(basename(target));
}

interface ParsedSearchLine {
  readonly path: string | null;
  readonly lineNumber: number;
  readonly isMatch: boolean;
  readonly text: string;
}

function parseSearchLine(
  line: string,
  search: SearchOutputCommand,
  singleFile: string | null,
  matchPaths: ReadonlySet<string>,
): ParsedSearchLine | null {
  if (singleFile !== null || search.noFileName) {
    const match = NUMBER_LINE_PATTERN.exec(line);
    if (!match) return null;
    return {
      path: singleFile,
      lineNumber: Number.parseInt(match[1]!, 10),
      isMatch: match[2] === ":",
      text: match[3]!,
    };
  }
  const match = PATH_LINE_PATTERN.exec(line);
  const context = parseContextLine(line, matchPaths);
  const matchRow = match
    ? {
        path: match[1]!,
        lineNumber: Number.parseInt(match[2]!, 10),
        isMatch: match[3] === ":",
        text: match[4]!,
      }
    : null;
  if (matchRow?.isMatch) {
    // `a-1-file.ts:9:foo` is a match in `a-1-file.ts` or line 1 of `a`; when
    // both files printed matches there is no telling which.
    return context && context.path !== matchRow.path ? null : matchRow;
  }
  return context ?? matchRow;
}

/**
 * A context line, `path-12-text`. That is ambiguous on its own (paths contain
 * hyphens), so the path must be one that a match line printed.
 */
function parseContextLine(line: string, matchPaths: ReadonlySet<string>): ParsedSearchLine | null {
  for (let index = line.indexOf("-"); index > 0; index = line.indexOf("-", index + 1)) {
    const context = /^(\d+)-(.*)$/.exec(line.slice(index + 1));
    if (context && matchPaths.has(line.slice(0, index))) {
      return {
        path: line.slice(0, index),
        lineNumber: Number.parseInt(context[1]!, 10),
        isMatch: false,
        text: context[2]!,
      };
    }
  }
  return null;
}

function classifySearch(input: ClassifyCommandOutputInput): CommandOutputPresentation | null {
  const search = parseSearchOutputCommand(input.command);
  // Without line numbers a leading `2026-11-23` or `12:` in the matched text
  // would be read as one, so unnumbered output stays plain.
  if (!search?.lineNumbers || input.output.length === 0) return null;
  const singleFile = searchesSingleFile(search) ? search.targets[0]! : null;
  const matcher = buildSearchMatcher(search);
  const segments: SearchSegment[] = [];
  const paths = new Set<string>();
  let matchCount = 0;
  const state: {
    group: { displayPath: string; lines: SearchLine[] } | null;
    lastGroupPath: string | null;
    plainLines: string[];
  } = { group: null, lastGroupPath: null, plainLines: [] };

  const flushPlain = () => {
    if (state.plainLines.length === 0) return;
    segments.push({ type: "plain", text: state.plainLines.join("\n") });
    state.plainLines = [];
  };
  const flushGroup = () => {
    const group = state.group;
    if (!group) return;
    segments.push({
      type: "group",
      displayPath: group.displayPath,
      filePath:
        group.displayPath.length > 0 && search.cwdKnown
          ? resolveCommandPath(group.displayPath, input.cwd, search.cwdOffset)
          : null,
      language: languageForPath(group.displayPath),
      showHeader: group.displayPath !== state.lastGroupPath,
      lines: group.lines,
    });
    state.lastGroupPath = group.displayPath;
    state.group = null;
  };

  const lines = outputLines(input.output);
  const matchPaths = new Set<string>();
  for (const line of lines) {
    const match = PATH_LINE_PATTERN.exec(line);
    if (match?.[3] === ":") matchPaths.add(match[1]!);
  }
  // Output of statements after the search follows its matches. Once a line
  // is not a result, or a file's line numbers stop increasing, every later
  // line is that output, even one shaped like `12: build complete`.
  let searchEnded = false;
  const lastLineByPath = new Map<string, number>();
  for (const line of lines) {
    if (searchEnded) {
      state.plainLines.push(line);
      continue;
    }
    if (line === "--") {
      flushGroup();
      flushPlain();
      segments.push({ type: "separator" });
      continue;
    }
    const parsed = parseSearchLine(line, search, singleFile, matchPaths);
    const displayPath = parsed?.path ?? "";
    const outOfOrder =
      parsed !== null && parsed.lineNumber <= (lastLineByPath.get(displayPath) ?? 0);
    if (!parsed || (search.followedByOtherStatements && outOfOrder)) {
      flushGroup();
      state.plainLines.push(line);
      searchEnded = search.followedByOtherStatements;
      continue;
    }
    lastLineByPath.set(displayPath, parsed.lineNumber);
    flushPlain();
    if (state.group && state.group.displayPath !== displayPath) flushGroup();
    const group = state.group ?? { displayPath, lines: [] };
    state.group = group;
    if (parsed.isMatch) matchCount += 1;
    if (displayPath) paths.add(displayPath);
    group.lines.push({
      lineNumber: parsed.lineNumber,
      text: parsed.text,
      isMatch: parsed.isMatch,
      matches:
        parsed.isMatch && matchCount <= MAX_MARKED_LINES
          ? findMatchRanges(parsed.text, matcher)
          : [],
    });
  }
  flushGroup();
  flushPlain();
  if (!segments.some((segment) => segment.type === "group")) return null;
  return {
    kind: "search",
    segments,
    matchCount,
    fileCount: paths.size,
    partial: input.shortened === true,
  };
}

// ---------------------------------------------------------------------------
// Diffs

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripDiffPathPrefix(path: string): string | null {
  const trimmed = path.split("\t")[0]!.trim();
  if (trimmed === "/dev/null") return null;
  return trimmed.replace(/^[ab]\//, "");
}

function looksLikeDiff(output: string): boolean {
  return /^(?:diff --git |--- )/m.test(output) && /^@@+ -\d+/m.test(output);
}

function classifyDiff(input: ClassifyCommandOutputInput): CommandOutputPresentation | null {
  const output = input.output;
  if (!looksLikeDiff(output)) return null;
  if (!isDiffCommand(input.command) && !/^(?:diff --git |--- )/.test(output)) return null;

  const files: Array<{ displayPath: string | null; rows: DiffRow[] }> = [];
  let current: { displayPath: string | null; rows: DiffRow[] } = { displayPath: null, rows: [] };
  let oldLine = 0;
  let newLine = 0;
  // Lines left in the current hunk, from its header; content lines are only
  // read while some remain, so a removed `--- x` line is never a file header.
  let oldRemaining = 0;
  let newRemaining = 0;
  let currentHasHunk = false;
  let hunkCount = 0;
  // A hunk that ended before all the rows its header declared (`| head`).
  let incompleteHunk = false;
  let additions = 0;
  let deletions = 0;

  const startFile = () => {
    if (current.rows.length > 0) files.push(current);
    current = { displayPath: null, rows: [] };
    currentHasHunk = false;
  };
  const meta = (line: string) => current.rows.push({ kind: "meta", text: line, lineNumber: null });

  for (const line of outputLines(output)) {
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith("+") && newRemaining > 0) {
        additions += 1;
        newRemaining -= 1;
        current.rows.push({ kind: "add", text: line, lineNumber: newLine++ });
        continue;
      }
      if (line.startsWith("-") && oldRemaining > 0) {
        deletions += 1;
        oldRemaining -= 1;
        current.rows.push({ kind: "del", text: line, lineNumber: oldLine++ });
        continue;
      }
      // Some tools strip the trailing space from empty context lines.
      if ((line.startsWith(" ") || line === "") && oldRemaining > 0 && newRemaining > 0) {
        oldRemaining -= 1;
        newRemaining -= 1;
        oldLine += 1;
        current.rows.push({ kind: "context", text: line, lineNumber: newLine++ });
        continue;
      }
      if (line.startsWith("\\")) {
        meta(line);
        continue;
      }
      // Malformed or shortened hunk: stop reading it as content.
      incompleteHunk = true;
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (line.startsWith("\\")) {
      meta(line);
      continue;
    }
    if (line.startsWith("diff ")) {
      startFile();
      current.displayPath = /^diff --git a\/(.+) b\/(.+)$/.exec(line)?.[2] ?? null;
      meta(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      // In plain `diff -u` output a `---` header is the only file boundary.
      if (currentHasHunk) startFile();
      const path = stripDiffPathPrefix(line.slice(4));
      if (path && current.displayPath === null) current.displayPath = path;
      meta(line);
      continue;
    }
    if (line.startsWith("+++ ") && !currentHasHunk) {
      const path = stripDiffPathPrefix(line.slice(4));
      if (path) current.displayPath = path;
      meta(line);
      continue;
    }
    const hunk = HUNK_HEADER_PATTERN.exec(line);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10);
      oldRemaining = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
      newLine = Number.parseInt(hunk[3]!, 10);
      newRemaining = hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10);
      currentHasHunk = true;
      hunkCount += 1;
      current.rows.push({ kind: "hunk", text: line, lineNumber: null });
      continue;
    }
    // Text after a file's hunks (the next `git log -p` commit) starts a new section.
    if (currentHasHunk) startFile();
    meta(line);
  }
  if (oldRemaining > 0 || newRemaining > 0) incompleteHunk = true;
  if (current.rows.length > 0) files.push(current);
  if (hunkCount === 0) return null;
  return {
    kind: "diff",
    files: files.map((file) => ({
      displayPath: file.displayPath,
      language: file.displayPath ? languageForPath(file.displayPath) : "text",
      rows: file.rows,
    })),
    additions,
    deletions,
    showLineNumbers: !input.shortened,
    partial: input.shortened === true || incompleteHunk,
  };
}

// ---------------------------------------------------------------------------
// JSON

const MAX_JSON_CHARS = 1024 * 1024;

function classifyJson(output: string): CommandOutputPresentation | null {
  const trimmed = output.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_JSON_CHARS) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  return { kind: "json", text: output };
}

// ---------------------------------------------------------------------------

export function classifyCommandOutput(
  input: ClassifyCommandOutputInput,
): CommandOutputPresentation {
  const { output } = input;
  if (countLinesUpTo(output, MAX_PRESENTED_LINES) > MAX_PRESENTED_LINES) {
    return { kind: "plain", text: stripAnsi(output) };
  }
  if (hasAnsiEscapes(output)) {
    const parsed = parseAnsiOutput(output);
    return { kind: "ansi", text: parsed.text, lines: parsed.lines };
  }
  if (output.trim().length === 0) return { kind: "plain", text: output };
  if (input.status === "failed") {
    // `diff` and `git diff --exit-code` exit 1 when the inputs differ.
    const differed = input.exitCode === 1 && isDiffCommand(input.command);
    return (differed ? classifyDiff(input) : null) ?? { kind: "plain", text: output };
  }
  return (
    classifyDiff(input) ??
    classifyFileRead(input) ??
    classifySearch(input) ??
    classifyJson(output) ?? { kind: "plain", text: output }
  );
}
