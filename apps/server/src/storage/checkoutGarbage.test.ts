import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEPENDENCY_QUARANTINE_PREFIX,
  findDependencyFolders,
  findTemporaryPacks,
  removeDependencyFolder,
  scanCheckoutGarbage,
} from "./checkoutGarbage.ts";
import { fileIdentity } from "./diskUsage.ts";
import { runStorageTask } from "./storageWorker.ts";

let root: string;
beforeEach(async () => {
  root = await FS.realpath(await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-checkout-garbage-")));
});
afterEach(async () => {
  await FS.rm(root, { recursive: true, force: true });
});

async function write(path: string, contents = "x") {
  await FS.mkdir(Path.dirname(path), { recursive: true });
  await FS.writeFile(path, contents);
}
async function age(path: string, ms: number) {
  const when = new Date(Date.now() - ms);
  await FS.utimes(path, when, when);
}
const relative = (paths: ReadonlyArray<{ readonly path: string }>) =>
  paths.map((entry) => Path.relative(root, entry.path)).toSorted();
const noProcesses = async () => [];

describe("dependency folders", () => {
  it("finds node_modules, real virtualenvs and .turbo without descending into them", async () => {
    await write(Path.join(root, "node_modules", "left-pad", "index.js"));
    await write(Path.join(root, "node_modules", "a", "node_modules", "b", "index.js"));
    await write(Path.join(root, "apps", "web", "node_modules", "react", "index.js"));
    await write(Path.join(root, "apps", "web", ".turbo", "cache.json"));
    await write(Path.join(root, "tools", ".venv", "pyvenv.cfg"));
    // A folder merely named .venv is not a virtualenv.
    await write(Path.join(root, "docs", ".venv", "notes.md"));
    const result = await findDependencyFolders(root);
    expect(relative(result.folders)).toEqual([
      "apps/web/.turbo",
      "apps/web/node_modules",
      "node_modules",
      "tools/.venv",
    ]);
    expect(result.folders.find((f) => f.path.endsWith("tools/.venv"))?.kind).toBe(".venv");
  });

  it("skips symlinks, nested checkouts, .git and folders past the depth limit", async () => {
    const outside = Path.join(root, "..", Path.basename(root) + "-outside");
    await write(Path.join(outside, "node_modules", "x.js"));
    try {
      await FS.mkdir(Path.join(root, "linked"), { recursive: true });
      await FS.symlink(
        Path.join(outside, "node_modules"),
        Path.join(root, "linked", "node_modules"),
      );
      await FS.symlink(outside, Path.join(root, "outside"));
      await write(Path.join(root, "nested", ".git", "HEAD"));
      await write(Path.join(root, "nested", "node_modules", "x.js"));
      await write(Path.join(root, ".git", "node_modules", "x.js"));
      await write(Path.join(root, "a", "b", "c", "node_modules", "x.js"));
      await write(Path.join(root, "a", "b", "c", "d", "node_modules", "x.js"));
      expect(relative((await findDependencyFolders(root)).folders)).toEqual(["a/b/c/node_modules"]);
    } finally {
      await FS.rm(outside, { recursive: true, force: true });
    }
  });

  it("offers a quarantine an interrupted cleanup left behind", async () => {
    await write(Path.join(root, `${DEPENDENCY_QUARANTINE_PREFIX}1234`, "pkg", "index.js"));
    const result = await findDependencyFolders(root);
    expect(result.folders.map((f) => f.kind)).toEqual(["quarantine"]);
  });

  it("sizes each folder and suggests how to restore it, through the worker", async () => {
    await write(Path.join(root, "bun.lock"));
    await write(Path.join(root, "node_modules", "pkg", "index.js"), "x".repeat(10_000));
    await write(Path.join(root, "py", "uv.lock"));
    await write(Path.join(root, "py", ".venv", "pyvenv.cfg"));
    const scan = await runStorageTask<Awaited<ReturnType<typeof scanCheckoutGarbage>>>({
      kind: "checkoutScan",
      checkouts: [{ root, commonDir: null }],
      nowMs: Date.now(),
      sizeBudgetMs: 30_000,
    });
    expect(scan.measured).toBe(true);
    const modules = scan.folders.find((f) => f.kind === "node_modules");
    expect(modules?.bytes).toBeGreaterThanOrEqual(10_000);
    expect(modules?.restoreHint).toBe("restore with bun install");
    expect(scan.folders.find((f) => f.kind === ".venv")?.restoreHint).toBe("restore with uv sync");
  });

  it("quarantines and deletes a reviewed folder", async () => {
    await write(Path.join(root, "node_modules", "pkg", "index.js"), "x".repeat(5_000));
    const path = Path.join(root, "node_modules");
    const identity = fileIdentity(await FS.lstat(path));
    const result = await removeDependencyFolder(
      { path, checkoutRoot: root, identity },
      noProcesses,
    );
    expect(result.activity.state).toBe("idle");
    expect(result.removedBytes).toBeGreaterThanOrEqual(5_000);
    expect(await FS.readdir(root)).toEqual([]);
  });

  it("refuses a folder that changed or was replaced since review", async () => {
    await write(Path.join(root, "node_modules", "pkg", "index.js"));
    const path = Path.join(root, "node_modules");
    const identity = fileIdentity(await FS.lstat(path));
    // A reinstall adds packages: the folder's mtime moves.
    await write(Path.join(path, "added", "index.js"));
    await age(path, -5_000);
    await expect(
      removeDependencyFolder({ path, checkoutRoot: root, identity }, noProcesses),
    ).rejects.toThrow(/changed since review/);
    await FS.rm(path, { recursive: true });
    await write(Path.join(path, "pkg", "index.js"));
    await expect(
      removeDependencyFolder({ path, checkoutRoot: root, identity }, noProcesses),
    ).rejects.toThrow(/identity changed/);
    expect(await FS.readdir(root)).toEqual(["node_modules"]);
  });

  it("keeps the folder while a process runs inside the checkout", async () => {
    await write(Path.join(root, "node_modules", "pkg", "index.js"));
    const path = Path.join(root, "node_modules");
    const result = await removeDependencyFolder(
      { path, checkoutRoot: root, identity: fileIdentity(await FS.lstat(path)) },
      async () => [{ pid: 42, name: "node", cwd: root, paths: [] }],
    );
    expect(result.activity).toMatchObject({ state: "busy" });
    expect(await FS.readdir(root)).toEqual(["node_modules"]);
  });
});

describe("temporary packs", () => {
  it("lists only tmp_pack and tmp_idx files older than a day", async () => {
    const commonDir = Path.join(root, ".git");
    const pack = Path.join(commonDir, "objects", "pack");
    await write(Path.join(pack, "tmp_pack_old"), "x".repeat(4_096));
    await write(Path.join(pack, "tmp_idx_old"));
    await write(Path.join(pack, "tmp_pack_fresh"));
    await write(Path.join(pack, "pack-abc.pack"));
    await age(Path.join(pack, "tmp_pack_old"), 2 * 86400_000);
    await age(Path.join(pack, "tmp_idx_old"), 2 * 86400_000);
    await age(Path.join(pack, "pack-abc.pack"), 2 * 86400_000);
    const packs = await findTemporaryPacks(commonDir, Date.now());
    expect(packs.map((p) => Path.basename(p.path)).toSorted()).toEqual([
      "tmp_idx_old",
      "tmp_pack_old",
    ]);
    expect(packs[0]?.repositoryRoot).toBe(root);
    expect(await findTemporaryPacks(Path.join(root, "missing", ".git"), Date.now())).toEqual([]);
  });
});
