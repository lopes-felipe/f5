import type http from "node:http";
import { F5_PROTOCOL_HEADER } from "@t3tools/contracts";
import type { Path } from "effect";

export const STATIC_HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob: https:; connect-src 'self' ws: wss: http: https:; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export const PRIVATE_CORS_METHODS = new Set(["GET", "POST"]);
/** One list drives both preflight validation and `Access-Control-Allow-Headers`. */
export const PRIVATE_CORS_HEADER_NAMES = [
  "Authorization",
  "Content-Type",
  "X-F5-Backup-Password",
  F5_PROTOCOL_HEADER,
  "X-F5-File-Name",
  "X-F5-Upload-Client",
] as const;
export const PRIVATE_CORS_HEADERS = new Set(
  PRIVATE_CORS_HEADER_NAMES.map((header) => header.toLowerCase()),
);
export const PRIVATE_CORS_ALLOW_HEADERS = PRIVATE_CORS_HEADER_NAMES.join(", ");

export const DESKTOP_RENDERER_ORIGIN = "t3://app";

export type ResolvedStaticAssetRequest =
  | { readonly ok: false; readonly reason: "invalid-path" }
  | {
      readonly ok: true;
      readonly staticRoot: string;
      readonly rawRelativePath: string;
      readonly filePath: string;
    };

/**
 * Resolves a request pathname against `staticDir`, rejecting path traversal,
 * null bytes, and paths escaping `staticDir`. Extensionless paths map to their
 * directory `index.html`.
 */
export function resolveStaticAssetPath(params: {
  readonly staticDir: string;
  readonly pathname: string;
  readonly path: Pick<Path.Path, "resolve" | "normalize" | "extname" | "sep">;
}): ResolvedStaticAssetRequest {
  const { path } = params;
  const staticRoot = path.resolve(params.staticDir);
  const staticRequestPath = params.pathname === "/" ? "/index.html" : params.pathname;
  const rawRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
  const hasRawLeadingParentSegment = rawRelativePath.startsWith("..");
  const staticRelativePath = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  const hasPathTraversalSegment = staticRelativePath.startsWith("..");
  if (
    staticRelativePath.length === 0 ||
    hasRawLeadingParentSegment ||
    hasPathTraversalSegment ||
    staticRelativePath.includes("\0")
  ) {
    return { ok: false, reason: "invalid-path" };
  }

  const isWithinStaticRoot = (candidate: string) =>
    candidate === staticRoot ||
    candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

  let filePath = path.resolve(staticRoot, staticRelativePath);
  if (!isWithinStaticRoot(filePath)) {
    return { ok: false, reason: "invalid-path" };
  }

  const ext = path.extname(filePath);
  if (!ext) {
    filePath = path.resolve(filePath, "index.html");
    if (!isWithinStaticRoot(filePath)) {
      return { ok: false, reason: "invalid-path" };
    }
  }

  return { ok: true, staticRoot, rawRelativePath, filePath };
}

/**
 * Decides whether a missing static file should fall back to SPA `index.html`
 * or return 404 (bundle assets and non-HTML requests always 404).
 */
export function shouldFallbackToSpaIndex(
  headers: http.IncomingHttpHeaders,
  rawRelativePath: string,
): boolean {
  const wantsHtml =
    headers["sec-fetch-mode"] === "navigate" ||
    /(?:^|,)\s*text\/html(?:[;,]|$)/i.test(headers.accept ?? "");
  const bundleRequest =
    rawRelativePath.startsWith("assets/") ||
    /\.(?:[cm]?js|css|map|wasm|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)$/i.test(rawRelativePath);
  return wantsHtml && !bundleRequest;
}

/**
 * Computes response headers for a served static asset, including immutable
 * caching for fingerprinted Vite assets and defense-in-depth CSP headers for
 * HTML documents.
 */
export function buildStaticAssetResponseHeaders(params: {
  readonly relativePath: string;
  readonly contentType: string;
  readonly pathSep: string;
}): Record<string, string> {
  const fingerprinted =
    params.relativePath.startsWith(`assets${params.pathSep}`) &&
    /-[a-zA-Z0-9_]{8,}\.[^.]+$/.test(params.relativePath);
  return {
    "Content-Type": params.contentType.startsWith("text/")
      ? `${params.contentType}; charset=utf-8`
      : params.contentType,
    "Cache-Control": fingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...(params.contentType === "text/html" ? STATIC_HTML_SECURITY_HEADERS : {}),
  };
}
