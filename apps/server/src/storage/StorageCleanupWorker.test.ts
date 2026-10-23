import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { createLargeIgnoredDependencyTree } from "../git/ignoredPaths.testUtils.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { withWorktreeLifecycleLock } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import {
  blockingIgnoredEntries,
  matchWorktreeCleanupRule,
  newerInteraction,
  redactHomePath,
  summarizeIgnoredCleanupPaths,
  StorageCleanupWorker,
  StorageCleanupWorkerLive,
} from "./StorageCleanupWorker.ts";
import { listStorageAutomationAudit } from "./automationAudit.ts";
import {
  automationLayer,
  git,
  makeClonedRepo,
  makeWorld,
  project,
  thread,
  type AutomationWorld,
} from "./storageAutomation.testHarness.ts";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const unchangedRule = {
  storageCleanup: {
    enabled: true,
    worktree: { afterDays: null, onMerge: false, onDelete: false, unchanged: true },
  },
};
/** Past the default 24-hour wait of the content rules. */
const idleSince = () => new Date(Date.now() - 2 * DAY_MS).toISOString();

describe("worktree cleanup rules", () => {
  const rules = { afterDays: 7, onMerge: true, onDelete: true, unchanged: false, minIdleHours: 24 };
  const base = {
    rules,
    deleted: false,
    lastInteractionAt: new Date(0).toISOString(),
    nowMs: 3 * DAY_MS,
    headInDefaultBranch: false,
    pullRequestMerged: false,
  };
  const remove = (reason: string) => ({ kind: "remove", reason });

  it("matches idle age, deletion, merges and unchanged branches", () => {
    expect(matchWorktreeCleanupRule(base)).toBeNull();
    expect(matchWorktreeCleanupRule({ ...base, nowMs: 8 * DAY_MS })).toEqual(
      remove("idle for 8 days"),
    );
    expect(matchWorktreeCleanupRule({ ...base, deleted: true })).toEqual(
      remove("the thread was deleted"),
    );
    // A merged PR whose head is not in the default branch is not eligible...
    expect(matchWorktreeCleanupRule({ ...base, pullRequestMerged: true })).toBeNull();
    // ...unless the PR names this exact HEAD, as a squash or rebase merge leaves it.
    expect(
      matchWorktreeCleanupRule({
        ...base,
        pullRequestMerged: true,
        pullRequestHeadIsWorktreeHead: true,
      }),
    ).toEqual(remove("the pull request was merged"));
    expect(
      matchWorktreeCleanupRule({
        ...base,
        pullRequestMerged: false,
        pullRequestHeadIsWorktreeHead: true,
      }),
    ).toBeNull();
    expect(
      matchWorktreeCleanupRule({ ...base, pullRequestMerged: true, headInDefaultBranch: true }),
    ).toEqual(remove("the pull request was merged"));
    expect(
      matchWorktreeCleanupRule({
        ...base,
        rules: { ...rules, unchanged: true },
        headInDefaultBranch: true,
      }),
    ).toEqual(remove("no commits beyond the default branch"));
    expect(
      matchWorktreeCleanupRule({ ...base, rules: { ...rules, onDelete: false }, deleted: true }),
    ).toBeNull();
  });

  it("waits until the thread has been idle minIdleHours for content rules", () => {
    const unchanged = { ...base, rules: { ...rules, unchanged: true }, headInDefaultBranch: true };
    // A thread interrupted by a restart 37 seconds before the cleanup pass.
    expect(matchWorktreeCleanupRule({ ...unchanged, nowMs: 37_000 })).toEqual({
      kind: "wait",
      reason:
        "no commits beyond the default branch, but a thread using it was active within the last 24 hours",
    });
    expect(matchWorktreeCleanupRule({ ...unchanged, nowMs: 24 * HOUR_MS })).toEqual(
      remove("no commits beyond the default branch"),
    );
    expect(
      matchWorktreeCleanupRule({
        ...unchanged,
        rules: { ...unchanged.rules, minIdleHours: 1 },
        nowMs: HOUR_MS - 1,
      }),
    ).toEqual({
      kind: "wait",
      reason:
        "no commits beyond the default branch, but a thread using it was active within the last 1 hour",
    });

    const merged = { ...base, pullRequestMerged: true, headInDefaultBranch: true };
    expect(matchWorktreeCleanupRule({ ...merged, nowMs: HOUR_MS })).toMatchObject({
      kind: "wait",
    });
    expect(matchWorktreeCleanupRule({ ...merged, nowMs: 25 * HOUR_MS })).toEqual(
      remove("the pull request was merged"),
    );

    // Deletion and the idle-days rule do not wait.
    expect(matchWorktreeCleanupRule({ ...base, deleted: true, nowMs: 1 })).toEqual(
      remove("the thread was deleted"),
    );
    expect(
      matchWorktreeCleanupRule({ ...base, rules: { ...rules, afterDays: 1 }, nowMs: DAY_MS }),
    ).toEqual(remove("idle for 1 days"));
  });

  it("never removes for an unreadable last interaction time", () => {
    const unreadable = { ...base, lastInteractionAt: "not a date", nowMs: 400 * DAY_MS };
    expect(matchWorktreeCleanupRule(unreadable)).toBeNull();
    expect(
      matchWorktreeCleanupRule({
        ...unreadable,
        rules: { ...rules, unchanged: true },
        headInDefaultBranch: true,
      }),
    ).toMatchObject({ kind: "wait" });
  });

  it("picks the later interaction, and an unreadable one over any other", () => {
    const older = new Date(0).toISOString();
    const newer = new Date(DAY_MS).toISOString();
    expect(newerInteraction(older, newer)).toBe(newer);
    expect(newerInteraction(newer, older)).toBe(newer);
    expect(newerInteraction(newer, "not a date")).toBe("not a date");
    expect(newerInteraction("not a date", newer)).toBe("not a date");
  });

  it("lets automatic cleanup delete build output but keeps local ignored files", () => {
    expect(
      blockingIgnoredEntries(
        ["node_modules/", "packages/web/node_modules/", ".env", "dist/", ".envrc", "id_rsa"],
        { kind: "rebuildable" },
      ),
    ).toEqual([".env", ".envrc", "id_rsa"]);
  });

  it("bounds ignored-path audit previews in UTF-8 bytes and reports omitted paths", () => {
    const entries = Array.from({ length: 1000 }, (_, i) => `dist/${i}-${"界".repeat(200)}\n.js`);
    const summary = summarizeIgnoredCleanupPaths(entries);
    expect(Buffer.byteLength(summary)).toBeLessThan(4200);
    expect(summary).toContain("1000 path(s):");
    expect(summary).toContain("more paths");
    expect(summary).toContain("\\n.js");
    expect(summary).not.toContain("\n");
  });
});

// Real repositories and many git calls per case: allow for loaded CI runners.
describe("StorageCleanupWorker", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** Runs `body` with a cloned repo and one thread whose worktree is under worktreesDir. */
  const withWorktree = <A, E>(
    settings: Parameters<typeof automationLayer>[1],
    body: (input: {
      world: AutomationWorld;
      root: string;
      worktreePath: string;
      worker: typeof StorageCleanupWorker.Service;
      core: typeof GitCore.Service;
    }) => Effect.Effect<A, E, SqlClient.SqlClient>,
  ) =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeClonedRepo("f5-cleanup-"));
      cleanups.push(repo.cleanup);
      const world = makeWorld();
      const layer = StorageCleanupWorkerLive.pipe(
        Layer.provideMerge(automationLayer(world, settings, "f5-cleanup-state-")),
      );
      return yield* Effect.gen(function* () {
        const config = yield* ServerConfig;
        const worktreePath = path.join(config.worktreesDir, "project", "feature");
        yield* Effect.promise(() => fs.mkdir(path.dirname(worktreePath), { recursive: true }));
        git(repo.root, "worktree", "add", "-q", "-b", "feature", worktreePath, "main");
        world.projects.push(project("project-1", repo.root));
        world.threads.push(
          thread({
            id: "thread-1",
            projectId: "project-1",
            worktreePath,
            branch: "feature",
            lastInteractionAt: idleSince(),
          }),
        );
        const worker = yield* StorageCleanupWorker;
        const core = yield* GitCore;
        return yield* body({ world, root: repo.root, worktreePath, worker, core });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

  it("removes a deleted owner's clean worktree after stopping its processes", async () => {
    await Effect.runPromise(
      withWorktree(
        {
          storageCleanup: {
            enabled: true,
            worktree: { afterDays: null, onMerge: false, onDelete: true, unchanged: false },
          },
        },
        ({ worker, world, worktreePath, root }) =>
          Effect.gen(function* () {
            world.threads[0] = { ...world.threads[0]!, deletedAt: new Date().toISOString() };
            world.sessions.push({ threadId: "thread-1", cwd: worktreePath, status: "ready" });
            world.terminals.push({
              threadId: "thread-1",
              terminalId: "shell",
              cwd: worktreePath,
              status: "running",
            });
            expect((yield* worker.dryRun).targets[0]?.action).toBe("remove");
            expect((yield* worker.runOnce)[0]?.action).toBe("remove");
            expect(world.sessions).toEqual([]);
            expect(world.terminals).toEqual([]);
            expect(
              yield* Effect.promise(() =>
                fs.access(worktreePath).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false);
            expect(git(root, "rev-parse", "refs/heads/feature")).toBeTruthy();
          }),
      ),
    );
  });

  it("protects pending and orphaned settlement scripts, then cleans after verified completion", async () => {
    await Effect.runPromise(
      withWorktree(
        {
          storageCleanup: {
            enabled: true,
            worktree: {
              afterDays: null,
              onMerge: false,
              onDelete: false,
              unchanged: false,
              onSettle: true,
            },
          },
        },
        ({ worker, world, worktreePath }) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const now = new Date().toISOString();
            world.threads[0] = { ...world.threads[0]!, settledAt: now, settledBy: "user" };
            yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model,scripts_json,created_at,updated_at,deleted_at) VALUES('project-1','P','/tmp',NULL,'[]',${now},${now},NULL)`;
            yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,branch,worktree_path,latest_turn_id,archived_at,created_at,last_interaction_at,updated_at,deleted_at) VALUES('thread-1','project-1','T','gpt-5',NULL,${worktreePath},NULL,NULL,${now},${now},${now},NULL)`;
            yield* sql`INSERT INTO thread_settlement_hooks(thread_id,job_id,settled_at,worktree_path,project_id,scripts_json,state,updated_at) VALUES('thread-1','hook',${now},${worktreePath},'project-1','[]','pending',${now})`;
            for (const state of ["pending", "running", "orphaned"]) {
              yield* sql`UPDATE thread_settlement_hooks SET state=${state}`;
              expect((yield* worker.runOnce)[0]?.action).toBe("skip");
              expect((yield* Effect.promise(() => fs.stat(worktreePath))).isDirectory()).toBe(true);
            }
            yield* sql`UPDATE thread_settlement_hooks SET state='completed'`;
            expect((yield* worker.runOnce)[0]?.action).toBe("remove");
          }),
      ),
    );
  });

  it("does nothing while storage cleanup is off", async () => {
    const result = await Effect.runPromise(withWorktree({}, ({ worker }) => worker.dryRun));
    expect(result).toMatchObject({ storageCleanupEnabled: false, targets: [] });
  });

  it("removes a clean unchanged worktree, keeps its branch and audits the removal", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, root, worktreePath }) =>
        Effect.gen(function* () {
          const preview = yield* worker.dryRun;
          expect(preview.targets).toEqual([
            {
              job: "worktree-cleanup",
              target: path.join("project", "feature"),
              projectId: "project-1",
              threadId: "thread-1",
              action: "remove",
              reason: "no commits beyond the default branch",
            },
          ]);
          // The dry run is read-only.
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);

          // node_modules/ is reproducible and does not block removal.
          yield* Effect.promise(() =>
            fs.mkdir(path.join(worktreePath, "node_modules", "pkg"), { recursive: true }),
          );
          const results = yield* worker.runOnce;
          expect(results.map((entry) => entry.action)).toEqual(["remove"]);
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(false);
          expect(git(root, "branch", "--list", "feature")).toContain("feature");

          const audit = yield* listStorageAutomationAudit(10);
          expect(audit).toHaveLength(1);
          expect(audit[0]).toMatchObject({
            job: "worktree-cleanup",
            target: path.join("project", "feature"),
            result: "removed",
            threadId: "thread-1",
            policyVersion: 2,
          });
          expect(audit[0]!.target).not.toContain(worktreePath);
        }),
      ),
    );
  });

  it("keeps an unchanged worktree whose thread was active recently", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, world, worktreePath }) =>
        Effect.gen(function* () {
          // A restart interrupted the thread's turn moments ago: no session,
          // turn or queued work claims the worktree any more.
          world.threads[0] = {
            ...world.threads[0]!,
            lastInteractionAt: new Date(Date.now() - 37_000).toISOString(),
          };
          const reason =
            "no commits beyond the default branch, but a thread using it was active within the last 24 hours";
          expect((yield* worker.dryRun).targets).toEqual([
            expect.objectContaining({ action: "skip", reason }),
          ]);
          expect(yield* worker.runOnce).toEqual([
            expect.objectContaining({ action: "skip", reason }),
          ]);
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);
          expect(yield* listStorageAutomationAudit(10)).toEqual([]);
        }),
      ),
    );
  });

  it("keeps a worktree an idle thread shares with a recently active one", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, world, worktreePath }) =>
        Effect.gen(function* () {
          world.threads.push(
            thread({
              id: "thread-2",
              projectId: "project-1",
              worktreePath,
              branch: "feature",
              lastInteractionAt: new Date(Date.now() - 30_000).toISOString(),
            }),
          );
          const results = yield* worker.runOnce;
          expect(results.map((entry) => [entry.threadId, entry.action])).toEqual([
            ["thread-1", "skip"],
            ["thread-2", "skip"],
          ]);
          expect(results[0]!.reason).toContain("a thread using it was active");
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);
        }),
      ),
    );
  });

  it("skips worktrees with uncommitted, untracked or ignored files", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(worktreePath, ".env"), "SECRET=1\n"));
          const ignored = yield* worker.runOnce;
          expect(ignored[0]).toMatchObject({ action: "skip" });
          expect(ignored[0]!.reason).toContain("ignored files that are not build output (.env)");

          yield* Effect.promise(() => fs.rm(path.join(worktreePath, ".env")));
          yield* Effect.promise(() => fs.writeFile(path.join(worktreePath, "new.txt"), "x\n"));
          const untracked = yield* worker.dryRun;
          expect(untracked.targets[0]!.reason).toContain("it has uncommitted changes");
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);
        }),
      ),
    );
  });

  it("preserves hidden untracked files even when repository status hides them", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath }) =>
        Effect.gen(function* () {
          git(worktreePath, "config", "status.showUntrackedFiles", "no");
          yield* Effect.promise(() =>
            fs.writeFile(path.join(worktreePath, "hidden.txt"), "keep me"),
          );
          const result = yield* worker.runOnce;
          expect(result[0]).toMatchObject({ action: "skip" });
          expect(result[0]!.reason).toContain("uncommitted changes");
          expect(
            yield* Effect.promise(() => fs.readFile(path.join(worktreePath, "hidden.txt"), "utf8")),
          ).toBe("keep me");
        }),
      ),
    );
  });

  it("protects ignored environment files inside an ignored output directory", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.appendFile(path.join(root, ".git", "info", "exclude"), "\ndist/\n"),
          );
          yield* Effect.promise(() => fs.mkdir(path.join(worktreePath, "dist")));
          yield* Effect.promise(() =>
            fs.writeFile(path.join(worktreePath, "dist", ".env.local"), "keep me"),
          );
          const result = yield* worker.runOnce;
          expect(result[0]).toMatchObject({ action: "skip" });
          expect(result[0]!.reason).toContain("dist/.env.local");
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);
        }),
      ),
    );
  });

  it("keeps ignored local files such as .envrc and private keys", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.envrc\nid_rsa\n"),
          );
          yield* Effect.promise(() => fs.writeFile(path.join(worktreePath, ".envrc"), "keep"));
          yield* Effect.promise(() => fs.writeFile(path.join(worktreePath, "id_rsa"), "keep"));
          const result = yield* worker.runOnce;
          expect(result[0]).toMatchObject({ action: "skip" });
          expect(result[0]!.reason).toContain(".envrc");
          expect(yield* Effect.promise(() => exists(path.join(worktreePath, "id_rsa")))).toBe(true);
        }),
      ),
    );
  });

  it("allows ignored build output and lists it in the removal audit", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.appendFile(path.join(root, ".git", "info", "exclude"), "\ndist/\n"),
          );
          yield* Effect.promise(() => fs.mkdir(path.join(worktreePath, "dist")));
          yield* Effect.promise(() =>
            fs.writeFile(path.join(worktreePath, "dist", "index.js"), "built"),
          );
          const result = yield* worker.runOnce;
          expect(result[0]).toMatchObject({ action: "remove" });
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(false);
          expect((yield* listStorageAutomationAudit(10))[0]!.reason).toContain('"dist/"');
        }),
      ),
    );
  });

  it("handles over a megabyte of ignored dependency paths and still protects nested secrets", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath }) =>
        Effect.gen(function* () {
          const directory = yield* Effect.promise(() =>
            createLargeIgnoredDependencyTree(worktreePath),
          );
          yield* Effect.promise(() =>
            fs.writeFile(path.join(directory, ".env.local"), "keep this credential"),
          );
          const protectedResult = yield* worker.runOnce;
          expect(protectedResult[0]!.reason).toContain(".env.local");
          expect(
            yield* Effect.promise(() => fs.readFile(path.join(directory, ".env.local"), "utf8")),
          ).toBe("keep this credential");
          yield* Effect.promise(() => fs.rm(path.join(directory, ".env.local")));
          expect((yield* worker.runOnce)[0]).toMatchObject({ action: "remove" });
          const audit = (yield* listStorageAutomationAudit(10)).find(
            (entry) => entry.result === "removed",
          );
          expect(audit?.reason).toContain("node_modules/");
          expect(Buffer.byteLength(audit!.reason!)).toBeLessThan(8192);
        }),
      ),
    );
  });

  it("reports truncation and refuses cleanup when even collapsed ignored paths exceed the bound", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, worktreePath, root, core }) =>
        Effect.gen(function* () {
          git(worktreePath, "config", "status.showUntrackedFiles", "no");
          yield* Effect.promise(async () => {
            await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.cache-*\n");
          });
          yield* Effect.promise(async () => {
            for (let start = 0; start < 400; start += 50)
              await Promise.all(
                Array.from({ length: 50 }, (_, offset) =>
                  fs.writeFile(
                    path.join(worktreePath, `.cache-${"x".repeat(200)}-${start + offset}`),
                    "keep",
                  ),
                ),
              );
          });
          const inspected = yield* core.inspectCheckout(worktreePath);
          expect(inspected.ignoredTruncated).toBe(true);
          expect(inspected.hasUntrackedChanges).toBe(false);
          expect((yield* worker.dryRun).targets[0]!.reason).toContain("too many ignored files");
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);
        }),
      ),
    );
  });

  it("skips worktrees another thread, a terminal, a session or queued work claims", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, world, worktreePath }) =>
        Effect.gen(function* () {
          world.terminals.push({
            threadId: "thread-1",
            terminalId: "default",
            cwd: worktreePath,
            status: "running",
          });
          expect((yield* worker.dryRun).targets[0]!.reason).toContain("a terminal is open in it");
          world.terminals.length = 0;

          world.sessions.push({ threadId: "thread-1", cwd: worktreePath, status: "ready" });
          expect((yield* worker.dryRun).targets[0]!.reason).toContain(
            "an agent session is open in it",
          );
          world.sessions.length = 0;

          world.queuedThreadIds.add("thread-1");
          expect((yield* worker.dryRun).targets[0]!.reason).toContain(
            "the thread has queued turns",
          );
          world.queuedThreadIds.clear();

          world.threads.push(
            thread({
              id: "thread-2",
              projectId: "project-1",
              worktreePath,
              branch: "feature",
              lastInteractionAt: idleSince(),
            }),
          );
          const shared = yield* worker.runOnce;
          expect(shared[0]!.action).toBe("remove");
          expect(world.threads[1]?.worktreePath).toBe(worktreePath);
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(false);
        }),
      ),
    );
  });

  it("keeps worktrees with commits beyond the default branch unless they are idle", async () => {
    await Effect.runPromise(
      withWorktree(
        {
          storageCleanup: {
            enabled: true,
            worktree: { afterDays: 30, onMerge: false, onDelete: false, unchanged: true },
          },
        },
        ({ worker, world, worktreePath }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(worktreePath, "work.txt"), "w\n"));
            git(worktreePath, "add", ".");
            git(worktreePath, "commit", "-q", "-m", "work");
            expect((yield* worker.dryRun).targets).toEqual([]);

            world.threads[0] = thread({
              id: "thread-1",
              projectId: "project-1",
              worktreePath,
              branch: "feature",
              lastInteractionAt: new Date(Date.now() - 31 * DAY_MS).toISOString(),
            });
            const results = yield* worker.runOnce;
            expect(results[0]).toMatchObject({ action: "remove", reason: "idle for 31 days" });
            expect(yield* Effect.promise(() => exists(worktreePath))).toBe(false);
          }),
      ),
    );
  });

  it("follows a project override that turns cleanup off", async () => {
    const result = await Effect.runPromise(
      withWorktree(
        {
          ...unchangedRule,
          projectSettingsOverrides: {
            ["project-1" as ProjectId]: { worktreeCleanup: { mode: "off" as const } },
          },
        },
        ({ worker }) => worker.dryRun,
      ),
    );
    expect(result.targets).toEqual([]);
  });

  it("ignores worktrees outside this profile's worktrees directory", async () => {
    await Effect.runPromise(
      withWorktree(unchangedRule, ({ worker, world, root }) =>
        Effect.gen(function* () {
          const outside = path.join(path.dirname(root), "outside");
          git(root, "worktree", "add", "-q", "-b", "outside", outside, "main");
          world.threads.splice(0, world.threads.length, {
            ...world.threads[0]!,
            worktreePath: outside,
          });
          expect((yield* worker.runOnce).length).toBe(0);
          expect(yield* Effect.promise(() => exists(outside))).toBe(true);
        }),
      ),
    );
  });
});

describe("StorageCleanupWorker races (lifecycle lock)", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /**
   * Holds the worktree lock (as a queued send, a terminal open or a
   * recreation would) while a cleanup pass that already decided to remove the
   * worktree waits for it, applies `claim`, then releases the lock.
   */
  const raceCleanup = (claim: (input: { world: AutomationWorld; worktreePath: string }) => void) =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeClonedRepo("f5-cleanup-race-"));
      cleanups.push(repo.cleanup);
      const world = makeWorld();
      const layer = StorageCleanupWorkerLive.pipe(
        Layer.provideMerge(automationLayer(world, unchangedRule, "f5-cleanup-race-state-")),
      );
      return yield* Effect.gen(function* () {
        const config = yield* ServerConfig;
        const worktreePath = path.join(config.worktreesDir, "project", "feature");
        yield* Effect.promise(() => fs.mkdir(path.dirname(worktreePath), { recursive: true }));
        git(repo.root, "worktree", "add", "-q", "-b", "feature", worktreePath, "main");
        world.projects.push(project("project-1", repo.root));
        world.threads.push(
          thread({
            id: "thread-1",
            projectId: "project-1",
            worktreePath,
            branch: "feature",
            lastInteractionAt: idleSince(),
          }),
        );
        const worker = yield* StorageCleanupWorker;
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* withWorktreeLifecycleLock(
          worktreePath,
          Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const pass = yield* worker.runOnce.pipe(Effect.forkChild);
        // The pass reads the model once to evaluate and once more right before
        // it waits for the lock to remove.
        while (world.readModelReads < 2) yield* Effect.sleep("10 millis");
        claim({ world, worktreePath });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const results = yield* Fiber.join(pass);
        // Checked inside the scope: the temporary state directory goes with it.
        return { results, kept: yield* Effect.promise(() => exists(worktreePath)) };
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

  const expectKept = async (claim: Parameters<typeof raceCleanup>[0], reason: string) => {
    const { results, kept } = await Effect.runPromise(raceCleanup(claim));
    expect(results[0]).toMatchObject({ action: "skip" });
    expect(results[0]!.reason).toContain(reason);
    expect(kept).toBe(true);
  };

  it("keeps a worktree a queued send claimed while cleanup waited", async () => {
    await expectKept(({ world }) => world.queuedThreadIds.add("thread-1"), "queued turns");
  });

  it("keeps a worktree a terminal opened in while cleanup waited", async () => {
    await expectKept(
      ({ world, worktreePath }) =>
        world.terminals.push({
          threadId: "thread-1",
          terminalId: "default",
          cwd: worktreePath,
          status: "starting",
        }),
      "a terminal is open in it",
    );
  });

  it("allows a new idle linked conversation while preserving its recorded path", async () => {
    const { results, kept } = await Effect.runPromise(
      raceCleanup(({ world, worktreePath }) =>
        world.threads.push(
          thread({
            id: "thread-2",
            projectId: "project-1",
            worktreePath,
            branch: "feature",
            lastInteractionAt: idleSince(),
          }),
        ),
      ),
    );
    expect(results[0]).toMatchObject({ action: "remove" });
    expect(kept).toBe(false);
  });

  it("keeps a worktree whose thread became active while cleanup waited", async () => {
    // Activity without a claim: a read-only turn that already ended, a task update.
    await expectKept(({ world }) => {
      world.threads[0] = { ...world.threads[0]!, lastInteractionAt: new Date().toISOString() };
    }, "a thread using it was active within the last 24 hours");
  });

  it("keeps a worktree another thread used while cleanup waited", async () => {
    await expectKept(
      ({ world, worktreePath }) =>
        world.threads.push(
          thread({ id: "thread-2", projectId: "project-1", worktreePath, branch: "feature" }),
        ),
      "a thread using it was active within the last 24 hours",
    );
  });

  it("keeps a worktree whose HEAD moved (recreation or new work) while cleanup waited", async () => {
    await expectKept(({ worktreePath }) => {
      git(worktreePath, "commit", "-q", "--allow-empty", "-m", "new work");
    }, "HEAD moved since the check");
  });
});

describe("StorageCleanupWorker Codex marketplace staging", () => {
  const HOUR_MS = 60 * 60 * 1_000;
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  const makeDir = async (target: string, ageMs: number) => {
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "pack"), "x".repeat(2_000));
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(target, when, when);
  };

  it("sweeps old leftovers in every Codex home even while storage cleanup is off", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "f5-codex-sweep-")));
    dirs.push(dir);
    const work = path.join(dir, "work");
    const personal = path.join(dir, "personal");
    const workMarketplaces = path.join(work, ".tmp", "marketplaces");
    const personalMarketplaces = path.join(personal, ".tmp", "marketplaces");
    const oldClone = path.join(workMarketplaces, ".staging", "marketplace-upgrade-old");
    const freshClone = path.join(workMarketplaces, ".staging", "marketplace-upgrade-fresh");
    const oldBackup = path.join(personalMarketplaces, "marketplace-backup-old");
    const installed = path.join(personalMarketplaces, "example-marketplace");
    await makeDir(oldClone, 3 * HOUR_MS);
    await makeDir(freshClone, 30 * 60 * 1_000);
    await makeDir(oldBackup, 5 * HOUR_MS);
    await makeDir(installed, 5 * HOUR_MS);

    const settings = {
      providers: { codex: { homePath: work } },
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: personal } },
      },
    } as Parameters<typeof automationLayer>[1];
    const layer = StorageCleanupWorkerLive.pipe(
      Layer.provideMerge(automationLayer(makeWorld(), settings, "f5-codex-sweep-state-")),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* StorageCleanupWorker;
        const preview = yield* worker.dryRun;
        expect(preview.storageCleanupEnabled).toBe(false);
        expect(
          preview.targets.map((target) => [target.job, target.action, target.target]).toSorted(),
        ).toEqual(
          [
            ["codex-marketplace-staging", "remove", redactHomePath(workMarketplaces)],
            ["codex-marketplace-staging", "remove", redactHomePath(personalMarketplaces)],
          ].toSorted(),
        );
        expect(yield* Effect.promise(() => exists(oldClone))).toBe(true);

        yield* worker.runOnce;

        expect(yield* Effect.promise(() => exists(oldClone))).toBe(false);
        expect(yield* Effect.promise(() => exists(oldBackup))).toBe(false);
        expect(yield* Effect.promise(() => exists(freshClone))).toBe(true);
        expect(yield* Effect.promise(() => exists(installed))).toBe(true);
        const audit = yield* listStorageAutomationAudit(10);
        expect(audit.map((entry) => [entry.job, entry.result, entry.target]).toSorted()).toEqual(
          [
            ["codex-marketplace-staging", "removed", redactHomePath(oldClone)],
            ["codex-marketplace-staging", "removed", redactHomePath(oldBackup)],
          ].toSorted(),
        );
        expect(
          audit.every((entry) => /older than 2 hours; \d+ bytes$/.test(entry.reason ?? "")),
        ).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  it("purges deleted threads, prunes terminal logs and reclaims space even with cleanup off", async () => {
    const world = makeWorld();
    world.threads.push(
      thread({
        id: "thread-deleted",
        projectId: "project-1",
        worktreePath: null,
        deletedAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
      }),
    );
    world.purgeResult = {
      purgedThreadIds: ["thread-deleted" as ThreadId],
      archivedThreadIds: [],
      reclaimedBytes: 2_048,
      warnings: [],
    };
    world.spaceResult = { action: "incremental", reclaimedBytes: 8_192 };
    // An archive retention is ignored while automatic cleanup is off.
    const layer = StorageCleanupWorkerLive.pipe(
      Layer.provideMerge(
        automationLayer(
          world,
          { storageCleanup: { archivedThreadsPurgeAfterDays: 30 } },
          "f5-cleanup-maintenance-",
        ),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* StorageCleanupWorker;
        const preview = yield* worker.dryRun;
        expect(preview.targets).toContainEqual({
          job: "thread-purge",
          target: "deleted threads",
          projectId: null,
          threadId: null,
          action: "remove",
          reason: "1 thread(s) deleted more than 7 days ago",
        });

        yield* worker.runOnce;

        const calls = new Map(world.maintenanceCalls.map((entry) => [entry.method, entry.input]));
        const purge = calls.get("purgeThreads") as {
          readonly deletedBefore: string;
          readonly archivedBefore: string | null;
        };
        expect(purge.archivedBefore).toBeNull();
        expect(Math.abs(Date.parse(purge.deletedBefore) - (Date.now() - 7 * DAY_MS))).toBeLessThan(
          60_000,
        );
        const logs = calls.get("pruneTerminalThreadLogs") as {
          readonly modifiedBefore: string;
          readonly includeArchived: boolean;
        };
        expect(Math.abs(Date.parse(logs.modifiedBefore) - (Date.now() - 14 * DAY_MS))).toBeLessThan(
          60_000,
        );
        // Archived threads can be unarchived: their logs stay while cleanup is off.
        expect(logs.includeArchived).toBe(false);
        expect(calls.has("reclaimDatabaseSpace")).toBe(true);

        const audit = yield* listStorageAutomationAudit(10);
        expect(audit.map((entry) => [entry.job, entry.result, entry.target]).toSorted()).toEqual(
          [
            ["thread-purge", "removed", "thread-deleted"],
            ["database-vacuum", "removed", "state database"],
          ].toSorted(),
        );
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  it("purges archived threads only with cleanup on, and can turn purging off", async () => {
    const run = async (storageCleanup: Record<string, unknown>) => {
      const world = makeWorld();
      const layer = StorageCleanupWorkerLive.pipe(
        Layer.provideMerge(automationLayer(world, { storageCleanup }, "f5-cleanup-purge-")),
      );
      await Effect.runPromise(
        Effect.flatMap(StorageCleanupWorker.asEffect(), (worker) => worker.runOnce).pipe(
          Effect.provide(layer),
          Effect.scoped,
        ),
      );
      return world.maintenanceCalls.find((entry) => entry.method === "purgeThreads")?.input as
        | { readonly deletedBefore: string | null; readonly archivedBefore: string | null }
        | undefined;
    };

    const enabled = await run({ enabled: true, archivedThreadsPurgeAfterDays: 30 });
    expect(enabled?.archivedBefore).not.toBeNull();
    expect(enabled?.deletedBefore).not.toBeNull();
    expect(await run({ deletedThreadsPurgeAfterDays: null })).toBeUndefined();
  });

  it("cleans inactive worktrees hourly only when that cleanup is turned on", async () => {
    const run = async (storageCleanup: Record<string, unknown>) => {
      const world = makeWorld();
      const layer = StorageCleanupWorkerLive.pipe(
        Layer.provideMerge(automationLayer(world, { storageCleanup }, "f5-cleanup-worktrees-")),
      );
      return Effect.runPromise(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          world.inactiveWorktreeResults = [
            {
              categoryId: "inactiveF5Worktrees",
              status: "Cleaned",
              reclaimedBytes: 4_096,
              perTargetReclaimed: [
                {
                  id: "merged",
                  path: path.join(config.worktreesDir, "repo", "merged"),
                  reclaimedBytes: 4_096,
                  status: "Removed",
                  branch: "deleted",
                },
              ],
              warnings: [
                {
                  path: path.join(config.worktreesDir, "repo", "dirty"),
                  reason: "it has uncommitted changes (including untracked files)",
                },
              ],
            },
            {
              categoryId: "staleWorktreeRegistrations",
              status: "Cleaned",
              reclaimedBytes: 0,
              perTargetReclaimed: [
                {
                  id: "/tmp/gone",
                  path: "/tmp/gone",
                  reclaimedBytes: 0,
                  status: "Removed",
                },
              ],
              warnings: [],
            },
          ];
          const worker = yield* StorageCleanupWorker;
          yield* worker.runOnce;
          const audit = yield* listStorageAutomationAudit(10);
          return {
            called: world.maintenanceCalls.some(
              (entry) => entry.method === "cleanInactiveWorktreesAutomatically",
            ),
            audit: audit
              .filter((entry) => entry.job === "worktree-cleanup")
              .map((entry) => [entry.result, entry.target, entry.reason])
              .toSorted(),
          };
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    };

    const enabled = await run({ enabled: true, inactiveWorktrees: true });
    expect(enabled.called).toBe(true);
    expect(enabled.audit).toEqual(
      [
        [
          "removed",
          path.join("repo", "merged"),
          "inactive worktree; its merged branch was deleted",
        ],
        ["removed", "/tmp/gone", "the worktree folder was missing; its registration was pruned"],
        [
          "skipped",
          path.join("repo", "dirty"),
          "it has uncommitted changes (including untracked files)",
        ],
      ].toSorted(),
    );
    for (const storageCleanup of [{ enabled: true }, { enabled: false, inactiveWorktrees: true }]) {
      const off = await run(storageCleanup);
      expect(off.called).toBe(false);
      expect(off.audit).toEqual([]);
    }
  });

  it("previews hourly worktree cleanup only when it is turned on", async () => {
    const preview = async (storageCleanup: Record<string, unknown>) => {
      const world = makeWorld();
      const layer = StorageCleanupWorkerLive.pipe(
        Layer.provideMerge(automationLayer(world, { storageCleanup }, "f5-cleanup-preview-")),
      );
      return Effect.runPromise(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          world.inactiveWorktreePreviews = [
            {
              path: path.join(config.worktreesDir, "repo", "merged"),
              kind: "worktree",
              action: "remove",
              reason: "inactive worktree",
            },
            {
              path: path.join(config.worktreesDir, "repo", "dirty"),
              kind: "worktree",
              action: "skip",
              reason: "it has uncommitted changes (including untracked files)",
            },
          ];
          const result = yield* (yield* StorageCleanupWorker).dryRun;
          return result.targets
            .filter((target) => target.job === "worktree-cleanup")
            .map((target) => [target.action, target.target, target.reason]);
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    };

    expect(await preview({ enabled: true, inactiveWorktrees: true })).toEqual([
      ["remove", path.join("repo", "merged"), "inactive worktree"],
      [
        "skip",
        path.join("repo", "dirty"),
        "it has uncommitted changes (including untracked files)",
      ],
    ]);
    expect(await preview({ enabled: true })).toEqual([]);
  });

  it("labels paths under the user's home with ~", () => {
    expect(redactHomePath("/Users/me/.codex/.tmp", "/Users/me")).toBe(
      path.join("~", ".codex", ".tmp"),
    );
    expect(redactHomePath("/opt/codex", "/Users/me")).toBe("/opt/codex");
  });
});

async function exists(target: string) {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}
