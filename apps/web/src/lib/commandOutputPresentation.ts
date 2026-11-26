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
  parseOutputStatements,
  parseSearchOutputCommand,
  type SearchOutputCommand,
} from "@t3tools/shared/commandSummary";
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";

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

/** One statement's output within a compound command's output. */
export type OutputSection =
  | {
      readonly type: "file";
      /** The path as written; `rev:path` for `git show rev:path`. */
      readonly displayPath: string;
      /** Null when where it ran is unknown, or for a revision's text. */
      readonly filePath: string | null;
      readonly language: string;
      readonly code: string;
      /** From `nl -ba` / `cat -n` prefixes; null otherwise. */
      readonly lineNumbers: ReadonlyArray<number> | null;
    }
  | {
      readonly type: "search";
      readonly segments: ReadonlyArray<SearchSegment>;
      readonly matchCount: number;
      readonly fileCount: number;
    }
  | { readonly type: "plain"; readonly text: string };

export type CommandOutputPresentation =
  | { readonly kind: "plain"; readonly text: string }
  | {
      readonly kind: "sections";
      readonly sections: ReadonlyArray<OutputSection>;
      readonly matchCount: number;
    }
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
  // Reads of several files that can be told apart get a section each, with
  // their own names and links, rather than one merged block.
  const separable = parsed.segments
    .slice(0, -1)
    .every((segment) => segment.lineLimit !== null || segment.numberedOutput);
  const files = new Set(
    parsed.segments.map((segment) => `${segment.revision}\0${segment.filePath}`),
  );
  if (separable && files.size > 1) {
    const sections = classifySections(input);
    if (sections) return sections;
  }
  const languages = new Set(parsed.segments.map((segment) => languageForPath(segment.filePath)));
  if (languages.size !== 1) return null;
  const [first] = parsed.segments;
  if (!first || input.output.length === 0) return null;
  const language = [...languages][0]!;
  const single = parsed.segments.length === 1;
  const lines = outputLines(input.output);
  // A read that failed, or one written to a file earlier (`git show A:a.ts >
  // /tmp/a.ts; …`) whose error still printed: its lines are not the file's.
  if (TOOL_ERROR_PATTERN.test(lines[0] ?? "")) return null;

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
  // have run in either directory, and `git show rev:path` prints a revision's
  // text, so those are named but cannot be opened.
  const displayPathOf = (segment: (typeof parsed.segments)[number]) =>
    segment.revision === null ? segment.filePath : `${segment.revision}:${segment.filePath}`;
  const filePaths = new Set(
    parsed.segments.map((segment) =>
      resolveCommandPath(segment.filePath, input.cwd, segment.cwdOffset),
    ),
  );
  const displayPaths = new Set(parsed.segments.map(displayPathOf));
  const openable = parsed.segments.every(
    (segment) => segment.cwdKnown && segment.revision === null,
  );
  const file =
    filePaths.size === 1 && displayPaths.size === 1 && openable
      ? {
          displayPath: first.filePath,
          filePath: resolveCommandPath(first.filePath, input.cwd, first.cwdOffset),
        }
      : displayPaths.size === 1
        ? { displayPath: displayPathOf(first), filePath: null }
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
  // Lines read from stdin carry no path.
  if (search.stdin) return true;
  // `-H` names the file on every line.
  if (search.withFileName) return false;
  const [target] = search.targets;
  if (search.targets.length !== 1 || !target) return false;
  // `git grep` always prints the path.
  if (search.tool === "git") return false;
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

/**
 * `git grep pattern origin/main` prints `origin/main:path:12:text`. A prefix
 * is dropped only when the line does not parse as a result without it, since
 * without `--` a "revision" may be a path (`a.ts:12:text`).
 */
function stripRevisionPrefix(
  line: string,
  search: Pick<SearchOutputCommand, "revisions" | "revisionsKnown">,
): { line: string; revision: string | null } {
  const { revisions } = search;
  // Trees named before `--` always prefix the line, even one that would
  // parse without it (`A:src/a.ts:12:x` looks like a Windows path).
  if (revisions.length > 0 && (search.revisionsKnown || !PATH_LINE_PATTERN.test(line))) {
    for (const revision of revisions) {
      if (line.startsWith(`${revision}:`)) {
        return { line: line.slice(revision.length + 1), revision };
      }
    }
  }
  return { line, revision: null };
}

interface SearchResults {
  readonly segments: ReadonlyArray<SearchSegment>;
  readonly matchCount: number;
  readonly fileCount: number;
  /** Index of the first line that is not part of the results. */
  readonly end: number;
}

/**
 * Reads search results from `rawLines`. When `stopAtOtherOutput` is set,
 * output of later statements follows the results: the first line that is not
 * a result, or whose file's line numbers stop increasing, ends them (even one
 * shaped like `12: build complete`). Otherwise such lines stay in place as
 * plain segments.
 */
function readSearchResults(
  rawLines: ReadonlyArray<string>,
  search: SearchOutputCommand,
  cwd: string | null | undefined,
  stopAtOtherOutput: boolean,
): SearchResults {
  // A search over stdin (`git show A:a.ts | grep -n x`, `sed -n 40,80p a.ts |
  // grep -n x`) numbers lines from where its input started.
  const { stdin } = search;
  const singleFile = stdin
    ? stdin.revision === null
      ? stdin.filePath
      : `${stdin.revision}:${stdin.filePath}`
    : searchesSingleFile(search)
      ? search.targets[0]!
      : null;
  const lineOffset = stdin?.lineOffset ?? 0;
  const linkFor = (displayPath: string, fromRevision: boolean): string | null => {
    if (stdin) {
      return stdin.revision === null && stdin.cwdKnown
        ? resolveCommandPath(stdin.filePath, cwd, stdin.cwdOffset)
        : null;
    }
    // A revision's text may differ from the file on disk.
    return displayPath.length > 0 && search.cwdKnown && !fromRevision
      ? resolveCommandPath(displayPath, cwd, search.cwdOffset)
      : null;
  };
  const matcher = buildSearchMatcher(search);
  const segments: SearchSegment[] = [];
  const paths = new Set<string>();
  let matchCount = 0;
  const state: {
    group: { key: string; displayPath: string; fromRevision: boolean; lines: SearchLine[] } | null;
    lastGroupKey: string | null;
    plainLines: string[];
  } = { group: null, lastGroupKey: null, plainLines: [] };

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
      filePath: linkFor(group.displayPath, group.fromRevision),
      language: languageForPath(stdin?.filePath ?? group.displayPath),
      showHeader: group.key !== state.lastGroupKey,
      lines: group.lines,
    });
    state.lastGroupKey = group.key;
    state.group = null;
  };

  const lines = rawLines.map((line) => stripRevisionPrefix(line, search));
  const matchPaths = new Set<string>();
  for (const { line } of lines) {
    const match = PATH_LINE_PATTERN.exec(line);
    if (match?.[3] === ":") matchPaths.add(match[1]!);
  }
  const lastLineByKey = new Map<string, number>();
  let end = lines.length;
  for (const [index, { line, revision }] of lines.entries()) {
    if (line === "--") {
      flushGroup();
      flushPlain();
      segments.push({ type: "separator" });
      continue;
    }
    const parsed = parseSearchLine(line, search, singleFile, matchPaths);
    const path = parsed?.path ?? "";
    const displayPath = revision !== null && path ? `${revision}:${path}` : path;
    const outOfOrder =
      parsed !== null && parsed.lineNumber <= (lastLineByKey.get(displayPath) ?? 0);
    if (!parsed || (stopAtOtherOutput && outOfOrder)) {
      if (stopAtOtherOutput) {
        end = index;
        break;
      }
      flushGroup();
      state.plainLines.push(rawLines[index]!);
      continue;
    }
    lastLineByKey.set(displayPath, parsed.lineNumber);
    flushPlain();
    if (state.group && state.group.key !== displayPath) flushGroup();
    const group = state.group ?? {
      key: displayPath,
      displayPath,
      fromRevision: revision !== null,
      lines: [],
    };
    state.group = group;
    if (parsed.isMatch) matchCount += 1;
    if (displayPath) paths.add(displayPath);
    group.lines.push({
      lineNumber: parsed.lineNumber + lineOffset,
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
  return { segments, matchCount, fileCount: paths.size, end };
}

function classifySearch(input: ClassifyCommandOutputInput): CommandOutputPresentation | null {
  const search = parseSearchOutputCommand(input.command);
  // Without line numbers a leading `2026-11-23` or `12:` in the matched text
  // would be read as one, so unnumbered output stays plain.
  if (!search?.lineNumbers || input.output.length === 0) return null;
  const lines = outputLines(input.output);
  const results = readSearchResults(lines, search, input.cwd, search.followedByOtherStatements);
  if (!results.segments.some((segment) => segment.type === "group")) return null;
  const segments = [...results.segments];
  if (results.end < lines.length) {
    segments.push({ type: "plain", text: lines.slice(results.end).join("\n") });
  }
  return {
    kind: "search",
    segments,
    matchCount: results.matchCount,
    fileCount: results.fileCount,
    partial: input.shortened === true,
  };
}

// ---------------------------------------------------------------------------
// Compound commands

/**
 * A tool's error message where a read's output was expected. Only the forms
 * the read tools print, since a file may well start with `Usage:` or `error:`.
 */
const TOOL_ERROR_PATTERN = /^fatal: |^(?:git|sed|cat|head|tail|nl|grep|ggrep|ugrep|rg): /;

const searchMatchers = new WeakMap<SearchOutputCommand, RegExp | null>();

/** Whether `line` is shaped like a row a search prints: a match, context, or `--`. */
function isSearchRow(line: string, search: SearchOutputCommand): boolean {
  if (line === "--") return true;
  const stripped = stripRevisionPrefix(line, search).line;
  if (searchesSingleFile(search) || search.noFileName) return NUMBER_LINE_PATTERN.test(stripped);
  return PATH_LINE_PATTERN.test(stripped) || /^[^:\n]+-\d+-/.test(stripped);
}

/**
 * Whether `line` can be the first line a search prints. Used to find where
 * the read before it ended. With `-B`/`-C` that is any row; with `-v` a match
 * row of any text. Otherwise it is a match row whose text holds the pattern,
 * so context rows (`path-3-text`), and file lines that merely look like a
 * row (`12:30 standup`), do not qualify. Without a usable matcher (PCRE,
 * risky patterns) the row's shape alone decides.
 */
function isSearchStartLine(line: string, search: SearchOutputCommand): boolean {
  if (line === "--") return false;
  if (search.beforeContext) return isSearchRow(line, search);
  const stripped = stripRevisionPrefix(line, search).line;
  let text: string | null;
  if (searchesSingleFile(search) || search.noFileName) {
    text = /^\d+:(.*)$/.exec(stripped)?.[1] ?? null;
  } else {
    const match = PATH_LINE_PATTERN.exec(stripped);
    text = match?.[3] === ":" ? match[4]! : null;
  }
  if (text === null) return false;
  if (search.invertMatch) return true;
  if (!searchMatchers.has(search)) searchMatchers.set(search, buildSearchMatcher(search));
  const matcher = searchMatchers.get(search) ?? null;
  return matcher === null || findMatchRanges(text, matcher).length > 0;
}

/**
 * Where a read that starts at `start` ends when a search follows it: at the
 * search's first line within `[start, limit)`. When the search is the last
 * statement, everything from there on must be its rows (or its trailing
 * errors), so a file line that looks like a match (`12:foo`) is not taken
 * for one. `found` is false when no such line exists; `printedNothing` then
 * tells whether the search printed nothing at all, in which case the read
 * took all the output up to `rowsEnd`.
 */
function findSearchStart(
  lines: ReadonlyArray<string>,
  start: number,
  limit: number,
  search: SearchOutputCommand,
  searchIsLast: boolean,
): { found: boolean; index: number; printedNothing: boolean; rowsEnd: number } {
  let rowsEnd = lines.length;
  let rowsFrom = start;
  if (searchIsLast) {
    while (rowsEnd > start && TOOL_ERROR_PATTERN.test(lines[rowsEnd - 1]!)) rowsEnd -= 1;
    rowsFrom = rowsEnd;
    while (rowsFrom > start && isSearchRow(lines[rowsFrom - 1]!, search)) rowsFrom -= 1;
  }
  for (let index = Math.max(start, rowsFrom); index < Math.min(limit, rowsEnd); index += 1) {
    if (isSearchStartLine(lines[index]!, search)) {
      return { found: true, index, printedNothing: false, rowsEnd };
    }
  }
  return {
    found: false,
    index: limit,
    printedNothing: searchIsLast && rowsFrom === rowsEnd,
    rowsEnd,
  };
}

/** `nl -ba` / `cat -n` lines up to where the numbers stop following on. */
function readNumberedLines(
  lines: ReadonlyArray<string>,
): { texts: string[]; numbers: number[] } | null {
  const numbers: number[] = [];
  const texts: string[] = [];
  let unnumberedTail = 0;
  for (const line of lines) {
    const previous = numbers[numbers.length - 1];
    // A blank line without a number continues the count, as in a whole read.
    if (line.trim().length === 0) {
      numbers.push(previous !== undefined ? previous + 1 : 1);
      texts.push(line);
      unnumberedTail += 1;
      continue;
    }
    const match = NUMBERED_LINE_PATTERN.exec(line);
    const number = match ? Number.parseInt(match[1]!, 10) : null;
    if (number === null || (previous !== undefined && number !== previous + 1)) break;
    numbers.push(number);
    texts.push(match![2]!);
    unnumberedTail = 0;
  }
  // Unnumbered blank lines at the end are more likely the next statement's.
  texts.splice(texts.length - unnumberedTail);
  numbers.splice(numbers.length - unnumberedTail);
  return texts.length > 0 ? { texts, numbers } : null;
}

/**
 * `git show A:a.ts | sed -n 10,20p; git grep -n foo; ps …`: the output of each
 * statement in turn. A search takes lines while they are results. A read
 * takes up to as many lines as it can print, but a file shorter than its
 * range prints fewer, so it also ends where the next search's first match
 * appears, or where `nl -ba` numbers stop following on. When neither confirms
 * where a read ended, its section is named but not linked, since it may hold
 * the next statement's output. The first statement whose output cannot be
 * bounded at all (an unbounded read before others, anything else) makes the
 * rest plain. Reads without number prefixes get no gutter: a short read would
 * shift every later number.
 */
function classifySections(input: ClassifyCommandOutputInput): CommandOutputPresentation | null {
  // Lines missing from the middle would shift every boundary.
  if (input.shortened) return null;
  const statements = parseOutputStatements(input.command);
  if (!statements || statements.length < 2 || statements[0]!.kind === "other") return null;
  const lines = outputLines(input.output);
  const sections: OutputSection[] = [];
  const pushPlain = (text: string) => {
    const previous = sections[sections.length - 1];
    if (previous?.type === "plain") {
      sections[sections.length - 1] = { type: "plain", text: `${previous.text}\n${text}` };
    } else {
      sections.push({ type: "plain", text });
    }
  };
  // Statement index of each search section, by section index.
  const structuredFrom = new Map<number, number>();
  let position = 0;
  for (const [index, statement] of statements.entries()) {
    if (position >= lines.length || statement.kind === "other") break;
    const last = index === statements.length - 1;
    if (statement.kind === "lines") {
      // `echo "== label"`, `wc -l a.ts`: as many lines as they always print.
      const end = Math.min(lines.length, position + statement.count);
      pushPlain(lines.slice(position, end).join("\n"));
      position = end;
      continue;
    }
    if (statement.kind === "search") {
      const { search } = statement;
      if (!search.lineNumbers) break;
      const results = readSearchResults(lines.slice(position), search, input.cwd, !last);
      if (!results.segments.some((segment) => segment.type === "group")) {
        // A search that found nothing printed nothing; the next statement's
        // output starts here. An error line could be either, so stop. A
        // statement after `&&` did not run at all, so whose output follows
        // is unknown.
        const next = statements[index + 1];
        const empty = results.end === 0 && !TOOL_ERROR_PATTERN.test(lines[position]!);
        if (empty && next && !next.afterAnd) continue;
        break;
      }
      structuredFrom.set(sections.length, index);
      sections.push({
        type: "search",
        segments: results.segments,
        matchCount: results.matchCount,
        fileCount: results.fileCount,
      });
      position += results.end;
      continue;
    }
    const { read } = statement;
    const next = statements[index + 1];
    const nextSearch = next?.kind === "search" && next.search.lineNumbers ? next.search : null;
    const searchIsLast = index + 1 === statements.length - 1;
    // Numbered output shows where it ends, and a search that is the last
    // statement ends it where its rows start; other unbounded reads cannot
    // be bounded.
    const unbounded = read.lineLimit === null && !last && !read.numberedOutput;
    if (unbounded && !(nextSearch && searchIsLast)) break;
    if (TOOL_ERROR_PATTERN.test(lines[position]!)) break;
    let end =
      last || read.lineLimit === null
        ? lines.length
        : Math.min(lines.length, position + read.lineLimit);
    let confirmed = last;
    if (nextSearch) {
      const start = findSearchStart(lines, position, end, nextSearch, searchIsLast);
      if (start.found) {
        end = start.index;
        confirmed = true;
      } else if (unbounded) {
        // The read took everything only if the search printed nothing; its
        // errors (`grep: x: No such file or directory`) stay after it.
        if (!start.printedNothing) break;
        end = start.rowsEnd;
        confirmed = true;
      } else {
        confirmed =
          end < lines.length &&
          end < start.rowsEnd &&
          isSearchStartLine(lines[end]!, nextSearch) &&
          (!searchIsLast ||
            lines.slice(end, start.rowsEnd).every((line) => isSearchRow(line, nextSearch)));
      }
    }
    let code = lines.slice(position, end);
    let lineNumbers: number[] | null = null;
    if (read.numberedOutput && code.length > 0) {
      const numbered = readNumberedLines(code);
      if (!numbered) break;
      code = numbered.texts;
      lineNumbers = numbered.numbers;
      confirmed = true;
    }
    // An empty file, a range past its end, `head -n 0`.
    if (code.length === 0) continue;
    sections.push({
      type: "file",
      displayPath: read.revision === null ? read.filePath : `${read.revision}:${read.filePath}`,
      filePath:
        confirmed && read.revision === null && read.cwdKnown
          ? resolveCommandPath(read.filePath, input.cwd, read.cwdOffset)
          : null,
      language: languageForPath(read.filePath),
      code: code.join("\n"),
      lineNumbers,
    });
    position += code.length;
  }
  if (position < lines.length) pushPlain(lines.slice(position).join("\n"));
  // A search that comes first and alone, then other output, is a search
  // presentation (after an empty read or search it is not, so it stays a
  // section), when that presentation can take the command: it cannot after
  // a statement the splitter could not follow.
  const structured = sections.filter((section) => section.type !== "plain");
  const leadingSearchOnly =
    structured.length === 1 &&
    structured[0]!.type === "search" &&
    structuredFrom.get(sections.indexOf(structured[0]!)) === 0 &&
    parseSearchOutputCommand(input.command) !== null;
  if (structured.length === 0 || leadingSearchOnly) return null;
  return {
    kind: "sections",
    sections,
    matchCount: sections.reduce(
      (count, section) => count + (section.type === "search" ? section.matchCount : 0),
      0,
    ),
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
  // `git show HEAD:a.patch` prints a file that happens to hold a diff; keep its
  // name and line numbers rather than reading the hunks.
  const blobRead =
    parseFileReadSegments(input.command)?.segments.every((segment) => segment.revision !== null) ??
    false;
  return (
    (blobRead ? classifyFileRead(input) : null) ??
    classifyDiff(input) ??
    classifyFileRead(input) ??
    classifySections(input) ??
    classifySearch(input) ??
    classifyJson(output) ?? { kind: "plain", text: output }
  );
}
