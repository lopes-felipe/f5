import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { PROJECT_LIST_ENTRIES_DEFAULT_LIMIT } from "@t3tools/contracts";

import {
  listWorkspaceDirectory,
  listWorkspaceEntries,
  searchWorkspaceEntries,
  setWorkspaceFffModuleLoaderForTests,
} from "./workspaceEntries";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe("searchWorkspaceEntries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setWorkspaceFffModuleLoaderForTests(null);
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a home directory workspace and its symlink before indexing", async () => {
    const home = makeTempDir("f5-workspace-home-");
    const alias = path.join(makeTempDir("f5-workspace-alias-"), "home");
    fs.symlinkSync(home, alias, "junction");
    writeFile(home, "OneDrive/Remix/part.stl");
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
    const readdir = vi.spyOn(fsPromises, "readdir");

    const alternateCase = path.join(path.dirname(home), path.basename(home).toUpperCase());
    const homePaths = fs.existsSync(alternateCase) ? [home, alias, alternateCase] : [home, alias];
    for (const cwd of homePaths) {
      await expect(searchWorkspaceEntries({ cwd, query: "stl", limit: 50 })).rejects.toThrow(
        "Workspace search is unavailable in the home directory.",
      );
      await expect(listWorkspaceEntries({ cwd })).rejects.toThrow(
        "Workspace search is unavailable in the home directory.",
      );
    }
    expect(readdir).not.toHaveBeenCalled();
    expect(await listWorkspaceDirectory({ cwd: home, relativePath: "" })).toMatchObject({
      entries: [{ path: "OneDrive", kind: "directory" }],
    });
    const result = await searchWorkspaceEntries({
      cwd: path.join(home, "OneDrive", "Remix"),
      query: "stl",
      limit: 50,
    });
    expect(result.entries.map((entry) => entry.path)).toEqual(["part.stl"]);
  });

  it("rejects a mount alias with the same filesystem identity as home", async () => {
    const home = makeTempDir("f5-workspace-home-");
    const alias = makeTempDir("f5-workspace-mount-");
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
    const stat = fsPromises.stat.bind(fsPromises);
    vi.spyOn(fsPromises, "stat").mockImplementation(((
      target: Parameters<typeof stat>[0],
      options: Parameters<typeof stat>[1],
    ) => stat(target === alias ? home : target, options)) as typeof fsPromises.stat);
    const readdir = vi.spyOn(fsPromises, "readdir");

    await expect(
      searchWorkspaceEntries({ cwd: alias, query: "", limit: 10 }),
    ).rejects.toMatchObject({
      code: "WorkspaceSearchRestricted",
      message: "Workspace search is unavailable in the home directory.",
    });
    expect(readdir).not.toHaveBeenCalled();
  });

  it("uses the workspace scan error for a missing workspace", async () => {
    const cwd = path.join(makeTempDir("f5-workspace-missing-"), "missing");
    await expect(searchWorkspaceEntries({ cwd, query: "", limit: 10 })).rejects.toThrow(
      `Unable to scan workspace entries at '${cwd}'`,
    );
  });

  it("rejects a workspace that resolves to the filesystem root before indexing", async () => {
    const cwd = makeTempDir("f5-workspace-root-");
    vi.spyOn(fsPromises, "realpath").mockResolvedValue(path.parse(cwd).root);
    const readdir = vi.spyOn(fsPromises, "readdir");

    await expect(searchWorkspaceEntries({ cwd, query: "", limit: 50 })).rejects.toThrow(
      "Workspace search is unavailable at the filesystem root.",
    );
    expect(readdir).not.toHaveBeenCalled();
  });

  it("returns files and directories relative to cwd", async () => {
    const cwd = makeTempDir("t3code-workspace-entries-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "README.md");
    writeFile(cwd, ".git/HEAD");
    writeFile(cwd, "node_modules/pkg/index.js");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
    assert.include(paths, "README.md");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".git")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("node_modules")));
    assert.isFalse(result.truncated);
  });

  it("lists the cached workspace index without requiring a query", async () => {
    const cwd = makeTempDir("t3code-workspace-list-entries-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "README.md");
    writeFile(cwd, "node_modules/pkg/index.js");

    await searchWorkspaceEntries({ cwd, query: "composer", limit: 10 });
    const realpath = vi.spyOn(fsPromises, "realpath");
    const result = await listWorkspaceEntries({ cwd });
    expect(realpath).not.toHaveBeenCalled();
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
    assert.include(paths, "README.md");
    assert.notInclude(paths, "node_modules/pkg/index.js");
    assert.isFalse(result.truncated);
    assert.equal(result.totalEntries, 5);
  });

  it("limits workspace list results before returning them to the client", async () => {
    const cwd = makeTempDir("t3code-workspace-list-entries-limit-");
    writeFile(cwd, "src/a.ts");
    writeFile(cwd, "src/b.ts");
    writeFile(cwd, "src/c.ts");

    const result = await listWorkspaceEntries({ cwd, limit: 2 });

    assert.lengthOf(result.entries, 2);
    assert.isTrue(result.truncated);
    assert.equal(result.totalEntries, 4);
  });

  it("rebuilds a truncated cached index for a later higher list limit", async () => {
    const cwd = makeTempDir("t3code-workspace-list-entries-limit-rebuild-");
    const fileCount = PROJECT_LIST_ENTRIES_DEFAULT_LIMIT + 10;
    for (let index = 0; index < fileCount; index += 1) {
      writeFile(cwd, `file-${String(index).padStart(5, "0")}.ts`);
    }

    const defaultResult = await listWorkspaceEntries({ cwd });
    assert.lengthOf(defaultResult.entries, PROJECT_LIST_ENTRIES_DEFAULT_LIMIT);
    assert.isTrue(defaultResult.truncated);

    const expandedResult = await listWorkspaceEntries({ cwd, limit: fileCount + 1 });
    assert.lengthOf(expandedResult.entries, fileCount);
    assert.isFalse(expandedResult.truncated);
    assert.equal(expandedResult.totalEntries, fileCount);
  });

  it("filters and ranks entries by query", async () => {
    const cwd = makeTempDir("t3code-workspace-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.some((entry) => entry.path === "src/components"));
    assert.isTrue(result.entries.every((entry) => entry.path.toLowerCase().includes("compo")));
  });

  it("supports fuzzy subsequence queries for composer path search", async () => {
    const cwd = makeTempDir("t3code-workspace-fuzzy-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
    const paths = result.entries.map((entry) => entry.path);

    assert.isAbove(result.entries.length, 0);
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
  });

  it("falls back to fff for typo-tolerant file search", async () => {
    const cwd = makeTempDir("t3code-workspace-fff-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "README.md");
    const destroy = vi.fn();
    let createOptions: unknown = null;
    const mixedSearch = vi.fn((_query: string, _options: { pageSize: number }) => ({
      ok: true as const,
      value: {
        items: [
          {
            type: "file" as const,
            item: { relativePath: "src/components/Composer.tsx" },
          },
        ],
        totalMatched: 1,
      },
    }));
    const create = vi.fn((options: unknown) => {
      createOptions = options;
      return {
        ok: true as const,
        value: {
          mixedSearch,
          isScanning: () => false,
          destroy,
        },
      };
    });

    setWorkspaceFffModuleLoaderForTests(async () => ({
      FileFinder: {
        create,
      },
    }));

    const result = await searchWorkspaceEntries({ cwd, query: "zzcomposer", limit: 10 });

    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["src/components/Composer.tsx"],
    );
    assert.isFalse(result.truncated);
    assert.equal(mixedSearch.mock.calls[0]?.[0], "zzcomposer");
    expect(createOptions).toMatchObject({
      basePath: cwd,
      enableFsRootScanning: false,
      enableHomeDirScanning: false,
    });
  });

  it("returns the lexical result while the fff index is still scanning", async () => {
    const cwd = makeTempDir("t3code-workspace-fff-scanning-");
    writeFile(cwd, "src/components/Composer.tsx");
    const mixedSearch = vi.fn();

    setWorkspaceFffModuleLoaderForTests(async () => ({
      FileFinder: {
        create: () => ({
          ok: true as const,
          value: {
            mixedSearch,
            isScanning: () => true,
            destroy: vi.fn(),
          },
        }),
      },
    }));

    const startedAt = Date.now();
    const result = await searchWorkspaceEntries({ cwd, query: "zzcomposer", limit: 10 });

    assert.deepEqual(result.entries, []);
    assert.isFalse(result.truncated);
    assert.isBelow(Date.now() - startedAt, 1_000);
    expect(mixedSearch).not.toHaveBeenCalled();
  });

  it("tracks truncation without sorting every fuzzy match", async () => {
    const cwd = makeTempDir("t3code-workspace-fuzzy-limit-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

    assert.lengthOf(result.entries, 1);
    assert.isTrue(result.truncated);
  });

  it("excludes gitignored paths for git repositories", async () => {
    const cwd = makeTempDir("t3code-workspace-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
    writeFile(cwd, "src/keep.ts", "export {};");
    writeFile(cwd, "ignored.txt", "ignore me");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("convex/")));
  });

  it("excludes tracked paths that match ignore rules", async () => {
    const cwd = makeTempDir("t3code-workspace-tracked-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");
    runGit(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
    writeFile(cwd, ".gitignore", ".convex/\n");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("excludes .convex in non-git workspaces", async () => {
    const cwd = makeTempDir("t3code-workspace-non-git-convex-");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("deduplicates concurrent index builds for the same cwd", async () => {
    const cwd = makeTempDir("t3code-workspace-concurrent-build-");
    writeFile(cwd, "src/components/Composer.tsx");

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await Promise.all([
      searchWorkspaceEntries({ cwd, query: "", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "comp", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "src", limit: 100 }),
    ]);

    assert.equal(rootReadCount, 1);
  });

  it("limits concurrent directory reads while walking the filesystem", async () => {
    const cwd = makeTempDir("t3code-workspace-read-concurrency-");
    for (let index = 0; index < 80; index += 1) {
      writeFile(cwd, `group-${index}/entry-${index}.ts`, "export {};");
    }

    let activeReads = 0;
    let peakReads = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(cwd)) {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 4));
        try {
          return await originalReaddir(...args);
        } finally {
          activeReads -= 1;
        }
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await searchWorkspaceEntries({ cwd, query: "", limit: 200 });

    assert.isAtMost(peakReads, 32);
  });
});
