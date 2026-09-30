import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { makeWorkspaceAssetAuthorizer } from "./WorkspaceAssetAuthorizer";
import { makePreviewFileServer } from "./previewFileServer";

it("serves an explicit active document on its own origin and contains sibling access", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-active-preview-"));
  const server = makePreviewFileServer(
    makeWorkspaceAssetAuthorizer({ resolveProjectWorkspaceRoot: async () => root }),
  );
  try {
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "public/index.html"), '<script src="app.js"></script>');
    await writeFile(path.join(root, "public/app.js"), 'document.title="preview"');
    await writeFile(path.join(root, "public/.env"), "secret");
    await writeFile(path.join(root, "outside.json"), "private");
    const url = await server.issue({ kind: "project", projectId: "test" }, "public/index.html");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await fetch(new URL("app.js", url))).status).toBe(200);
    expect((await fetch(new URL(".env", url))).status).toBe(403);
    expect((await fetch(new URL("../outside.json", url))).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(url.replace(/\/[^/]+\/index.html$/u, "/unknown/index.html"))).status).toBe(
      404,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
