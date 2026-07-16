export const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
export const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;

export interface ParsedLocalFileUrl {
  readonly path: string;
  readonly hash: string;
}

export function safeDecodeLocalPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}

export function parseLocalFileUrl(href: string): ParsedLocalFileUrl | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname && hostname !== "localhost") return null;

    const decodedPath = safeDecodeLocalPath(parsed.pathname);
    if (!decodedPath) return null;
    return {
      path: /^\/[A-Za-z]:[\\/]/.test(decodedPath) ? decodedPath.slice(1) : decodedPath,
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function appendLocalFileUrlPosition(path: string, hash: string): string {
  if (!hash || /:\d+(?::\d+)?$/.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  return `${path}:${match[1]}${match[2] ? `:${match[2]}` : ""}`;
}

export function looksLikeQuotedLocalPath(value: string): boolean {
  const path = value.replace(/:\d+(?::\d+)?$/, "");
  if (isWindowsAbsolutePath(path) || path.startsWith("/")) return true;
  if (/^(?:~\/|\.{1,2}[\\/])/.test(path)) return true;
  return /[\\/]/.test(path) && /\.[A-Za-z0-9_-]+$/.test(path);
}
