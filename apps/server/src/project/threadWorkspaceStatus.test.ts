import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import {
  deriveThreadWorkspaceStatus,
  readBranchHolder,
  type ThreadWorkspaceFacts,
} from "./threadWorkspaceStatus.ts";

const folders: string[] = [];
const folder = async () => {
  const created = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "f5-status-")));
  folders.push(created);
  return created;
};
afterEach(async () => {
  for (const created of folders.splice(0)) await fs.rm(created, { recursive: true, force: true });
});

/** Any Git call fails the test. */
const noGit = new Proxy({} as GitCoreShape, {
  get: (_, name) => {
    throw new Error(`Git was asked: ${String(name)}`);
  },
});
const facts = (worktreePath: string, root: string): ThreadWorkspaceFacts => ({
  thread: { worktreePath, branch: "topic" },
  project: { workspaceRoot: root },
  switching: null,
  restoring: false,
  setup: "none",
  setupToken: null,
  queue: { paused: false, pauseReasonCode: null, pauseDetail: null },
  holder: () => Effect.succeed({ attachable: true, sharedWith: 0 }),
});

describe("deriveThreadWorkspaceStatus", () => {
  it("asks Git nothing while a checkout is at the folder and no send stopped on it", async () => {
    const root = await folder();
    const worktree = path.join(root, "topic");
    // A linked worktree's `.git` is a file.
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: elsewhere\n");
    // Every queue snapshot carries this status, so the usual case must stay cheap.
    expect(
      await Effect.runPromise(deriveThreadWorkspaceStatus(noGit, facts(worktree, root))),
    ).toEqual({ kind: "ready", location: "worktree", path: worktree, branch: "topic" });
  });

  it("looks at Git once a send has stopped on the folder", async () => {
    const root = await folder();
    const worktree = path.join(root, "topic");
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: elsewhere\n");
    // Git cannot be read here, so the status reports what stopped the send.
    let asked = 0;
    const unreadable = new Proxy({} as GitCoreShape, {
      get: () => () => {
        asked++;
        return Effect.fail(new Error("unreadable"));
      },
    });
    expect(
      await Effect.runPromise(
        deriveThreadWorkspaceStatus(unreadable, {
          ...facts(worktree, root),
          queue: {
            paused: true,
            pauseReasonCode: "worktree_missing",
            pauseDetail: "The folder holds something else.",
          },
        }),
      ),
    ).toEqual({
      kind: "attention",
      reason: "restore_failed",
      message: "The folder holds something else.",
      actions: ["retry", "useProjectFolder"],
    });
    expect(asked).toBeGreaterThan(0);
  });
});

describe("readBranchHolder", () => {
  const thread = (id: string, worktreePath: string | null, changed = {}) => ({
    id,
    projectId: "project",
    worktreePath,
    deletedAt: null,
    archivedAt: null,
    ...changed,
  });

  it("offers the project folder and counts the threads that already work there", async () => {
    const root = await folder();
    const other = await folder();
    const holder = readBranchHolder({
      config: null,
      project: { id: "project", workspaceRoot: root },
      threadId: "asking",
      threads: [
        thread("asking", path.join(root, "gone")),
        thread("local-1", null),
        thread("local-2", null),
        thread("archived", null, { archivedAt: "2026-01-01T00:00:00.000Z" }),
        thread("deleted", null, { deletedAt: "2026-01-01T00:00:00.000Z" }),
        thread("elsewhere", null, { projectId: "another-project" }),
        thread("in-a-worktree", other),
      ],
    });
    expect(await Effect.runPromise(holder(root))).toEqual({ attachable: true, sharedWith: 2 });
    // Without knowing which folders F5 manages, no other checkout is offered.
    expect(await Effect.runPromise(holder(other))).toEqual({ attachable: false, sharedWith: 1 });
  });
});
