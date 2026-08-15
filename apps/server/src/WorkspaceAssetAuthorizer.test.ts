import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  makeWorkspaceAssetAuthorizer,
  WORKSPACE_FAVICON_MAX_BYTES,
} from "./WorkspaceAssetAuthorizer";

const PROJECT_ID = "project-assets";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

describe("WorkspaceAssetAuthorizer", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads only signed images rooted in a registered project identity", async () => {
    const root = makeTempDir("f5-workspace-assets-");
    fs.writeFileSync(path.join(root, "icon.png"), pngBytes());
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async (projectId) => (projectId === PROJECT_ID ? root : null),
      resolveThreadWorkspaceRoot: async (threadId) => (threadId === "thread-assets" ? root : null),
    });

    const asset = await (
      await authorizer.forProject(PROJECT_ID)
    ).readImage({
      relativePath: "icon.png",
    });
    expect(asset.mimeType).toBe("image/png");
    expect(asset.bytes).toEqual(pngBytes());
    await expect(authorizer.forProject(root)).rejects.toMatchObject({
      failure: "identity_not_found",
    });
    await expect(
      (await authorizer.forThread("thread-assets")).readImage({ relativePath: "icon.png" }),
    ).resolves.toMatchObject({
      identity: { kind: "thread", threadId: "thread-assets" },
    });
  });

  it("rejects traversal, symlink escapes, MIME spoofing, and oversized files", async () => {
    const root = makeTempDir("f5-workspace-assets-root-");
    const outside = makeTempDir("f5-workspace-assets-outside-");
    fs.writeFileSync(path.join(outside, "outside.png"), pngBytes());
    fs.symlinkSync(path.join(outside, "outside.png"), path.join(root, "escape.png"));
    fs.writeFileSync(path.join(root, "spoof.png"), "not a png", "utf8");
    fs.writeFileSync(path.join(root, "oversized.png"), Buffer.alloc(32, 0x89));
    const reader = await makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    }).forProject(PROJECT_ID);

    await expect(reader.readImage({ relativePath: "../outside.png" })).rejects.toMatchObject({
      failure: "invalid_path",
    });
    await expect(reader.readImage({ relativePath: "escape.png" })).rejects.toMatchObject({
      failure: "invalid_path",
    });
    await expect(reader.readImage({ relativePath: "spoof.png" })).rejects.toMatchObject({
      failure: "mime_mismatch",
    });
    await expect(
      reader.readImage({ relativePath: "oversized.png", maxBytes: 16 }),
    ).rejects.toMatchObject({ failure: "too_large" });
  });

  it("expires opaque handles and reauthorizes their project and path on every read", async () => {
    const root = makeTempDir("f5-workspace-assets-handle-");
    const outside = makeTempDir("f5-workspace-assets-handle-outside-");
    const iconPath = path.join(root, "icon.png");
    fs.writeFileSync(iconPath, pngBytes());
    fs.writeFileSync(path.join(outside, "outside.png"), pngBytes());
    let timestamp = 100;
    let registeredRoot: string | null = root;
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => registeredRoot,
      now: () => timestamp,
      handleTtlMs: 50,
      createHandle: () => "opaque-handle",
    });
    const reader = await authorizer.forProject(PROJECT_ID);
    const issued = reader.issueImageHandle({
      relativePath: "icon.png",
      maxBytes: WORKSPACE_FAVICON_MAX_BYTES,
    });
    expect(issued).toEqual({ handle: "opaque-handle", expiresAt: 150 });
    await expect(authorizer.readHandle(issued.handle)).resolves.toMatchObject({
      identity: { kind: "project", projectId: PROJECT_ID },
      relativePath: "icon.png",
    });

    fs.rmSync(iconPath);
    fs.symlinkSync(path.join(outside, "outside.png"), iconPath);
    await expect(authorizer.readHandle(issued.handle)).rejects.toMatchObject({
      failure: "invalid_path",
    });

    fs.rmSync(iconPath);
    fs.writeFileSync(iconPath, pngBytes());
    registeredRoot = null;
    await expect(authorizer.readHandle(issued.handle)).rejects.toMatchObject({
      failure: "identity_not_found",
    });

    registeredRoot = root;
    timestamp = 151;
    await expect(authorizer.readHandle(issued.handle)).rejects.toMatchObject({
      failure: "expired_handle",
    });
  });
});
