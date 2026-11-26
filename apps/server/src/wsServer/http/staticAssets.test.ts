import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildStaticAssetResponseHeaders,
  resolveStaticAssetPath,
  shouldFallbackToSpaIndex,
  STATIC_HTML_SECURITY_HEADERS,
} from "./staticAssets.ts";

describe("staticAssets", () => {
  const staticDir = "/app/dist/web";

  it("maps root and extensionless paths to index.html inside staticDir", () => {
    expect(resolveStaticAssetPath({ staticDir, pathname: "/", path })).toEqual({
      ok: true,
      staticRoot: path.resolve(staticDir),
      rawRelativePath: "index.html",
      filePath: path.resolve(staticDir, "index.html"),
    });
    expect(resolveStaticAssetPath({ staticDir, pathname: "/settings/general", path })).toEqual({
      ok: true,
      staticRoot: path.resolve(staticDir),
      rawRelativePath: "settings/general",
      filePath: path.resolve(staticDir, "settings/general/index.html"),
    });
  });

  it("rejects path traversal and null bytes", () => {
    expect(resolveStaticAssetPath({ staticDir, pathname: "/../secret.txt", path })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(
      resolveStaticAssetPath({ staticDir, pathname: "/assets/../../etc/passwd", path }),
    ).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(resolveStaticAssetPath({ staticDir, pathname: "/index.html\0.png", path })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("only falls back to SPA index for HTML navigation outside bundle asset paths", () => {
    expect(
      shouldFallbackToSpaIndex({ accept: "text/html,application/xhtml+xml" }, "threads/1"),
    ).toBe(true);
    expect(shouldFallbackToSpaIndex({ "sec-fetch-mode": "navigate" }, "settings")).toBe(true);
    expect(shouldFallbackToSpaIndex({ accept: "text/html" }, "assets/index-Ab12Cd34.js")).toBe(
      false,
    );
    expect(shouldFallbackToSpaIndex({ accept: "text/html" }, "favicon.ico")).toBe(false);
    expect(shouldFallbackToSpaIndex({ accept: "application/json" }, "threads/1")).toBe(false);
  });

  it("sets immutable cache headers for fingerprinted assets and CSP headers for HTML", () => {
    const jsHeaders = buildStaticAssetResponseHeaders({
      relativePath: `assets${path.sep}main-AbCd1234.js`,
      contentType: "text/javascript",
      pathSep: path.sep,
    });
    expect(jsHeaders["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(jsHeaders["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(jsHeaders["Content-Security-Policy"]).toBeUndefined();

    const htmlHeaders = buildStaticAssetResponseHeaders({
      relativePath: "index.html",
      contentType: "text/html",
      pathSep: path.sep,
    });
    expect(htmlHeaders["Cache-Control"]).toBe("no-cache");
    expect(htmlHeaders["X-Content-Type-Options"]).toBe("nosniff");
    expect(htmlHeaders["Content-Security-Policy"]).toBe(
      STATIC_HTML_SECURITY_HEADERS["Content-Security-Policy"],
    );
    expect(htmlHeaders["X-Frame-Options"]).toBe("DENY");
  });
});
