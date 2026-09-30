import type { IncomingMessage, ServerResponse } from "node:http";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/** Opens the authorized inode; callers stream this handle instead of reopening its path. */
export async function openContainedFile(root: string, relativePath: string): Promise<FileHandle> {
  const rootPath = await realpath(root);
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid asset path");
  }
  const segments = relativePath.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid asset path");
  }
  const verify = async () => {
    let current = rootPath;
    for (const segment of segments) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Symbolic links are not allowed");
    }
    if ((await realpath(root)) !== rootPath || (await realpath(current)) !== current) {
      throw new Error("Asset path changed");
    }
    return current;
  };
  const target = await verify();
  const before = await lstat(target);
  if (!before.isFile()) throw new Error("Asset is not a file");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    await verify();
    const after = await lstat(target);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.dev !== after.dev ||
      stat.ino !== after.ino
    )
      throw new Error("Asset changed while opening");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

const MIME: Readonly<Record<string, string>> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
export const assetMimeType = (name: string): string =>
  MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/**
 * Explicit "Open in preview browser" pages may run their own scripts, but every
 * subresource, fetch, worker, frame and form stays on the preview origin, so a
 * page cannot post files it reads to another host. Top-level navigation is not
 * governed by CSP; the user guide documents that residual channel.
 */
export const ACTIVE_PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

export function assetHeaders(name: string, htmlPrefix?: string): Record<string, string> {
  const mime = assetMimeType(name);
  const inline =
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("font/") ||
    mime === "application/pdf" ||
    mime === "text/css" ||
    (mime === "text/html" && htmlPrefix);
  const passiveSource =
    htmlPrefix &&
    /^https?:\/\/[a-zA-Z0-9.:[\]-]+\/api\/workspace-assets\/[A-Za-z0-9_-]+\/$/u.test(htmlPrefix)
      ? htmlPrefix
      : "'none'";
  return {
    "Content-Type":
      mime.startsWith("text/") || mime === "application/json" ? `${mime}; charset=utf-8` : mime,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(name)).replaceAll("'", "%27")}`,
    "Content-Security-Policy":
      mime === "text/html"
        ? `sandbox; default-src 'none'; style-src ${passiveSource}; img-src ${passiveSource}; font-src ${passiveSource}; script-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'`
        : mime === "image/svg+xml"
          ? "default-src 'none'; style-src 'unsafe-inline'; sandbox"
          : mime === "application/pdf"
            ? "default-src 'none'"
            : "default-src 'none'; sandbox",
  };
}

export function parseAssetRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | null | false {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end ||
    (!match[1] && Number(match[2]) === 0)
  )
    return false;
  return { start, end };
}

/** Stored attachments never change once written, so their bytes may be cached privately. */
export const IMMUTABLE_PRIVATE_CACHE_CONTROL = "private, max-age=31536000, immutable";

export interface ServeAssetOptions {
  /** Handle prefix whose passive siblings an HTML document may load. */
  readonly htmlPrefix?: string | undefined;
  /** Explicit active preview: scripts run under ACTIVE_PREVIEW_CSP. */
  readonly activePreview?: boolean;
  /** Defaults to `private, no-store` for content that can change on disk. */
  readonly cacheControl?: string;
}

/** Takes ownership of file, including on disconnect, HEAD, and invalid Range. */
export async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  file: FileHandle,
  name: string,
  options: ServeAssetOptions = {},
): Promise<void> {
  try {
    const { size } = await file.stat();
    const headers: Record<string, string> = {
      ...assetHeaders(name, options.htmlPrefix),
      "Accept-Ranges": "bytes",
      ...(options.cacheControl ? { "Cache-Control": options.cacheControl } : {}),
    };
    if (options.activePreview) {
      headers["Content-Security-Policy"] = ACTIVE_PREVIEW_CSP;
      headers["Content-Disposition"] = "inline";
    }
    const range = parseAssetRange(req.headers.range, size);
    if (range === false) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" });
      res.end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      ...headers,
      "Content-Length": String(range ? range.end - range.start + 1 : size),
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    await pipeline(
      file.createReadStream({
        autoClose: false,
        start: range?.start ?? 0,
        end: range?.end ?? size - 1,
      }),
      res,
    );
  } finally {
    await file.close();
  }
}
