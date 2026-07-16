import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type ReviewDiffScope,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import { getReviewPreviewDiff, type ReviewDiffExecutionOptions } from "./ReviewDiffService.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const tempDirectories: string[] = [];

function git(cwd: string, args: ReadonlyArray<string>): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function gitRaw(cwd: string, args: ReadonlyArray<string>): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function write(cwd: string, relativePath: string, contents: string): void {
  const target = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function makeRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-review-diff-"));
  tempDirectories.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  write(cwd, "README.md", "initial\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

function makeReadModel(cwd: string): OrchestrationReadModel {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: cwd,
        defaultModel: "gpt-5-codex",
        scripts: [],
        memories: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: now,
        lastInteractionAt: now,
        updatedAt: now,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        checkpoints: [],
        compaction: null,
        session: null,
      },
    ],
  };
}

async function preview(
  cwd: string,
  scope: ReviewDiffScope,
  baseRef?: string,
  execution?: ReviewDiffExecutionOptions,
) {
  return Effect.runPromise(
    getReviewPreviewDiff(
      {
        request: { threadId: THREAD_ID, scope, ...(baseRef ? { baseRef } : {}) },
        readModel: makeReadModel(cwd),
      },
      execution,
    ),
  );
}

function terminalDiffRunner(
  terminalResult: Pick<ProcessRunResult, "aborted" | "timedOut">,
): NonNullable<ReviewDiffExecutionOptions["processRunner"]> {
  return async (command, args, options) => {
    if (args[0] === "diff" && args.includes("--binary")) {
      return {
        stdout: "",
        stderr: "",
        code: null,
        signal: "SIGTERM",
        timedOut: terminalResult.timedOut,
        aborted: terminalResult.aborted,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
    return runProcess(command, args, options);
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("getReviewPreviewDiff", () => {
  it("returns the complete working-tree diff without changing the real index", async () => {
    const cwd = makeRepository();
    write(cwd, "README.md", "staged\n");
    git(cwd, ["add", "README.md"]);
    write(cwd, "README.md", "staged and unstaged\n");
    write(cwd, "untracked.txt", "new\n");
    const statusBefore = git(cwd, ["status", "--porcelain=v1"]);

    const result = await preview(cwd, "working-tree");

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.patch).toContain("+staged and unstaged");
    expect(result.patch).toContain("untracked.txt");
    expect(result.baseRef).toBeNull();
    expect(git(cwd, ["status", "--porcelain=v1"])).toBe(statusBefore);
  });

  it("uses merge-base three-dot semantics for branch-range patches", async () => {
    const cwd = makeRepository();
    git(cwd, ["switch", "-c", "feature"]);
    write(cwd, "feature.txt", "feature\n");
    git(cwd, ["add", "feature.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    git(cwd, ["switch", "main"]);
    write(cwd, "base-only.txt", "base moved\n");
    git(cwd, ["add", "base-only.txt"]);
    git(cwd, ["commit", "-m", "move base"]);
    git(cwd, ["switch", "feature"]);

    const result = await preview(cwd, "branch-range", "main");

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.patch).toBe(
      gitRaw(cwd, ["diff", "--binary", "--full-index", "--minimal", "main...HEAD", "--"]),
    );
    expect(result.patch).toContain("feature.txt");
    expect(result.patch).not.toContain("base-only.txt");
    expect(result.patch).not.toBe(git(cwd, ["diff", "main..HEAD", "--"]));
  });

  it("prefers the remote default branch over a feature branch upstream", async () => {
    const cwd = makeRepository();
    git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(cwd, ["switch", "-c", "feature"]);
    write(cwd, "feature.txt", "feature\n");
    git(cwd, ["add", "feature.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    git(cwd, ["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    git(cwd, ["config", "branch.feature.remote", "origin"]);
    git(cwd, ["config", "branch.feature.merge", "refs/heads/feature"]);

    const result = await preview(cwd, "branch-range");

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.baseRef).toBe("refs/remotes/origin/main");
    expect(result.patch).toContain("feature.txt");
  });

  it("caps untracked enumeration and reports truncation", async () => {
    const cwd = makeRepository();
    for (let index = 0; index < 513; index += 1) {
      write(cwd, `untracked/${String(index).padStart(3, "0")}.txt`, `${index}\n`);
    }

    const result = await preview(cwd, "working-tree");

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toContain("512 untracked paths");
  });

  it("includes renamed, deleted, binary, and untracked files in the working-tree patch", async () => {
    const cwd = makeRepository();
    write(cwd, "rename-me.txt", "rename me\n");
    write(cwd, "delete-me.txt", "delete me\n");
    fs.writeFileSync(path.join(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "add fixtures"]);

    git(cwd, ["mv", "rename-me.txt", "renamed.txt"]);
    fs.rmSync(path.join(cwd, "delete-me.txt"));
    fs.writeFileSync(path.join(cwd, "binary.dat"), Buffer.from([0, 4, 5, 6]));
    write(cwd, "untracked.txt", "new file\n");

    const result = await preview(cwd, "working-tree");

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.patch).toContain("rename from rename-me.txt");
    expect(result.patch).toContain("rename to renamed.txt");
    expect(result.patch).toContain("deleted file mode");
    expect(result.patch).toContain("GIT binary patch");
    expect(result.patch).toContain("untracked.txt");
  });

  it("truncates at a complete file boundary and hashes the returned patch", async () => {
    const cwd = makeRepository();
    write(cwd, "a-small.txt", "small\n");
    write(cwd, "z-large.txt", `${"x".repeat(140 * 1024)}\n`);

    const result = await preview(cwd, "working-tree");

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("a-small.txt");
    expect(result.patch).not.toContain("z-large.txt");
    expect(result.diffHash).toBe(createHash("sha256").update(result.patch).digest("hex"));
  });

  it("supports an explicit base from detached HEAD and reports unborn repositories", async () => {
    const cwd = makeRepository();
    write(cwd, "feature.txt", "feature\n");
    git(cwd, ["add", "feature.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    git(cwd, ["switch", "--detach", "HEAD"]);

    const detachedWithBase = await preview(cwd, "branch-range", "main");
    const detachedWithoutBase = await preview(cwd, "branch-range");

    expect(detachedWithBase.kind).toBe("success");
    expect(detachedWithoutBase).toMatchObject({ kind: "error", code: "detached_head" });

    const unborn = fs.mkdtempSync(path.join(os.tmpdir(), "f5-review-diff-unborn-"));
    tempDirectories.push(unborn);
    git(unborn, ["init", "-b", "main"]);
    expect(await preview(unborn, "working-tree")).toMatchObject({
      kind: "error",
      code: "unborn_head",
    });
  });

  it("returns typed failures for missing threads and invalid refs", async () => {
    const cwd = makeRepository();
    const missingThread = await Effect.runPromise(
      getReviewPreviewDiff({
        request: { threadId: ThreadId.makeUnsafe("missing"), scope: "working-tree" },
        readModel: makeReadModel(cwd),
      }),
    );
    const invalidRef = await preview(cwd, "branch-range", "--not-a-ref");

    expect(missingThread).toMatchObject({ kind: "error", code: "thread_not_found" });
    expect(invalidRef).toMatchObject({ kind: "error", code: "invalid_ref" });
  });

  it("returns a retryable timeout when the bounded diff command reaches its deadline", async () => {
    const cwd = makeRepository();
    git(cwd, ["switch", "-c", "feature"]);
    write(cwd, "feature.txt", "feature\n");
    git(cwd, ["add", "feature.txt"]);
    git(cwd, ["commit", "-m", "feature"]);

    // The injected runner supplies the terminal timeout result deterministically;
    // a tiny wall-clock deadline here also races the setup Git probes.
    const result = await preview(cwd, "branch-range", "main", {
      processRunner: terminalDiffRunner({ timedOut: true, aborted: false }),
    });

    expect(result).toMatchObject({ kind: "error", code: "timeout", retryable: true });
  });

  it("returns a retryable cancellation when the bounded diff command is aborted", async () => {
    const cwd = makeRepository();
    git(cwd, ["switch", "-c", "feature"]);
    write(cwd, "feature.txt", "feature\n");
    git(cwd, ["add", "feature.txt"]);
    git(cwd, ["commit", "-m", "feature"]);

    const result = await preview(cwd, "branch-range", "main", {
      processRunner: terminalDiffRunner({ timedOut: false, aborted: true }),
    });

    expect(result).toMatchObject({ kind: "error", code: "cancelled", retryable: true });
  });

  it("rejects a registered workspace path that is a symbolic-link escape", async () => {
    const cwd = makeRepository();
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "f5-review-link-"));
    tempDirectories.push(linkParent);
    const workspaceLink = path.join(linkParent, "workspace");
    fs.symlinkSync(cwd, workspaceLink, process.platform === "win32" ? "junction" : "dir");

    const result = await preview(workspaceLink, "working-tree");

    expect(result).toMatchObject({ kind: "error", code: "workspace_invalid" });
  });
});
