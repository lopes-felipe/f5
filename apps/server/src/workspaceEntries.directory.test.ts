import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkspaceDirectory } from "./workspaceEntries";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-directory-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "nested.ts"), "content");
  await fs.writeFile(path.join(root, "README.md"), "readme");
  return root;
}
describe("lazy directory listing", () => {
  it("lists one level and reports complete counts when limited", async () => {
    const cwd = await fixture();
    const result = await listWorkspaceDirectory({ cwd, relativePath: "", limit: 1 });
    expect(result.entries).toEqual([{ path: "src", kind: "directory" }]);
    expect(result.totalEntries).toBe(2);
    expect(result.truncated).toBe(true);
    expect((await listWorkspaceDirectory({ cwd, relativePath: "src" })).entries).toEqual([
      { path: "src/nested.ts", kind: "file", parentPath: "src" },
    ]);
  });
  it("shows ignored files only when requested and never exposes Git metadata", async () => {
    const cwd = await fixture();
    execFileSync("git", ["init", "-q", cwd]);
    await fs.writeFile(path.join(cwd, ".gitignore"), "secret.env\n");
    await fs.writeFile(path.join(cwd, "secret.env"), "synthetic");
    expect(
      (await listWorkspaceDirectory({ cwd, relativePath: "" })).entries.some(
        (entry) => entry.path === "secret.env",
      ),
    ).toBe(false);
    const shown = await listWorkspaceDirectory({ cwd, relativePath: "", includeIgnored: true });
    expect(shown.entries.some((entry) => entry.path === "secret.env")).toBe(true);
    expect(shown.entries.some((entry) => entry.path === ".git")).toBe(false);
  });
  it("rejects traversal and follows internal directory symlinks", async () => {
    const cwd = await fixture();
    await fs.symlink(
      path.join(cwd, "src"),
      path.join(cwd, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const relativePath of ["../", "src/../", ".git", "C:\\outside"]) {
      await expect(listWorkspaceDirectory({ cwd, relativePath })).rejects.toThrow();
    }
    expect((await listWorkspaceDirectory({ cwd, relativePath: "link" })).entries).toEqual([
      { path: "link/nested.ts", kind: "file", parentPath: "link" },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "hides unsafe links and prevents cycles through sibling folders",
    async () => {
      const cwd = await fixture();
      const outside = await fixture();
      await fs.mkdir(path.join(cwd, ".git"));
      await fs.mkdir(path.join(cwd, "other"));
      for (const [name, target] of [
        ["file-link", "README.md"],
        ["dir-link", "src"],
        ["outside", outside],
        ["git-link", ".git"],
        ["dangling", "missing"],
        ["self", "."],
        ["src/up", ".."],
        ["src/sibling", "../other"],
        ["other/back", "../src"],
      ])
        await fs.symlink(target!, path.join(cwd, name!));
      const list = async (relativePath: string) =>
        (await listWorkspaceDirectory({ cwd, relativePath, includeIgnored: true })).entries;
      expect(await list("")).toEqual([
        { path: "dir-link", kind: "directory" },
        { path: "other", kind: "directory" },
        { path: "src", kind: "directory" },
        { path: "file-link", kind: "file" },
        { path: "README.md", kind: "file" },
      ]);
      expect(await list("src")).toEqual([
        { path: "src/sibling", kind: "directory", parentPath: "src" },
        { path: "src/nested.ts", kind: "file", parentPath: "src" },
      ]);
      expect(await list("src/sibling")).toEqual([]);
      for (const relativePath of ["outside", "git-link", "self", "src/up", "src/sibling/back"]) {
        await expect(list(relativePath)).rejects.toThrow();
      }
    },
  );

  it.skipIf(process.platform === "win32")("bounds filesystem work for many symlinks", async () => {
    const cwd = await fixture();
    await Promise.all(
      Array.from({ length: 200 }, (_, index) => fs.symlink("src", path.join(cwd, "link-" + index))),
    );
    const realpath = fs.realpath;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(fs, "realpath").mockImplementation((async (target: string) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await realpath(target);
      } finally {
        inFlight--;
      }
    }) as typeof fs.realpath);
    const result = await listWorkspaceDirectory({ cwd, relativePath: "", limit: 500 });
    expect(result.totalEntries).toBe(202);
    expect(result.entries.filter((entry) => entry.kind === "directory")).toHaveLength(201);
    expect(maxInFlight).toBeLessThanOrEqual(64);
  });
});
