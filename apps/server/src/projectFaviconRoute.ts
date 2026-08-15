import http from "node:http";

import {
  type WorkspaceAssetAuthorizer,
  WorkspaceAssetAuthorizationError,
  WORKSPACE_FAVICON_MAX_BYTES,
} from "./WorkspaceAssetAuthorizer";

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

const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
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

async function findFaviconRelativePath(
  authorizer: WorkspaceAssetAuthorizer,
  projectId: string,
): Promise<string | null> {
  const reader = await authorizer.forProject(projectId);
  for (const relativePath of FAVICON_CANDIDATES) {
    try {
      await reader.readImage({ relativePath, maxBytes: WORKSPACE_FAVICON_MAX_BYTES });
      return relativePath;
    } catch {
      // Missing, oversized, escaped, and spoofed candidates all fall through.
    }
  }

  for (const sourcePath of ICON_SOURCE_FILES) {
    let source: string;
    try {
      source = await reader.readText({
        relativePath: sourcePath,
        maxBytes: ICON_SOURCE_FILE_MAX_BYTES,
      });
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href) continue;
    for (const relativePath of resolveIconHref(href)) {
      try {
        await reader.readImage({ relativePath, maxBytes: WORKSPACE_FAVICON_MAX_BYTES });
        return relativePath;
      } catch {
        // Continue looking for an authorized favicon candidate.
      }
    }
  }
  return null;
}

export async function tryHandleProjectFaviconRequest(
  url: URL,
  res: http.ServerResponse,
  authorizer: WorkspaceAssetAuthorizer,
): Promise<boolean> {
  if (url.pathname.startsWith(WORKSPACE_ASSET_ROUTE_PREFIX)) {
    const handle = url.pathname.slice(WORKSPACE_ASSET_ROUTE_PREFIX.length);
    if (!handle || handle.includes("/")) {
      sendAssetError(res, new Error("Invalid handle"));
      return true;
    }
    try {
      const asset = await authorizer.readHandle(handle);
      res.writeHead(200, {
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(asset.bytes.byteLength),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": asset.mimeType,
        ETag: `"${asset.contentSha256}"`,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(asset.bytes);
    } catch (error) {
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
    const relativePath = await findFaviconRelativePath(authorizer, projectId);
    if (!relativePath) {
      sendFallbackFavicon(res);
      return true;
    }
    const reader = await authorizer.forProject(projectId);
    const issued = reader.issueImageHandle({
      relativePath,
      maxBytes: WORKSPACE_FAVICON_MAX_BYTES,
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
