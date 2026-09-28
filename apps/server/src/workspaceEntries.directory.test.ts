import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkspaceDirectory } from "./workspaceEntries";
const roots: string[] = [];
afterEach(async () => {
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
  it("rejects traversal and directory symlinks", async () => {
    const cwd = await fixture();
    await fs.symlink(
      path.join(cwd, "src"),
      path.join(cwd, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const relativePath of ["../", "src/../", ".git", "link", "C:\\outside"]) {
      await expect(listWorkspaceDirectory({ cwd, relativePath })).rejects.toThrow();
    }
  });
});
