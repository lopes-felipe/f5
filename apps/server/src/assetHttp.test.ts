import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetHeaders, openContainedFile, parseAssetRange } from "./assetHttp";
import { makeWorkspaceAssetAuthorizer } from "./WorkspaceAssetAuthorizer";

const openingRace = vi.hoisted(() => ({
  beforeOpen: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await openingRace.beforeOpen?.();
      return actual.open(...args);
    },
  };
});
const directories: string[] = [];
afterEach(async () => {
  openingRace.beforeOpen = undefined;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "f5-asset-grants-"));
  directories.push(root);
  await mkdir(path.join(root, "doc"));
  for (const name of [
    "index.html",
    "style.css",
    "secret.json",
    "app.js",
    "other.html",
    ".hidden.png",
  ])
    await writeFile(path.join(root, "doc", name), "fixture");
  return root;
}

describe("asset access", () => {
  it("refuses symlink files, symlink directories and parent traversal", async () => {
    const root = await fixture();
    await symlink(path.join(root, "doc"), path.join(root, "linked"), "junction");
    await symlink(path.join(root, "doc/style.css"), path.join(root, "alias.css"));
    for (const name of ["linked/style.css", "alias.css", "../file", "doc/../doc/style.css"]) {
      await expect(openContainedFile(root, name)).rejects.toThrow();
    }
    const file = await openContainedFile(root, "doc/style.css");
    try {
      expect(await file.readFile("utf8")).toBe("fixture");
    } finally {
      await file.close();
    }
  });
  it("rejects an inode swapped between authorization and opening", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "replacement.css"), "replacement");
    openingRace.beforeOpen = async () => {
      openingRace.beforeOpen = undefined;
      await rename(path.join(root, "replacement.css"), path.join(root, "doc/style.css"));
    };
    await expect(openContainedFile(root, "doc/style.css")).rejects.toThrow(
      "Asset changed while opening",
    );
  });
  it("evicts the least recently read capability at the 2048-entry limit", async () => {
    const root = await fixture();
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    const reader = await authorizer.forProject("project");
    const issue = () => reader.issueFileHandle({ relativePath: "doc/style.css", grant: "file" });
    const first = issue(),
      second = issue();
    for (let index = 2; index < 2048; index++) issue();
    await (await authorizer.openHandle(first.handle)).file.close();
    issue();
    await expect(authorizer.openHandle(second.handle)).rejects.toThrow(/expired/);
    await (await authorizer.openHandle(first.handle)).file.close();
  });
  it("restricts HTML siblings to passive extensions and expires grants", async () => {
    const root = await fixture();
    let now = 0;
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
      now: () => now,
    });
    const reader = await authorizer.forProject("project");
    const grant = reader.issueFileHandle({
      relativePath: "doc/index.html",
      grant: "html-document",
    });
    for (const name of ["index.html", "style.css"]) {
      const asset = await authorizer.openHandle(grant.handle, name);
      await asset.file.close();
    }
    for (const name of [
      "secret.json",
      "app.js",
      "other.html",
      ".hidden.png",
      "../style.css",
      "a/b/c/d/e/style.css",
    ]) {
      await expect(authorizer.openHandle(grant.handle, name)).rejects.toThrow();
    }
    now = grant.expiresAt;
    await expect(authorizer.openHandle(grant.handle)).rejects.toThrow(/expired/);
  });
  it("file grants never grant siblings", async () => {
    const root = await fixture();
    const authorizer = makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async () => root,
    });
    const reader = await authorizer.forProject("project");
    const grant = reader.issueFileHandle({ relativePath: "doc/index.html", grant: "file" });
    await expect(authorizer.openHandle(grant.handle, "style.css")).rejects.toThrow();
  });
});

it("uses restrictive headers for active formats and attachment fallback", () => {
  const html = assetHeaders("index.html", "http://127.0.0.1:3773/api/workspace-assets/test/");
  expect(html["Content-Security-Policy"]).toContain(
    "img-src http://127.0.0.1:3773/api/workspace-assets/test/",
  );
  expect(html["Content-Security-Policy"]).toContain("script-src 'none'");
  expect(html["Content-Security-Policy"]).toContain("form-action 'none'");
  expect(html["Referrer-Policy"]).toBe("no-referrer");
  expect(assetHeaders("index.html")["Content-Disposition"]).toMatch(/^attachment/);
  expect(assetHeaders("image.svg")["Content-Security-Policy"]).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(assetHeaders("video.mp4")["Content-Disposition"]).toMatch(/^inline/);
  expect(assetHeaders("data.json")["Content-Disposition"]).toMatch(/^attachment/);
});

it("handles single, open and suffix ranges and refuses unsatisfiable or multiple ranges", () => {
  expect(parseAssetRange(undefined, 10)).toBe(null);
  expect(parseAssetRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
  expect(parseAssetRange("bytes=8-", 10)).toEqual({ start: 8, end: 9 });
  expect(parseAssetRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  for (const range of ["bytes=10-", "bytes=3-1", "bytes=-0", "bytes=0-1,4-5", "bytes=-"])
    expect(parseAssetRange(range, 10)).toBe(false);
  expect(parseAssetRange("bytes=0-", 0)).toBe(false);
});
