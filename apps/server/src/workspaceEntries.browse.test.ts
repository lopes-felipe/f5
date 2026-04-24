import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, assert, describe, it } from "vitest";

import { browseWorkspaceEntries } from "./workspaceEntries";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

describe("browseWorkspaceEntries", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists directories in the parent when partialPath ends with a separator", async () => {
    const cwd = makeTempDir("t3code-browse-");
    fs.mkdirSync(path.join(cwd, "alpha"));
    fs.mkdirSync(path.join(cwd, "beta"));
    writeFile(cwd, "notes.md");

    const result = await browseWorkspaceEntries({ partialPath: `${cwd}${path.sep}` });
    assert.strictEqual(result.parentPath, path.resolve(cwd));
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.name),
      ["alpha", "beta"],
    );
  });

  it("filters entries by the partial leaf segment when there is no trailing separator", async () => {
    const cwd = makeTempDir("t3code-browse-");
    fs.mkdirSync(path.join(cwd, "alpha"));
    fs.mkdirSync(path.join(cwd, "apple"));
    fs.mkdirSync(path.join(cwd, "beta"));

    const result = await browseWorkspaceEntries({
      partialPath: path.join(cwd, "al"),
    });
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.name),
      ["alpha"],
    );
  });

  it("hides dot-directories unless the prefix begins with a dot", async () => {
    const cwd = makeTempDir("t3code-browse-");
    fs.mkdirSync(path.join(cwd, ".config"));
    fs.mkdirSync(path.join(cwd, "visible"));

    const visibleResult = await browseWorkspaceEntries({
      partialPath: `${cwd}${path.sep}`,
    });
    assert.deepStrictEqual(
      visibleResult.entries.map((entry) => entry.name),
      ["visible"],
    );

    const hiddenResult = await browseWorkspaceEntries({
      partialPath: `${cwd}${path.sep}.`,
    });
    assert.deepStrictEqual(
      hiddenResult.entries.map((entry) => entry.name),
      [".config"],
    );
  });

  it("resolves explicit relative paths against the provided cwd", async () => {
    const baseDir = makeTempDir("t3code-browse-");
    const projectDir = path.join(baseDir, "project");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(path.join(projectDir, "docs"));
    fs.mkdirSync(path.join(projectDir, "dist"));
    fs.mkdirSync(path.join(baseDir, "sibling"));

    const result = await browseWorkspaceEntries({
      partialPath: `./`,
      cwd: projectDir,
    });
    assert.strictEqual(result.parentPath, path.resolve(projectDir));
    // dist is an ignored directory so it should not appear
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.name),
      ["docs"],
    );

    const parentResult = await browseWorkspaceEntries({
      partialPath: `../`,
      cwd: projectDir,
    });
    assert.strictEqual(parentResult.parentPath, path.resolve(baseDir));
    assert.isTrue(parentResult.entries.some((entry) => entry.name === "sibling"));
  });

  it("rejects relative paths without a current project", async () => {
    let caught: unknown = null;
    try {
      await browseWorkspaceEntries({ partialPath: "./docs" });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, Error);
    assert.match((caught as Error).message, /require a current project/);
  });
});
