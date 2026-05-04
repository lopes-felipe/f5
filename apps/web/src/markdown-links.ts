import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { resolvePathLinkTarget, splitPathAndPosition } from "./terminal-links";
import { basenameOfPath } from "./vscode-icons";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function parseFileUrlHref(href: string): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const decodedPath = safeDecode(parsed.pathname);
    if (decodedPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = /^\/[A-Za-z]:[\\/]/.test(decodedPath)
      ? decodedPath.slice(1)
      : decodedPath;

    return { path: normalizedPath, hash: parsed.hash };
  } catch {
    return null;
  }
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
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
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim());
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
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
 * Normalize a `file://` URI to a plain filesystem path. Non-file hrefs are
 * returned unchanged. Useful for the chip's `href` attribute so hover / copy
 * reveals a path the user recognizes instead of the raw URI.
 */
export function rewriteMarkdownFileUriHref(href: string): string {
  if (!href) return href;
  if (!href.toLowerCase().startsWith("file:")) return href;
  const parsed = parseFileUrlHref(href);
  if (!parsed) return href;
  const base = parsed.path;
  const withPosition = appendLineColumnFromHash(base, parsed.hash);
  return withPosition;
}
