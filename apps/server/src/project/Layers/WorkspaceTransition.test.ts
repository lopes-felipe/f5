import { ProfileId } from "@t3tools/contracts";
import { profileRegistryPath, profileStateDir } from "@t3tools/shared/profilePaths";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProfileRegistryStore } from "../../profiles/ProfileRegistryStore.ts";
import { git } from "../../storage/storageAutomation.testHarness.ts";
import { createWorkspaceTransitionFixture } from "./WorkspaceTransition.testHarness.ts";

describe("workspace transition execution", { timeout: 60_000 }, () => {
  const fixture = createWorkspaceTransitionFixture();

  it("moves staged, tracked, binary, executable and symlink files while keeping the root and refs/stash intact", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "README.md"), "previous stash\n");
    git(f.repo.root, "stash", "push", "-m", "existing");
    const existingStash = git(f.repo.root, "rev-parse", "refs/stash");
    await fs.writeFile(path.join(f.repo.root, "README.md"), "staged\n");
    git(f.repo.root, "add", "README.md");
    await fs.writeFile(path.join(f.repo.root, "README.md"), "staged and unstaged\n");
    const binaryName = process.platform === "win32" ? "binary file.bin" : "binary \n";
    await fs.writeFile(path.join(f.repo.root, binaryName), Buffer.from([0, 255, 12]));
    await fs.writeFile(path.join(f.repo.root, "run"), "#!/bin/sh\necho copied\n", { mode: 0o751 });
    await fs.symlink("/outside/never-follow", path.join(f.repo.root, "link"));
    await fs.writeFile(path.join(f.repo.root, ".env"), "secret");
    const before = git(f.repo.root, "status", "--porcelain=v2", "-z");
    const index = git(f.repo.root, "write-tree");
    const moved = await f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "feature/copied" }),
    );
    expect(moved.copiedFileCount).toBe(4);
    expect(git(f.repo.root, "status", "--porcelain=v2", "-z")).toBe(before);
    expect(git(f.repo.root, "write-tree")).toBe(index);
    expect(git(moved.worktreePath, "write-tree")).toBe(index);
    expect(git(f.repo.root, "rev-parse", "refs/stash")).toBe(existingStash);
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    expect(await fs.readFile(path.join(moved.worktreePath, "README.md"), "utf8")).toBe(
      "staged and unstaged\n",
    );
    expect(await fs.readFile(path.join(moved.worktreePath, binaryName))).toEqual(
      Buffer.from([0, 255, 12]),
    );
    expect((await fs.stat(path.join(moved.worktreePath, "run"))).mode & 0o777).toBe(
      (await fs.stat(path.join(f.repo.root, "run"))).mode & 0o777,
    );
    expect(await fs.readlink(path.join(moved.worktreePath, "link"))).toBe(
      process.platform === "win32"
        ? path.resolve("/outside/never-follow")
        : "/outside/never-follow",
    );
    expect(await fs.stat(path.join(moved.worktreePath, ".env")).catch(() => null)).toBeNull();
    const receipt = await f.runtime.runPromise(
      Effect.flatMap(Effect.service(GitCore), (git) =>
        git.readWorktreePreparation(moved.worktreePath),
      ),
    );
    expect(receipt?.phase).toBe("checkout_created");
    expect(f.preparations).toEqual([]);
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath).toBe(
      moved.worktreePath,
    );
    await expect(
      f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId })),
    ).rejects.toThrow("Only a local conversation");
  });

  it("saves the originals in a reversible stash only while the source still matches", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "README.md"), "copy me\n");
    git(f.repo.root, "add", "README.md");
    await fs.writeFile(path.join(f.repo.root, "untracked"), "original");
    const moved = await f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "discard-test" }),
    );
    await fs.writeFile(path.join(f.repo.root, "untracked"), "changed after move");
    await expect(
      f.runtime.runPromise(
        f.transition.discardMovedChanges({ threadId: f.threadId, operationId: moved.operationId }),
      ),
    ).rejects.toThrow("changed after the move");
    expect(git(f.repo.root, "stash", "list")).toBe("");
    await fs.writeFile(path.join(f.repo.root, "untracked"), "original");
    await f.runtime.runPromise(
      f.transition.discardMovedChanges({ threadId: f.threadId, operationId: moved.operationId }),
    );
    expect(git(f.repo.root, "status", "--porcelain")).toBe("");
    expect(git(f.repo.root, "stash", "list")).toContain(
      `f5: copied to discard-test (${moved.operationId})`,
    );
    expect(await fs.readFile(path.join(moved.worktreePath, "untracked"), "utf8")).toBe("original");
    expect((await f.runtime.runPromise(f.store.get(moved.operationId)))?.move?.discarded).toBe(
      true,
    );
    await f.runtime.runPromise(
      f.transition.discardMovedChanges({ threadId: f.threadId, operationId: moved.operationId }),
    );
    expect(git(f.repo.root, "stash", "list").split("\n")).toHaveLength(1);
  });

  it.each([false, true])(
    "rolls back verified copies and retains unexpected ignored files (unexpected=%s)",
    async (unexpected) => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo.root, "README.md"), "tracked copy\n");
      await fs.writeFile(path.join(f.repo.root, "a"), "first");
      await fs.writeFile(path.join(f.repo.root, "b"), "second");
      const before = git(f.repo.root, "status", "--porcelain=v2", "-z");
      f.copyControl.fail = true;
      f.copyControl.unexpected = unexpected;
      await expect(
        f.runtime.runPromise(
          f.transition.moveThread({ threadId: f.threadId, branch: "copy-failure" }),
        ),
      ).rejects.toThrow("copy failed");
      const record = (await f.runtime.runPromise(f.store.forThread(f.threadId)))!;
      expect(record.phase).toBe("failed");
      if (!unexpected) expect(record.error).toBe("copy failed");
      expect(git(f.repo.root, "status", "--porcelain=v2", "-z")).toBe(before);
      expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
      expect(git(f.repo.root, "branch", "--list", "copy-failure").length > 0).toBe(unexpected);
      expect(
        await fs
          .stat(record.target.path)
          .then(() => true)
          .catch(() => false),
      ).toBe(unexpected);
      if (unexpected) expect(record.error).toContain("Retained");
      expect(
        (await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath,
      ).toBeNull();
    },
  );

  it("refuses dirty submodules and invalid or existing branch names", async () => {
    const f = await fixture();
    await expect(
      f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "bad name" })),
    ).rejects.toThrow("Invalid branch");
    await expect(
      f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "main" })),
    ).rejects.toThrow("already exists");
    git(f.repo.root, "-c", "protocol.file.allow=always", "submodule", "add", f.repo.origin, "sub");
    git(f.repo.root, "commit", "-am", "submodule");
    await fs.writeFile(path.join(f.repo.root, "sub", "README.md"), "dirty submodule");
    await expect(
      f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId })),
    ).rejects.toThrow("Commit or stash submodule changes first");
  });

  it.each(["count", "size"])(
    "enforces the untracked %s limit before creating a worktree",
    async (limit) => {
      const f = await fixture();
      if (limit === "count") {
        for (let batch = 0; batch < 51; batch++)
          await Promise.all(
            Array.from({ length: batch === 50 ? 1 : 100 }, (_, i) =>
              fs.writeFile(path.join(f.repo.root, `loose-${batch * 100 + i}`), ""),
            ),
          );
      } else {
        const file = await fs.open(path.join(f.repo.root, "large"), "w");
        await file.truncate(500 * 1024 * 1024 + 1);
        await file.close();
      }
      await expect(
        f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "limit" })),
      ).rejects.toThrow(limit === "count" ? "5,000" : "500 MB");
      expect(git(f.repo.root, "branch", "--list", "limit")).toBe("");
      expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    },
  );

  it("refuses active sessions, Git operations and discarding while another session uses the root", async () => {
    const f = await fixture();
    f.world.sessions.push({ threadId: f.threadId, cwd: f.repo.root, status: "running" });
    await expect(
      f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "busy" })),
    ).rejects.toThrow(/active turn|session startup/);
    f.world.sessions.length = 0;
    await fs.writeFile(
      path.join(f.repo.root, ".git", "MERGE_HEAD"),
      git(f.repo.root, "rev-parse", "HEAD"),
    );
    await expect(
      f.runtime.runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "busy" })),
    ).rejects.toThrow("Finish the merge");
    await fs.unlink(path.join(f.repo.root, ".git", "MERGE_HEAD"));
    await fs.writeFile(path.join(f.repo.root, "loose"), "keep");
    const moved = await f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "busy" }),
    );
    f.world.sessions.push({ threadId: "other", cwd: f.repo.root, status: "idle" });
    await expect(
      f.runtime.runPromise(
        f.transition.discardMovedChanges({ threadId: f.threadId, operationId: moved.operationId }),
      ),
    ).rejects.toThrow("uses the project checkout");
    expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("keep");
  });

  it("blocks discard when another profile references the same project checkout", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "loose"), "shared files");
    const moved = await f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "shared-discard" }),
    );
    const stateDir = f.config.defaultStateDir!;
    const registry = await new ProfileRegistryStore(stateDir).read();
    if (!registry.ok) throw new Error("test registry missing");
    const current = registry.registry.profiles[0]!;
    const other = {
      ...current,
      id: ProfileId.makeUnsafe("b".repeat(32)),
      slug: "other",
      name: "Other",
      isDefault: false,
      port: current.port + 1,
    };
    await fs.writeFile(
      profileRegistryPath(stateDir),
      JSON.stringify({ ...registry.registry, profiles: [current, other] }),
    );
    const otherDir = profileStateDir(stateDir, other);
    await fs.mkdir(otherDir, { recursive: true });
    const db = new DatabaseSync(path.join(otherDir, "state.sqlite"));
    try {
      db.exec(
        "CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT); CREATE TABLE projection_threads(project_id TEXT,worktree_path TEXT,deleted_at TEXT)",
      );
      db.prepare("INSERT INTO projection_projects VALUES ('shared',?,NULL)").run(f.repo.root);
      db.exec("INSERT INTO projection_threads VALUES ('shared',NULL,NULL)");
      await expect(
        f.runtime.runPromise(
          f.transition.discardMovedChanges({
            threadId: f.threadId,
            operationId: moved.operationId,
          }),
        ),
      ).rejects.toThrow("Another profile references");
      expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("shared files");
      expect(
        (await f.runtime.runPromise(f.store.get(moved.operationId)))?.moveData?.discardStarted,
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("explains untracked nested repositories before mutating anything", async () => {
    const f = await fixture();
    const nested = path.join(f.repo.root, "scratch");
    await fs.mkdir(nested);
    git(nested, "init", "-q");
    await fs.writeFile(path.join(nested, "README"), "scratch clone");
    await expect(
      f.runtime.runPromise(
        f.transition.moveThread({ threadId: f.threadId, branch: "nested-test" }),
      ),
    ).rejects.toThrow(/Untracked nested repository "scratch\/".*Commit, ignore, or remove/);
    expect(git(f.repo.root, "branch", "--list", "nested-test")).toBe("");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
  });

  it("copies symlinks created with a different umask without comparing their permission bits", async () => {
    const f = await fixture();
    const previous = process.umask(0o077);
    try {
      await fs.symlink("/never-follow", path.join(f.repo.root, "private-link"));
    } finally {
      process.umask(previous);
    }
    const moved = await f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "symlink-modes" }),
    );
    expect(await fs.readlink(path.join(moved.worktreePath, "private-link"))).toBe(
      process.platform === "win32" ? path.resolve("/never-follow") : "/never-follow",
    );
    const { sameMoveFile } = await import("../../git/moveSnapshot.ts");
    const file = { path: "link", sha256: "hash", mode: 0o700, size: 4, symlink: true };
    expect(sameMoveFile(file, { ...file, mode: 0o755 })).toBe(true);
    expect(
      sameMoveFile({ ...file, symlink: false }, { ...file, symlink: false, mode: 0o755 }),
    ).toBe(false);
  });

  it.each(["unchanged", "after_stash"] as const)(
    "retries only definitely unchanged discard failures (%s)",
    async (failure) => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo.root, "loose"), "save originals");
      const moved = await f.runtime.runPromise(
        f.transition.moveThread({ threadId: f.threadId, branch: "retry-discard" }),
      );
      f.discardControl.failure = failure;
      const request = { threadId: f.threadId, operationId: moved.operationId };
      await expect(f.runtime.runPromise(f.transition.discardMovedChanges(request))).rejects.toThrow(
        "stash push failed",
      );
      expect(
        (await f.runtime.runPromise(f.store.get(moved.operationId)))?.moveData?.discardStarted,
      ).toBe(failure === "after_stash");
      f.discardControl.failure = null;
      if (failure === "unchanged")
        await expect(
          f.runtime.runPromise(f.transition.discardMovedChanges(request)),
        ).resolves.toEqual({ discarded: true });
      else
        await expect(
          f.runtime.runPromise(f.transition.discardMovedChanges(request)),
        ).rejects.toThrow("Discard was interrupted");
    },
  );

  it("retains a branch created by an external Git process just before worktree add", async () => {
    const f = await fixture();
    f.mutationControl.raceBranch = true;
    await expect(
      f.runtime.runPromise(
        f.transition.moveThread({ threadId: f.threadId, branch: "external-race" }),
      ),
    ).rejects.toThrow("already exists");
    expect(git(f.repo.root, "rev-parse", "external-race")).toBe(
      git(f.repo.root, "rev-parse", "HEAD"),
    );
    expect((await f.runtime.runPromise(f.store.forThread(f.threadId)))?.error).toContain(
      "no creation proof",
    );
  });

  it("replays a generic move with a client operation ID without copying twice", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "loose"), "generic move");
    const request = await f.request("move_to_new_worktree", {
      operationId: "client-move-123",
      branch: "generic-move",
    });
    const first = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(first.phase).toBe("completed");
    const second = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(second.operationId).toBe("client-move-123");
    expect(second.version).toBe(first.version);
    await expect(
      f.runtime.runPromise(f.transition.switchWorkspace({ ...request, branch: "changed" })),
    ).rejects.toThrow("another request");
  });
});
