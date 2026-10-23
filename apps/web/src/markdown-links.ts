import { defaultUrlTransform } from "react-markdown";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { resolvePathLinkTarget, splitPathAndPosition } from "./terminal-links";
import { basenameOfPath } from "./vscode-icons";
import {
  appendLocalFileUrlPosition,
  isWindowsAbsolutePath,
  parseLocalFileUrl,
  safeDecodeLocalPath,
  WINDOWS_DRIVE_PATH_PATTERN,
  WINDOWS_UNC_PATH_PATTERN,
} from "./local-paths";

const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function isLikelyPathCandidate(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (/^[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\/$/.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = href.trim();
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseLocalFileUrl(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = fileUrlTarget ? source.path.trim() : safeDecodeLocalPath(source.path.trim());
  const decodedHash = safeDecodeLocalPath(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLocalFileUrlPosition(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

export interface MarkdownFileLinkMeta {
  /** The resolved file path, without any line/column suffix. */
  readonly filePath: string;
  /** The full navigation target (file path plus optional `:line[:column]`). */
  readonly targetPath: string;
  /** Workspace-relative path suitable for tooltip display. */
  readonly displayPath: string;
  /** Filename portion of `filePath` — the chip's primary label. */
  readonly basename: string;
  readonly line?: string;
  readonly column?: string;
}

/**
 * Compose the rich metadata used to render a markdown file-link chip:
 *
 *  1. `resolveMarkdownFileLinkTarget()` validates the href and resolves
 *     relative paths against `cwd`, returning `path[:line[:column]]`.
 *  2. `splitPathAndPosition()` peels the line/column suffix back off so we
 *     can expose the bare `filePath` separately from `targetPath`.
 *  3. `formatWorkspaceRelativePath()` projects the file path into a
 *     workspace-labeled form for the chip tooltip.
 *
 * Returns `null` for hrefs that are not file links (external URLs, app
 * routes, anchors, etc.).
 */
export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;

  const { path, line, column } = splitPathAndPosition(targetPath);
  const displayPath = formatWorkspaceRelativePath(path, cwd);
  const basename = basenameOfPath(path);
  return {
    filePath: path,
    targetPath,
    displayPath,
    basename,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/**
 * Whether a file link's text only names its destination (`example.ts`, `src/example.ts:12`),
 * so the chip can replace it. Any other text is prose the reader still needs.
 */
export function isMarkdownFileLinkLabel(label: string, meta: MarkdownFileLinkMeta): boolean {
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const labelPosition = splitPathAndPosition(label.trim());
  if (
    (labelPosition.line !== undefined && labelPosition.line !== meta.line) ||
    (labelPosition.column !== undefined && labelPosition.column !== meta.column)
  ) {
    return false;
  }
  let labelPath = normalize(labelPosition.path);
  let destinationPath = normalize(meta.filePath);
  if (labelPath.length === 0) return true;
  if (isWindowsAbsolutePath(meta.filePath)) {
    labelPath = labelPath.toLowerCase();
    destinationPath = destinationPath.toLowerCase();
  }
  return destinationPath === labelPath || destinationPath.endsWith(`/${labelPath}`);
}

/**
 * Normalize a `file://` URI to a plain filesystem path. Non-file hrefs are
 * returned unchanged. Useful for the chip's `href` attribute so hover / copy
 * reveals a path the user recognizes instead of the raw URI.
 */
/** For each index, the index of the next `char` at or after it, or `text.length`. */
function nextIndexTable(text: string, char: string): Int32Array {
  const table = new Int32Array(text.length + 1);
  let next = text.length;
  table[text.length] = next;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === char) next = index;
    table[index] = next;
  }
  return table;
}

const WHITESPACE = /\s/;
const LINE_TERMINATOR = new RegExp(`[\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`);

/**
 * Hrefs of inline markdown links, `[text](href)` and `[text](href "title")`,
 * with the results of
 * `/\[(?:\\.|[^\]\\])*\]\(\s*(<[^>]+>|[^()\s]+)[^)]*\)/g` (angle brackets
 * stripped from `<href>`). That regex rescans to the end of the text from
 * every unterminated `[`, so a long streaming message took seconds; this
 * scan visits each character a bounded number of times.
 */
export function collectMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  if (!text.includes("](")) return hrefs;
  const nextClose = nextIndexTable(text, ")");
  const nextAngle = nextIndexTable(text, ">");
  const end = text.length;
  // Every `[` after a failed or completed candidate reads the same label, so
  // tracking whether one is open is enough; the leftmost one would match.
  let inLabel = false;
  let index = 0;
  while (index < end) {
    const char = text[index];
    if (!inLabel) {
      if (char === "[") inLabel = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      // `\\.` needs a following character that is not a line terminator.
      if (index + 1 < end && !LINE_TERMINATOR.test(text[index + 1]!)) index += 2;
      else {
        inLabel = false;
        index += 1;
      }
      continue;
    }
    if (char !== "]") {
      index += 1;
      continue;
    }
    inLabel = false;
    if (text[index + 1] !== "(") {
      index += 1;
      continue;
    }
    let start = index + 2;
    while (start < end && WHITESPACE.test(text[start]!)) start += 1;
    let raw: string | null = null;
    let matchEnd = -1;
    if (text[start] === "<") {
      const angle = nextAngle[start + 1]!;
      const close = angle < end ? nextClose[angle + 1]! : end;
      if (angle > start + 1 && close < end) {
        raw = text.slice(start, angle + 1);
        matchEnd = close + 1;
      }
    }
    if (raw === null) {
      let runEnd = start;
      while (
        runEnd < end &&
        text[runEnd] !== "(" &&
        text[runEnd] !== ")" &&
        !WHITESPACE.test(text[runEnd]!)
      )
        runEnd += 1;
      const close = nextClose[runEnd]!;
      if (runEnd > start && close < end) {
        raw = text.slice(start, runEnd);
        matchEnd = close + 1;
      }
    }
    if (raw === null) {
      index += 1;
      continue;
    }
    hrefs.push(raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw);
    index = matchEnd;
  }
  return hrefs;
}

export function rewriteMarkdownFileUriHref(href: string): string {
  if (!href) return href;
  if (!href.toLowerCase().startsWith("file:")) return href;
  const parsed = parseLocalFileUrl(href);
  if (!parsed) return href;
  const base = parsed.path;
  const withPosition = appendLocalFileUrlPosition(base, parsed.hash);
  return withPosition;
}

/**
 * react-markdown's default transform empties any href with a scheme it does not know, which
 * includes `C:` and `file:`. Local file links keep their destination so they still become
 * file chips; everything else gets the default sanitizing.
 */
export function chatMarkdownUrlTransform(href: string): string {
  // Destinations arrive percent-encoded, so `C:\me` is `C:%5Cme` here.
  if (isWindowsAbsolutePath(safeDecodeLocalPath(href))) return href;
  if (href.toLowerCase().startsWith("file:") && parseLocalFileUrl(href)) return href;
  return defaultUrlTransform(href);
}
