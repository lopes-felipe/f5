import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g;
const FILE_PATH_PATTERN =
  /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:\\|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;

function trimClosingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, "");
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function isFileUriPathMatch(line: string, start: number): boolean {
  return line[start] === "/" && line.slice(Math.max(0, start - 5), start).toLowerCase() === "file:";
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0];
    const start = rawMatch.index ?? -1;
    if (start < 0 || raw.length === 0) continue;

    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    if (kind === "path" && /^https?:\/\//i.test(trimmed)) continue;
    if (kind === "path" && /^file:/i.test(trimmed)) continue;
    if (kind === "path" && isFileUriPathMatch(line, start)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      end: start + trimmed.length,
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, urlMatches);
  return [...urlMatches, ...pathMatches].toSorted((a, b) => a.start - b.start);
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  if (!line) return resolvedPath;
  return `${resolvedPath}:${line}${column ? `:${column}` : ""}`;
}

// ---------------------------------------------------------------------------
// Wrapped-line link support
//
// xterm stores a line that is visually wider than the terminal as multiple
// physical buffer lines, where every continuation line has `isWrapped === true`.
// The built-in link provider only inspects a single row at a time, so URLs that
// wrap across rows become unclickable beyond the first row. The helpers below
// join a logical wrapped line and map logical offsets back to physical
// (row, col) coordinates so the link registration can highlight all rows that
// the link touches.
// ---------------------------------------------------------------------------

export interface WrappedTerminalBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalBufferLike {
  getLine(y: number): WrappedTerminalBufferLine | null | undefined;
}

export interface WrappedLogicalLine {
  readonly text: string;
  /** 0-based index of the first physical row that makes up this logical line. */
  readonly startY: number;
  /** 0-based index of the last physical row that makes up this logical line. */
  readonly endY: number;
}

/**
 * Assemble the logical wrapped line that contains `bufferLineNumber`.
 *
 * Walks backwards while each line reports `isWrapped` (i.e. is a continuation
 * of the previous line) then forwards while the next line is a continuation.
 * Every row is stringified without trimming so that column positions in the
 * joined text line up exactly with `cols`-wide physical rows.
 */
export function assembleWrappedLogicalLine(
  buffer: WrappedTerminalBufferLike,
  bufferLineNumber: number,
): WrappedLogicalLine {
  if (bufferLineNumber < 0) {
    return { text: "", startY: bufferLineNumber, endY: bufferLineNumber };
  }

  let startY = bufferLineNumber;
  while (startY > 0) {
    const current = buffer.getLine(startY);
    if (!current || !current.isWrapped) break;
    startY -= 1;
  }

  let text = "";
  let y = startY;
  while (true) {
    const line = buffer.getLine(y);
    if (!line) break;
    if (y > startY && !line.isWrapped) break;
    text += line.translateToString(false);
    y += 1;
  }

  return { text, startY, endY: Math.max(startY, y - 1) };
}

export interface PhysicalLinkRange {
  /** 0-based start row (inclusive). */
  startY: number;
  /** 0-based start column (inclusive). */
  startX: number;
  /** 0-based end row (inclusive). */
  endY: number;
  /** 0-based end column (exclusive). */
  endX: number;
}

/**
 * Map a half-open logical offset range `[start, end)` from the joined wrapped
 * line back to a physical `(row, col)` range. Callers that need xterm-native
 * 1-based coordinates can do `+1` on the result.
 */
export function mapLogicalRangeToPhysical(
  startY: number,
  start: number,
  end: number,
  cols: number,
): PhysicalLinkRange {
  if (cols <= 0) {
    return { startY, startX: 0, endY: startY, endX: 0 };
  }
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart, end);
  const lastInclusive = Math.max(safeStart, safeEnd - 1);

  const sY = startY + Math.floor(safeStart / cols);
  const sX = safeStart % cols;
  const eY = startY + Math.floor(lastInclusive / cols);
  const eXInclusive = lastInclusive % cols;
  return {
    startY: sY,
    startX: sX,
    endY: eY,
    endX: eXInclusive + 1,
  };
}

export interface WrappedTerminalLinkMatch extends TerminalLinkMatch {
  /** Physical range of the link across one or more rows. */
  physical: PhysicalLinkRange;
}

/**
 * Extract links from the wrapped logical line that contains `bufferLineNumber`,
 * returning only matches whose physical range touches that row. Passing each
 * row through this helper produces distinct link entries per row but with
 * consistent full-range coordinates, so xterm's hit-testing stays correct
 * regardless of which row the pointer hovers.
 */
export function extractWrappedTerminalLinks(
  buffer: WrappedTerminalBufferLike,
  bufferLineNumber: number,
  cols: number,
): WrappedTerminalLinkMatch[] {
  if (cols <= 0) return [];
  const logical = assembleWrappedLogicalLine(buffer, bufferLineNumber);
  if (logical.text.length === 0) return [];

  const matches = extractTerminalLinks(logical.text);
  const results: WrappedTerminalLinkMatch[] = [];
  for (const match of matches) {
    const physical = mapLogicalRangeToPhysical(logical.startY, match.start, match.end, cols);
    if (physical.startY <= bufferLineNumber && physical.endY >= bufferLineNumber) {
      results.push({ ...match, physical });
    }
  }
  return results;
}
