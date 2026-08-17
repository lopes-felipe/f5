import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeWorkspaceAssetAuthorizer } from "./WorkspaceAssetAuthorizer";
import { makeCheckedInProjectFileService } from "./project/CheckedInProjectFileService";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";

interface HttpResponse {
  statusCode: number;
  contentType: string | null;
  cacheControl: string | null;
  noSniff: string | null;
  body: string;
}

const PROJECT_ID = "project-favicon";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function withRouteServer(
  roots: ReadonlyMap<string, string>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const authorizer = makeWorkspaceAssetAuthorizer({
    resolveProjectWorkspaceRoot: async (projectId) => roots.get(projectId) ?? null,
  });
  const checkedInProjectFileService = makeCheckedInProjectFileService(authorizer);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void tryHandleProjectFaviconRequest(url, res, authorizer, checkedInProjectFileService).then(
      (handled) => {
        if (handled || res.headersSent) return;
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected server address to be an object");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });
  }
}

async function request(baseUrl: string, pathname: string): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    noSniff: response.headers.get("x-content-type-options"),
    body: await response.text(),
  };
}

describe("tryHandleProjectFaviconRequest", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a registered project identity instead of an arbitrary cwd", async () => {
    const unregisteredRoot = makeTempDir("f5-favicon-unregistered-");
    fs.writeFileSync(path.join(unregisteredRoot, "favicon.svg"), "<svg>secret</svg>", "utf8");
    await withRouteServer(new Map(), async (baseUrl) => {
      const missing = await request(baseUrl, "/api/project-favicon");
      expect(missing.statusCode).toBe(400);
      expect(missing.body).toBe("Missing projectId parameter");

      const arbitraryRoot = await request(
        baseUrl,
        `/api/project-favicon?projectId=${encodeURIComponent(unregisteredRoot)}`,
      );
      expect(arbitraryRoot.statusCode).toBe(404);
      expect(arbitraryRoot.body).toBe("Not Found");
    });
  });

  it("serves a signed favicon through a private opaque handle", async () => {
    const projectRoot = makeTempDir("f5-favicon-route-root-");
    fs.writeFileSync(path.join(projectRoot, "favicon.svg"), "<svg>favicon</svg>", "utf8");
    await withRouteServer(new Map([[PROJECT_ID, projectRoot]]), async (baseUrl) => {
      const response = await request(baseUrl, `/api/project-favicon?projectId=${PROJECT_ID}`);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.cacheControl).toContain("private");
      expect(response.noSniff).toBe("nosniff");
      expect(response.body).toBe("<svg>favicon</svg>");
    });
  });

  it("resolves authorized icon metadata regardless of attribute ordering", async () => {
    const projectRoot = makeTempDir("f5-favicon-route-source-");
    const iconPath = path.join(projectRoot, "public", "brand", "logo.svg");
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "index.html"),
      '<link href="/brand/logo.svg" rel="icon">',
      "utf8",
    );
    fs.writeFileSync(iconPath, "<svg>brand</svg>", "utf8");
    await withRouteServer(new Map([[PROJECT_ID, projectRoot]]), async (baseUrl) => {
      const response = await request(baseUrl, `/api/project-favicon?projectId=${PROJECT_ID}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("<svg>brand</svg>");
    });
  });

  it("bounds parsing work for large source files without icon declarations", async () => {
    const projectRoot = makeTempDir("f5-favicon-route-pathological-");
    fs.writeFileSync(
      path.join(projectRoot, "index.html"),
      `export default { ${"rel: 'noise', ".repeat(16_000)}`,
      "utf8",
    );
    await withRouteServer(new Map([[PROJECT_ID, projectRoot]]), async (baseUrl) => {
      const response = await request(baseUrl, `/api/project-favicon?projectId=${PROJECT_ID}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });

  it("prefers an authorized f5.json icon over discovered favicon candidates", async () => {
    const projectRoot = makeTempDir("f5-favicon-route-config-");
    fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "favicon.svg"), "<svg>discovered</svg>", "utf8");
    fs.writeFileSync(
      path.join(projectRoot, "assets", "project.svg"),
      "<svg>configured</svg>",
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "f5.json"),
      JSON.stringify({ iconPath: "assets/project.svg" }),
      "utf8",
    );

    await withRouteServer(new Map([[PROJECT_ID, projectRoot]]), async (baseUrl) => {
      const response = await request(baseUrl, `/api/project-favicon?projectId=${PROJECT_ID}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("<svg>configured</svg>");
    });
  });

  it("falls back for missing, oversized, spoofed, and symlink-escaped icons", async () => {
    const outside = makeTempDir("f5-favicon-route-outside-");
    fs.writeFileSync(path.join(outside, "logo.svg"), "<svg>outside</svg>", "utf8");
    const cases: Array<(root: string) => void> = [
      () => undefined,
      (root) => fs.writeFileSync(path.join(root, "favicon.png"), Buffer.alloc(1024 * 1024 + 1)),
      (root) => fs.writeFileSync(path.join(root, "favicon.png"), "not a png", "utf8"),
      (root) => fs.symlinkSync(path.join(outside, "logo.svg"), path.join(root, "favicon.svg")),
    ];

    for (const setup of cases) {
      const projectRoot = makeTempDir("f5-favicon-route-fallback-");
      setup(projectRoot);
      await withRouteServer(new Map([[PROJECT_ID, projectRoot]]), async (baseUrl) => {
        const response = await request(baseUrl, `/api/project-favicon?projectId=${PROJECT_ID}`);
        expect(response.statusCode).toBe(200);
        expect(response.contentType).toContain("image/svg+xml");
        expect(response.body).toContain('data-fallback="project-favicon"');
      });
    }
  });
});
