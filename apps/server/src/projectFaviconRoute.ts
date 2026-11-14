import http from "node:http";
import { serveAsset } from "./assetHttp";
import { externalRequestOrigin } from "./serverAuth";

import { ProjectId } from "@t3tools/contracts";

import {
  type WorkspaceAssetAuthorizer,
  type WorkspaceAssetReader,
  WorkspaceAssetAuthorizationError,
  WORKSPACE_FAVICON_MAX_BYTES,
  WORKSPACE_ICNS_FAVICON_MAX_BYTES,
} from "./WorkspaceAssetAuthorizer";
import type { CheckedInProjectFileService } from "./project/CheckedInProjectFileService";

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "Resources/AppIcon.icns",
  "AppIcon.icns",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

const ICON_SOURCE_FILE_MAX_BYTES = 256 * 1024;
const WORKSPACE_ASSET_ROUTE_PREFIX = "/api/workspace-assets/";

const MAX_ICON_DECLARATION_CHARS = 4_096;
const MAX_ICON_DECLARATION_CANDIDATES = 128;
const HTML_REL_RE = /\brel\s*=\s*["']([^"']*)["']/i;
const HTML_HREF_RE = /\bhref\s*=\s*["']([^"'?]+)["']/i;
const OBJECT_REL_RE = /\brel\s*:\s*["']([^"']*)["']/i;
const OBJECT_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)["']/i;

function isIconRel(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "icon" || normalized === "shortcut icon";
}

function extractIconHref(source: string): string | null {
  const lowerSource = source.toLowerCase();
  let cursor = 0;
  for (let count = 0; count < MAX_ICON_DECLARATION_CANDIDATES; count += 1) {
    const start = lowerSource.indexOf("<link", cursor);
    if (start < 0) break;
    const end = lowerSource.indexOf(">", start + 5);
    cursor = start + 5;
    if (end < 0 || end - start > MAX_ICON_DECLARATION_CHARS) continue;
    const declaration = source.slice(start, end + 1);
    if (!isIconRel(declaration.match(HTML_REL_RE)?.[1])) continue;
    const href = declaration.match(HTML_HREF_RE)?.[1];
    if (href) return href;
  }

  cursor = 0;
  for (let count = 0; count < MAX_ICON_DECLARATION_CANDIDATES; count += 1) {
    const hrefOffset = lowerSource.indexOf("href", cursor);
    if (hrefOffset < 0) break;
    cursor = hrefOffset + 4;
    const start = lowerSource.lastIndexOf("{", hrefOffset);
    const end = lowerSource.indexOf("}", hrefOffset + 4);
    if (
      start < 0 ||
      end < 0 ||
      hrefOffset - start > MAX_ICON_DECLARATION_CHARS ||
      end - start > MAX_ICON_DECLARATION_CHARS
    ) {
      continue;
    }
    const declaration = source.slice(start, end + 1);
    if (!isIconRel(declaration.match(OBJECT_REL_RE)?.[1])) continue;
    const href = declaration.match(OBJECT_HREF_RE)?.[1];
    if (href) return href;
  }
  return null;
}

function resolveIconHref(href: string): string[] {
  const normalizedHref = href.trim();
  if (
    normalizedHref.length === 0 ||
    normalizedHref.includes("\0") ||
    /^[a-z][a-z\d+.-]*:/iu.test(normalizedHref) ||
    normalizedHref.startsWith("//")
  ) {
    return [];
  }
  const clean = normalizedHref.replace(/^\/+/, "");
  return [`public/${clean}`, clean];
}

function faviconMaxBytes(relativePath: string): number {
  return relativePath.toLowerCase().endsWith(".icns")
    ? WORKSPACE_ICNS_FAVICON_MAX_BYTES
    : WORKSPACE_FAVICON_MAX_BYTES;
}

function sendFallbackFavicon(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Cache-Control": "private, max-age=3600",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Type": "image/svg+xml",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(FALLBACK_FAVICON_SVG);
}

function sendAssetError(res: http.ServerResponse, error: unknown): void {
  const statusCode =
    error instanceof WorkspaceAssetAuthorizationError &&
    (error.failure === "expired_handle" ||
      error.failure === "not_found" ||
      error.failure === "identity_not_found")
      ? 404
      : 400;
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(statusCode === 404 ? "Not Found" : "Invalid workspace asset");
}

// Share the read budget across projects: a sidebar can request many favicons at once.
const MAX_CONCURRENT_FAVICON_PROBES = 32;
let activeFaviconProbes = 0;
const waitingFaviconProbes: Array<() => void> = [];

async function withFaviconProbe<A>(probe: () => Promise<A>): Promise<A> {
  if (activeFaviconProbes < MAX_CONCURRENT_FAVICON_PROBES) {
    activeFaviconProbes++;
  } else {
    await new Promise<void>((resolve) => waitingFaviconProbes.push(resolve));
  }
  try {
    return await probe();
  } finally {
    const next = waitingFaviconProbes.shift();
    if (next) next();
    else activeFaviconProbes--;
  }
}

// Probe concurrently within the shared budget, preserve rank, and return without
// waiting on lower-ranked filesystem operations. Each probe handles its rejection.
async function firstFaviconInOrder<A>(
  items: readonly A[],
  probe: (item: A) => Promise<string | null>,
): Promise<string | null> {
  let foundMatch = false;
  const probes = items.map((item) =>
    withFaviconProbe(() => (foundMatch ? Promise.resolve(null) : probe(item))),
  );
  for (const pending of probes) {
    const found = await pending;
    if (found) {
      foundMatch = true;
      return found;
    }
  }
  return null;
}

export async function findFaviconRelativePath(
  authorizer: WorkspaceAssetAuthorizer,
  projectId: string,
): Promise<string | null> {
  const reader = await authorizer.forProject(projectId);
  let cache = faviconCaches.get(authorizer);
  if (!cache) {
    cache = new Map();
    faviconCaches.set(authorizer, cache);
  }
  const key = JSON.stringify([projectId, reader.rootRealPath]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const relativePath = await cached.result;
    if (relativePath === null) {
      if (cache.get(key) === cached) {
        cache.delete(key);
        cache.set(key, cached);
      }
      return null;
    }
    try {
      // Reauthorize and validate the image, so removal, root changes, and
      // symlink replacements never serve a stale or unauthorized icon.
      await withFaviconProbe(() =>
        reader.readImage({ relativePath, maxBytes: faviconMaxBytes(relativePath) }),
      );
      if (cache.get(key) === cached) {
        cache.delete(key);
        cache.set(key, cached);
      }
      return relativePath;
    } catch {
      if (cache.get(key) === cached) cache.delete(key);
    }
  }
  const entry: FaviconCacheEntry = {
    // Let later requests retry a stalled filesystem lookup without letting its
    // eventual completion replace a newer cache entry.
    expiresAt: Date.now() + 30_000,
    result: findFaviconWithReader(reader),
  };
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  try {
    const result = await entry.result;
    entry.expiresAt = Date.now() + (result === null ? 60_000 : 600_000);
    return result;
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

interface FaviconCacheEntry {
  readonly result: Promise<string | null>;
  expiresAt: number;
}

// Scope cached discovery to the server's authorizer, never cache asset handles
// or bytes. Pending lookups share the same bounded cache as settled results.
const faviconCaches = new WeakMap<WorkspaceAssetAuthorizer, Map<string, FaviconCacheEntry>>();

async function findFaviconWithReader(reader: WorkspaceAssetReader): Promise<string | null> {
  const known = await firstFaviconInOrder(FAVICON_CANDIDATES, async (relativePath) => {
    try {
      await reader.readImage({ relativePath, maxBytes: faviconMaxBytes(relativePath) });
      return relativePath;
    } catch {
      // Missing, oversized, escaped, and spoofed candidates all fall through.
      return null;
    }
  });
  if (known) return known;

  return firstFaviconInOrder(ICON_SOURCE_FILES, async (sourcePath) => {
    let source: string;
    try {
      source = await reader.readText({
        relativePath: sourcePath,
        maxBytes: ICON_SOURCE_FILE_MAX_BYTES,
      });
    } catch {
      return null;
    }
    const href = extractIconHref(source);
    if (!href) return null;
    for (const relativePath of resolveIconHref(href)) {
      try {
        await reader.readImage({ relativePath, maxBytes: faviconMaxBytes(relativePath) });
        return relativePath;
      } catch {
        // Continue looking for an authorized favicon candidate.
      }
    }
    return null;
  });
}

export async function tryHandleProjectFaviconRequest(
  url: URL,
  res: http.ServerResponse,
  authorizer: WorkspaceAssetAuthorizer,
  checkedInProjectFileService: CheckedInProjectFileService,
  req?: http.IncomingMessage,
  requestOrigin: (request: http.IncomingMessage) => string | null = externalRequestOrigin,
): Promise<boolean> {
  if (url.pathname.startsWith(WORKSPACE_ASSET_ROUTE_PREFIX)) {
    if (req && req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return true;
    }
    const [handle, ...subpath] = url.pathname.slice(WORKSPACE_ASSET_ROUTE_PREFIX.length).split("/");
    if (!handle || !/^[a-zA-Z0-9_-]+$/u.test(handle)) {
      sendAssetError(res, new Error("Invalid handle"));
      return true;
    }
    try {
      if (req) {
        const opened = await authorizer
          .openHandle(handle, subpath.length ? decodeURIComponent(subpath.join("/")) : undefined)
          .catch((error: unknown) => {
            if (
              error instanceof WorkspaceAssetAuthorizationError &&
              error.failure === "expired_handle" &&
              subpath.length === 0
            )
              return null;
            throw error;
          });
        if (opened) {
          // CSP must name the origin the browser actually used; `url` carries a
          // synthetic localhost base. An unusable Host leaves passive loads at 'none'.
          const origin = requestOrigin(req);
          await serveAsset(req, res, opened.file, opened.name, {
            htmlPrefix:
              opened.grant === "html-document" && origin
                ? `${origin}${WORKSPACE_ASSET_ROUTE_PREFIX}${handle}/`
                : undefined,
          });
          return true;
        }
      }
      const asset = await authorizer.readHandle(handle);
      res.writeHead(200, {
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(asset.bytes.byteLength),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": asset.mimeType,
        ETag: `"${asset.contentSha256}"`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(asset.bytes);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return true;
      }
      sendAssetError(res, error);
    }
    return true;
  }

  if (url.pathname !== "/api/project-favicon") {
    return false;
  }
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) {
    res.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
    res.end("Missing projectId parameter");
    return true;
  }

  try {
    const config = await checkedInProjectFileService.load(ProjectId.makeUnsafe(projectId));
    const requestedIconPath = url.searchParams.get("iconPath")?.trim();
    if (requestedIconPath !== undefined && (!requestedIconPath || requestedIconPath.length > 512)) {
      throw new WorkspaceAssetAuthorizationError("invalid_path", "Invalid project icon path");
    }
    const relativePath =
      requestedIconPath ??
      config.iconPath ??
      (await findFaviconRelativePath(authorizer, projectId));
    if (!relativePath) {
      sendFallbackFavicon(res);
      return true;
    }
    const reader = await authorizer.forProject(projectId);
    const issued = reader.issueImageHandle({
      relativePath,
      maxBytes: faviconMaxBytes(relativePath),
      rejectSymlink: requestedIconPath !== undefined || config.iconPath === relativePath,
    });
    res.writeHead(302, {
      "Cache-Control": "private, no-store",
      Location: `${WORKSPACE_ASSET_ROUTE_PREFIX}${encodeURIComponent(issued.handle)}`,
      "Referrer-Policy": "no-referrer",
    });
    res.end();
  } catch (error) {
    sendAssetError(res, error);
  }
  return true;
}
