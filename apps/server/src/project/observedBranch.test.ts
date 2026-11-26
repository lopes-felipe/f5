import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  syncObservedBranch,
  syncObservedCheckout,
  WORKSPACE_BRANCH_CHANGED_ACTIVITY_KIND,
  type ObservedBranchDeps,
} from "./observedBranch.ts";

type Command = Parameters<ObservedBranchDeps["engine"]["dispatch"]>[0];

interface FakeThread {
  id: ThreadId;
  projectId: string;
  branch: string | null;
  worktreePath: string | null;
  deletedAt: string | null;
  session: { activeTurnId: string | null; updatedAt: string } | null;
  latestTurn: { state: string } | null;
}

const thread = (id: string, overrides: Partial<FakeThread> = {}): FakeThread => ({
  id: ThreadId.makeUnsafe(id),
  projectId: "p",
  branch: "main",
  worktreePath: null,
  deletedAt: null,
  session: null,
  latestTurn: null,
  ...overrides,
});

/** A read model and a Git whose HEAD per folder the test sets. */
const world = (threads: FakeThread[]) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "f5-observed-")));
  const heads = new Map<string, string | null>();
  const commands: Command[] = [];
  const prepared: string[] = [];
  const model = {
    threads,
    projects: [{ id: "p", workspaceRoot: root, deletedAt: null }],
  };
  const deps = {
    engine: {
      getReadModel: () => Effect.succeed(model),
      dispatch: (command: Command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.meta.update") {
            const target = threads.find((entry) => entry.id === command.threadId);
            if (target && command.branch !== undefined) target.branch = command.branch;
          }
          return { sequence: commands.length };
        }),
    },
    git: {
      inspectCheckoutIdentity: (cwd: string) =>
        Effect.succeed({ canonicalRoot: cwd, commonDir: root, branch: heads.get(cwd) ?? null }),
      prepareObservedWorktreeBranch: (input: { path: string }) =>
        Effect.sync(() => {
          prepared.push(input.path);
          return { verifyBranch: Effect.void, commit: Effect.void };
        }),
    },
  } as unknown as ObservedBranchDeps;
  const notes = () =>
    commands.flatMap((command) =>
      command.type === "thread.activity.append" &&
      command.activity.kind === WORKSPACE_BRANCH_CHANGED_ACTIVITY_KIND
        ? [`${command.threadId}: ${command.activity.summary}`]
        : [],
    );
  return { root, heads, commands, prepared, deps, notes };
};

describe("syncObservedBranch", () => {
  it("makes a Local thread follow the project folder and notes the change", async () => {
    const local = thread("local");
    const w = world([local]);
    w.heads.set(w.root, "feature");
    expect(await Effect.runPromise(syncObservedBranch(w.deps, local.id))).toBe(true);
    expect(local.branch).toBe("feature");
    expect(w.notes()).toEqual(["local: Now on feature (was main)"]);
    // The project folder has no preparation receipt to move.
    expect(w.prepared).toEqual([]);
    // Nothing changes, and nothing is noted, once the record is current.
    expect(await Effect.runPromise(syncObservedBranch(w.deps, local.id))).toBe(false);
    expect(w.notes()).toHaveLength(1);
  });

  it("keeps the last attached branch on a detached HEAD or a temporary branch", async () => {
    const local = thread("local");
    const w = world([local]);
    w.heads.set(w.root, null);
    expect(await Effect.runPromise(syncObservedBranch(w.deps, local.id))).toBe(false);
    w.heads.set(w.root, "t3code/1234abcd");
    expect(await Effect.runPromise(syncObservedBranch(w.deps, local.id))).toBe(false);
    expect(local.branch).toBe("main");
    expect(w.commands).toEqual([]);
  });

  it("moves a worktree's receipts between turns but only re-records while a turn is ending", async () => {
    const idle = thread("idle", { worktreePath: "/wt/idle", branch: "recorded" });
    const ending = thread("ending", {
      worktreePath: "/wt/ending",
      branch: "recorded",
      latestTurn: { state: "running" },
    });
    const w = world([idle, ending]);
    w.heads.set("/wt/idle", "agent-branch").set("/wt/ending", "agent-branch");
    expect(await Effect.runPromise(syncObservedBranch(w.deps, idle.id))).toBe(true);
    expect(await Effect.runPromise(syncObservedBranch(w.deps, ending.id))).toBe(true);
    expect(w.prepared).toEqual(["/wt/idle"]);
    expect([idle.branch, ending.branch]).toEqual(["agent-branch", "agent-branch"]);
  });

  it("never fails when the folder cannot be read", async () => {
    const local = thread("local");
    const w = world([local]);
    const deps = {
      ...w.deps,
      git: { ...w.deps.git, inspectCheckoutIdentity: () => Effect.fail(new Error("gone")) },
    } as unknown as ObservedBranchDeps;
    expect(await Effect.runPromise(syncObservedBranch(deps, local.id))).toBe(false);
  });
});

describe("syncObservedCheckout", () => {
  it("records the branch for every thread sharing the worktree, except one mid-turn", async () => {
    const w = world([]);
    const shared = path.join(w.root, "shared");
    const first = thread("first", { worktreePath: shared, branch: "recorded" });
    const second = thread("second", { worktreePath: shared, branch: "recorded" });
    const busy = thread("busy", {
      worktreePath: shared,
      branch: "recorded",
      session: { activeTurnId: "turn", updatedAt: "now" },
    });
    const local = thread("local");
    const elsewhere = thread("elsewhere", { worktreePath: path.join(w.root, "other") });
    const deps = {
      ...w.deps,
      engine: {
        ...w.deps.engine,
        getReadModel: () =>
          Effect.succeed({
            threads: [first, second, busy, local, elsewhere],
            projects: [{ id: "p", workspaceRoot: w.root, deletedAt: null }],
          }),
        dispatch: (command: Command) =>
          Effect.sync(() => {
            w.commands.push(command);
            if (command.type === "thread.meta.update" && command.branch !== undefined)
              for (const entry of [first, second, busy])
                if (entry.id === command.threadId) entry.branch = command.branch;
            return { sequence: w.commands.length };
          }),
      },
    } as unknown as ObservedBranchDeps;
    await Effect.runPromise(syncObservedCheckout(deps, shared, "agent-branch"));
    expect([first.branch, second.branch, busy.branch]).toEqual([
      "agent-branch",
      "agent-branch",
      // Its turn's end records the branch once, wherever HEAD settles.
      "recorded",
    ]);
    // Local threads and other worktrees are not swept.
    expect([local.branch, elsewhere.branch]).toEqual(["main", "main"]);
    expect(w.notes()).toEqual([
      "first: Now on agent-branch (was recorded)",
      "second: Now on agent-branch (was recorded)",
    ]);
  });
});
