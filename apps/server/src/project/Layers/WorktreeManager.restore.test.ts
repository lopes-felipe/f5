import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../storage/storageAutomation.testHarness.ts";
import { planRestore } from "../threadWorkspaceStatus.ts";
import { createWorkspaceTransitionFixture } from "./WorkspaceTransition.testHarness.ts";

// One case per row of the restore table, against a real repository.
describe("restoring a thread's worktree", { timeout: 60_000 }, () => {
  const fixture = createWorkspaceTransitionFixture();
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** Puts the thread in a worktree of its own on `branch`, with one commit of work. */
  const inWorktree = async (f: Fixture, branch: string) => {
    const target = path.join(f.config.worktreesDir, branch);
    git(f.repo.root, "worktree", "add", "-q", "-b", branch, target, "main");
    await fs.writeFile(path.join(target, "work.txt"), "work\n");
    git(target, "add", ".");
    git(target, "commit", "-q", "-m", "work");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, branch }),
      ),
    );
    return { target: await fs.realpath(target), tip: git(target, "rev-parse", "HEAD") };
  };
  const status = (f: Fixture) =>
    f.runtime.runPromise(f.manager.threadState({ threadId: f.threadId }));
  const recover = (f: Fixture, action: "restore" | "attach" | "newWorktree") =>
    f.runtime.runPromise(f.manager.recover({ threadId: f.threadId, action }));
  const notes = async (f: Fixture) =>
    (await f.runtime.runPromise(f.engine.getReadModel())).threads
      .find((thread) => thread.id === f.threadId)!
      .activities.filter((activity) => activity.kind === "workspace.note")
      .map((activity) => [activity.tone, activity.summary]);

  it("puts the branch back where it was when only the folder is gone", async () => {
    const f = await fixture();
    const { target, tip } = await inWorktree(f, "kept");
    await fs.rm(target, { recursive: true });
    expect(await status(f)).toEqual({ kind: "dormant", path: target, branch: "kept" });

    expect(await recover(f, "restore")).toEqual({
      kind: "ready",
      location: "worktree",
      path: target,
      branch: "kept",
    });
    expect(git(target, "rev-parse", "HEAD")).toBe(tip);
    expect(git(target, "branch", "--show-current")).toBe("kept");
    expect(await notes(f)).toEqual([["info", "Worktree restored on kept"]]);
  });

  it("starts the branch again from the default branch when it is gone too, and says so", async () => {
    const f = await fixture();
    const { target } = await inWorktree(f, "gone");
    await fs.rm(target, { recursive: true });
    git(f.repo.root, "worktree", "prune");
    git(f.repo.root, "branch", "-D", "gone");
    expect(await status(f)).toEqual({ kind: "dormant", path: target, branch: "gone" });

    expect(await recover(f, "restore")).toEqual({
      kind: "ready",
      location: "worktree",
      path: target,
      branch: "gone",
    });
    const main = git(f.repo.root, "rev-parse", "main");
    expect(git(target, "rev-parse", "HEAD")).toBe(main);
    expect(git(target, "branch", "--show-current")).toBe("gone");
    // The branch's commits are lost, so the note stands out.
    expect(await notes(f)).toEqual([
      ["error", `gone no longer existed; recreated from main at ${main.slice(0, 7)}`],
    ]);
  });

  it("moves to a new folder when the recorded one now holds something else, and leaves that alone", async () => {
    const f = await fixture();
    const { target, tip } = await inWorktree(f, "squatted");
    await fs.rm(target, { recursive: true });
    // What a dev server or build cache leaves behind after the worktree is deleted.
    await fs.mkdir(path.join(target, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(target, "node_modules", "cache"), "leftover");
    expect(await status(f)).toEqual({ kind: "dormant", path: target, branch: "squatted" });

    const restored = await recover(f, "restore");
    expect(restored).toMatchObject({ kind: "ready", location: "worktree", branch: "squatted" });
    const moved = restored.kind === "ready" ? restored.path : "";
    expect(moved).not.toBe(target);
    expect(moved.startsWith(path.dirname(target) + path.sep)).toBe(true);
    expect(git(moved, "rev-parse", "HEAD")).toBe(tip);
    expect(git(moved, "branch", "--show-current")).toBe("squatted");
    expect(await fs.readdir(target)).toEqual(["node_modules"]);
    expect(await fs.readFile(path.join(target, "node_modules", "cache"), "utf8")).toBe("leftover");
    expect(await notes(f)).toEqual([["info", `Worktree moved to ${path.basename(moved)}`]]);
  });

  it.each(["attach", "newWorktree"] as const)(
    "asks when another checkout holds the branch, then follows the answer: %s",
    async (action) => {
      const f = await fixture();
      const { target, tip } = await inWorktree(f, "shared");
      await fs.rm(target, { recursive: true });
      git(f.repo.root, "worktree", "prune");
      git(f.repo.root, "checkout", "-q", "shared");
      const asking = {
        kind: "attention",
        reason: "branch_in_use",
        message:
          "shared is checked out in the project folder, so this thread's worktree cannot be restored on it.",
        actions: ["attach", "newWorktree"],
      };
      expect(await status(f)).toEqual(asking);
      // Nothing is decided for the user: the automatic restore leaves it as found.
      expect(await recover(f, "restore")).toEqual(asking);
      expect(await notes(f)).toEqual([]);

      const settled = await recover(f, action);
      if (action === "attach") {
        expect(settled).toMatchObject({ kind: "ready", branch: "shared" });
        expect(settled.kind === "ready" && (await fs.realpath(settled.path))).toBe(
          await fs.realpath(f.repo.root),
        );
      } else {
        // The work is on `shared`, so the new worktree starts from it on a branch of its own.
        expect(settled).toMatchObject({ kind: "ready", location: "worktree" });
        const created = settled.kind === "ready" ? settled : null;
        expect(created?.branch).not.toBe("shared");
        expect(git(created!.path, "rev-parse", "HEAD")).toBe(tip);
        expect(git(f.repo.root, "branch", "--show-current")).toBe("shared");
      }
    },
  );
});

describe("planRestore", () => {
  const found = {
    worktreePath: "/worktrees/a",
    branch: "a" as string | null,
    directoryExists: false,
    registration: "stale",
    branchExists: true,
    defaultBranch: "main" as string | null,
    headBranch: null,
    branchCheckedOutAt: null as string | null,
    grouped: false,
  } as const;
  it.each([
    [{ registration: "matching", directoryExists: true }, { kind: "none" }],
    [{}, { kind: "recreate" }],
    [{ registration: "foreign", directoryExists: true }, { kind: "recreate" }],
    [{ branchCheckedOutAt: "/repo" }, { kind: "branchInUse", at: "/repo" }],
    [{ branchExists: false }, { kind: "fromBase", base: "main" }],
    [
      { branch: null, branchExists: false },
      { kind: "fromBase", base: "main" },
    ],
    [{ branchExists: false, defaultBranch: null }, { kind: "impossible" }],
    [{ grouped: true }, { kind: "recreate" }],
    [{ grouped: true, registration: "foreign" }, { kind: "impossible" }],
  ] as const)("%o → %o", (changed, plan) => {
    expect(planRestore({ ...found, ...changed } as never)).toMatchObject(plan);
  });
});
