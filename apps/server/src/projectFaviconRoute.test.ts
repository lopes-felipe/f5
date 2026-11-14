import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceAssetAuthorizer } from "./WorkspaceAssetAuthorizer";
import { makeCheckedInProjectFileService } from "./project/CheckedInProjectFileService";
import { findFaviconRelativePath, tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import { fakePng, icns } from "./icns.testkit";

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
    vi.restoreAllMocks();
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caches discoveries for ten minutes and validates only the cached image on hits", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const root = makeTempDir("f5-favicon-cache-");
    fs.mkdirSync(path.join(root, "public"));
    fs.writeFileSync(path.join(root, "public/favicon.svg"), "<svg>public</svg>");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const readImage = vi.fn(reader.readImage);
    const cachedAuthorizer = {
      ...authorizer,
      forProject: async () => ({ ...reader, readImage }),
    };
    expect(await findFaviconRelativePath(cachedAuthorizer, PROJECT_ID)).toBe("public/favicon.svg");
    fs.writeFileSync(path.join(root, "favicon.svg"), "<svg>root</svg>");
    readImage.mockClear();
    expect(await findFaviconRelativePath(cachedAuthorizer, PROJECT_ID)).toBe("public/favicon.svg");
    expect(readImage).toHaveBeenCalledTimes(1);
    now = 600_001;
    expect(await findFaviconRelativePath(cachedAuthorizer, PROJECT_ID)).toBe("favicon.svg");
  });

  it("expires misses after one minute and immediately replaces deleted cached icons", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const root = makeTempDir("f5-favicon-cache-miss-");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    expect(await findFaviconRelativePath(authorizer, PROJECT_ID)).toBeNull();
    fs.writeFileSync(path.join(root, "favicon.svg"), "<svg>root</svg>");
    expect(await findFaviconRelativePath(authorizer, PROJECT_ID)).toBeNull();
    now = 60_001;
    expect(await findFaviconRelativePath(authorizer, PROJECT_ID)).toBe("favicon.svg");
    fs.unlinkSync(path.join(root, "favicon.svg"));
    fs.writeFileSync(path.join(root, "favicon.ico"), "invalid");
    expect(await findFaviconRelativePath(authorizer, PROJECT_ID)).toBeNull();
  });

  it("bounds the cache to 512 projects and still authorizes cached misses", async () => {
    const root = makeTempDir("f5-favicon-cache-capacity-");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const readText = vi.fn(async () => {
      throw new Error("missing");
    });
    const forProject = vi.fn(async () => ({ ...reader, readText }));
    const cachedAuthorizer = { ...authorizer, forProject };
    for (let index = 0; index < 512; index++) {
      await findFaviconRelativePath(cachedAuthorizer, String(index));
    }
    // Recently used entries survive eviction even when inserted first.
    await findFaviconRelativePath(cachedAuthorizer, "0");
    await findFaviconRelativePath(cachedAuthorizer, "512");
    readText.mockClear();
    expect(await findFaviconRelativePath(cachedAuthorizer, "0")).toBeNull();
    expect(readText).not.toHaveBeenCalled();
    expect(await findFaviconRelativePath(cachedAuthorizer, "1")).toBeNull();
    expect(readText).toHaveBeenCalledTimes(7);
    forProject.mockRejectedValueOnce(new Error("project removed"));
    await expect(findFaviconRelativePath(cachedAuthorizer, "512")).rejects.toThrow(
      "project removed",
    );
    expect(await findFaviconRelativePath(cachedAuthorizer, "512")).toBeNull();
  });

  it.each([true, false])("re-discovers after a root change (cached hit=%s)", async (hit) => {
    const oldRoot = makeTempDir("f5-favicon-old-root-");
    const newRoot = makeTempDir("f5-favicon-new-root-");
    if (hit) {
      fs.mkdirSync(path.join(oldRoot, "public"));
      fs.writeFileSync(path.join(oldRoot, "public/favicon.svg"), "<svg>old</svg>");
    }
    fs.mkdirSync(path.join(newRoot, "public"));
    fs.writeFileSync(path.join(newRoot, "public/favicon.svg"), "<svg>lower rank</svg>");
    fs.writeFileSync(path.join(newRoot, "favicon.svg"), "<svg>preferred</svg>");
    let root = oldRoot;
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    expect(await findFaviconRelativePath(authorizer, PROJECT_ID)).toBe(
      hit ? "public/favicon.svg" : null,
    );
    root = newRoot;
    expect(await findFaviconRelativePath(authorizer, PROJECT_ID)).toBe("favicon.svg");
  });

  it("bounds image validation reads across cached requests", async () => {
    const root = makeTempDir("f5-favicon-cached-budget-");
    fs.writeFileSync(path.join(root, "favicon.svg"), "<svg>icon</svg>");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const gate = Promise.withResolvers<void>();
    let gated = false;
    let active = 0;
    let peak = 0;
    const readImage = vi.fn(async (input: Parameters<typeof reader.readImage>[0]) => {
      if (!gated) return reader.readImage(input);
      active++;
      peak = Math.max(peak, active);
      try {
        await gate.promise;
        return await reader.readImage(input);
      } finally {
        active--;
      }
    });
    const cachedAuthorizer = { ...authorizer, forProject: async () => ({ ...reader, readImage }) };
    await findFaviconRelativePath(cachedAuthorizer, PROJECT_ID);
    readImage.mockClear();
    gated = true;
    const requests = Array.from({ length: 100 }, () =>
      findFaviconRelativePath(cachedAuthorizer, PROJECT_ID),
    );
    try {
      await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(32));
      expect(active).toBe(32);
    } finally {
      gate.resolve();
    }
    expect(await Promise.all(requests)).toEqual(Array(100).fill("favicon.svg"));
    expect(peak).toBe(32);
    expect(active).toBe(0);
  });

  it("shares pending lookups, retries expired ones, and ignores late old results", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const root = makeTempDir("f5-favicon-pending-");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const gate = Promise.withResolvers<void>();
    let blocked = true;
    const readImage = vi.fn(async (input: Parameters<typeof reader.readImage>[0]) => {
      if (input.relativePath === "favicon.svg" && blocked) {
        await gate.promise;
        throw new Error("old lookup missed");
      }
      return reader.readImage(input);
    });
    const forProject = vi.fn(async () => ({ ...reader, readImage }));
    const cachedAuthorizer = { ...authorizer, forProject };
    const first = findFaviconRelativePath(cachedAuthorizer, PROJECT_ID);
    const second = findFaviconRelativePath(cachedAuthorizer, PROJECT_ID);
    try {
      await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(22));
      expect(forProject).toHaveBeenCalledTimes(2);
      blocked = false;
      now = 30_001;
      fs.writeFileSync(path.join(root, "favicon.svg"), "<svg>recovered</svg>");
      // The original promise has not settled, but a fresh request can recover.
      expect(await findFaviconRelativePath(cachedAuthorizer, PROJECT_ID)).toBe("favicon.svg");
    } finally {
      gate.resolve();
    }
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(await findFaviconRelativePath(cachedAuthorizer, PROJECT_ID)).toBe("favicon.svg");
  });

  it("starts well-known probes and source reads concurrently while preserving stages", async () => {
    const projectRoot = makeTempDir("f5-favicon-concurrent-");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => projectRoot,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const images = Promise.withResolvers<void>();
    const sources = Promise.withResolvers<void>();
    const readImage = vi.fn(async (input: Parameters<typeof reader.readImage>[0]) => {
      await images.promise;
      return reader.readImage(input);
    });
    const readText = vi.fn(async (input: Parameters<typeof reader.readText>[0]) => {
      await sources.promise;
      return reader.readText(input);
    });
    const resolution = findFaviconRelativePath(
      {
        ...authorizer,
        forProject: async () => ({ ...reader, readImage, readText }),
      },
      PROJECT_ID,
    );
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(22));
    expect(readText).not.toHaveBeenCalled();
    images.resolve();
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(7));
    sources.resolve();
    expect(await resolution).toBeNull();
  });

  it("preserves candidate rank without waiting for a stuck lower-ranked probe", async () => {
    const projectRoot = makeTempDir("f5-favicon-ranked-");
    fs.writeFileSync(path.join(projectRoot, "favicon.svg"), "<svg>root</svg>");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => projectRoot,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const stuck = Promise.withResolvers<void>();
    try {
      expect(
        await findFaviconRelativePath(
          {
            ...authorizer,
            forProject: async () => ({
              ...reader,
              readImage: async (input) => {
                if (input.relativePath === "favicon.ico") await stuck.promise;
                return reader.readImage(input);
              },
            }),
          },
          PROJECT_ID,
        ),
      ).toBe("favicon.svg");
    } finally {
      stuck.resolve();
    }
  });

  it("bounds concurrent reads across many projects and releases slots after failures", async () => {
    const projectRoot = makeTempDir("f5-favicon-budget-");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => projectRoot,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const gate = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const readImage = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await gate.promise;
        throw new Error("missing");
      } finally {
        active--;
      }
    });
    const readText = vi.fn(async () => {
      throw new Error("missing");
    });
    const resolutions = Array.from({ length: 10 }, (_, index) =>
      findFaviconRelativePath(
        {
          ...authorizer,
          forProject: async () => ({ ...reader, readImage, readText }),
        },
        String(index),
      ),
    );
    try {
      await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(32));
      expect(active).toBe(32);
    } finally {
      gate.resolve();
    }
    expect(await Promise.all(resolutions)).toEqual(Array(10).fill(null));
    expect(peak).toBe(32);
    expect(active).toBe(0);
    expect(readImage).toHaveBeenCalledTimes(220);
    expect(readText).toHaveBeenCalledTimes(70);
  });

  it("waits for a higher-ranked candidate even when a lower-ranked icon is ready", async () => {
    const projectRoot = makeTempDir("f5-favicon-rank-order-");
    fs.mkdirSync(path.join(projectRoot, "public"));
    fs.writeFileSync(path.join(projectRoot, "favicon.svg"), "<svg>root</svg>");
    fs.writeFileSync(path.join(projectRoot, "public", "favicon.svg"), "<svg>public</svg>");
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => projectRoot,
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const releaseRoot = Promise.withResolvers<void>();
    const publicReady = Promise.withResolvers<void>();
    let settled = false;
    const result = findFaviconRelativePath(
      {
        ...authorizer,
        forProject: async () => ({
          ...reader,
          readImage: async (input) => {
            if (input.relativePath === "favicon.svg") await releaseRoot.promise;
            const asset = await reader.readImage(input);
            if (input.relativePath === "public/favicon.svg") publicReady.resolve();
            return asset;
          },
        }),
      },
      PROJECT_ID,
    ).then((found) => {
      settled = true;
      return found;
    });
    try {
      await publicReady.promise;
      expect(settled).toBe(false);
    } finally {
      releaseRoot.resolve();
    }
    expect(await result).toBe("favicon.svg");
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

  it("serves a chosen project image instead of automatic discovery", async () => {
    const root = makeTempDir("f5-manual-icon-");
    fs.writeFileSync(path.join(root, "favicon.svg"), "<svg>automatic</svg>");
    fs.writeFileSync(path.join(root, "chosen.svg"), "<svg>chosen</svg>");
    await withRouteServer(new Map([[PROJECT_ID, root]]), async (baseUrl) => {
      const response = await request(
        baseUrl,
        `/api/project-favicon?projectId=${PROJECT_ID}&iconPath=chosen.svg`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("<svg>chosen</svg>");
    });
  });

  it("rejects chosen icons outside the project and symlinks, without reading their content", async () => {
    const root = makeTempDir("f5-manual-icon-root-");
    const outside = makeTempDir("f5-manual-icon-outside-");
    fs.writeFileSync(path.join(outside, "outside.svg"), "<svg>outside</svg>");
    fs.symlinkSync(path.join(outside, "outside.svg"), path.join(root, "linked.svg"));
    await withRouteServer(new Map([[PROJECT_ID, root]]), async (baseUrl) => {
      for (const iconPath of [
        path.join(outside, "outside.svg"),
        "../outside.svg",
        "linked.svg",
        "x".repeat(513),
      ]) {
        const response = await request(
          baseUrl,
          `/api/project-favicon?projectId=${PROJECT_ID}&iconPath=${encodeURIComponent(iconPath)}`,
        );
        expect(response.statusCode).not.toBe(200);
        expect(response.body).not.toContain("<svg>outside</svg>");
      }
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

  it("serves a macOS app icon as its embedded PNG", async () => {
    const projectRoot = makeTempDir("f5-favicon-route-icns-");
    fs.mkdirSync(path.join(projectRoot, "Resources"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "Resources", "AppIcon.icns"),
      icns([
        ["ic10", Buffer.concat([fakePng(1024), Buffer.alloc(1024 * 1024)])],
        ["ic07", fakePng(128)],
      ]),
    );
    await withRouteServer(new Map([[PROJECT_ID, projectRoot]]), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/project-favicon?projectId=${PROJECT_ID}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fakePng(128));
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

  it("falls back for missing, oversized, spoofed, PNG-less and symlink-escaped icons", async () => {
    const outside = makeTempDir("f5-favicon-route-outside-");
    fs.writeFileSync(path.join(outside, "logo.svg"), "<svg>outside</svg>", "utf8");
    const cases: Array<(root: string) => void> = [
      () => undefined,
      (root) => fs.writeFileSync(path.join(root, "favicon.png"), Buffer.alloc(1024 * 1024 + 1)),
      (root) => fs.writeFileSync(path.join(root, "favicon.png"), "not a png", "utf8"),
      (root) =>
        fs.writeFileSync(path.join(root, "AppIcon.icns"), icns([["is32", Buffer.alloc(64)]])),
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
