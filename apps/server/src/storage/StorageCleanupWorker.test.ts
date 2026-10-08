import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { withWorktreeLifecycleLock } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import {
  blockingIgnoredEntries,
  matchWorktreeCleanupRule,
  redactHomePath,
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

const DAY_MS = 24 * 60 * 60 * 1_000;
const unchangedRule = {
  storageCleanup: {
    enabled: true,
    worktree: { afterDays: null, onMerge: false, onDelete: false, unchanged: true },
  },
};

describe("worktree cleanup rules", () => {
  const rules = { afterDays: 7, onMerge: true, onDelete: true, unchanged: false };
  const base = {
    rules,
    deleted: false,
    lastInteractionAt: new Date(0).toISOString(),
    nowMs: 3 * DAY_MS,
    headInDefaultBranch: false,
    pullRequestMerged: false,
  };

  it("matches idle age, deletion, merges and unchanged branches", () => {
    expect(matchWorktreeCleanupRule(base)).toBeNull();
    expect(matchWorktreeCleanupRule({ ...base, nowMs: 8 * DAY_MS })).toBe("idle for 8 days");
    expect(matchWorktreeCleanupRule({ ...base, deleted: true })).toBe("the thread was deleted");
    // A merged PR whose head is not in the default branch is not eligible.
    expect(matchWorktreeCleanupRule({ ...base, pullRequestMerged: true })).toBeNull();
    expect(
      matchWorktreeCleanupRule({ ...base, pullRequestMerged: true, headInDefaultBranch: true }),
    ).toBe("the pull request was merged");
    expect(
      matchWorktreeCleanupRule({
        ...base,
        rules: { ...rules, unchanged: true },
        headInDefaultBranch: true,
      }),
    ).toBe("no commits beyond the default branch");
    expect(
      matchWorktreeCleanupRule({ ...base, rules: { ...rules, onDelete: false }, deleted: true }),
    ).toBeNull();
  });

  it("treats only node_modules as reproducible ignored content", () => {
    expect(
      blockingIgnoredEntries(["node_modules/", "packages/web/node_modules/", ".env", "dist/"]),
    ).toEqual([".env", "dist/"]);
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
          thread({ id: "thread-1", projectId: "project-1", worktreePath, branch: "feature" }),
        );
        const worker = yield* StorageCleanupWorker;
        return yield* body({ world, root: repo.root, worktreePath, worker });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

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
            policyVersion: 1,
          });
          expect(audit[0]!.target).not.toContain(worktreePath);
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
          expect(ignored[0]!.reason).toContain("ignored files other than node_modules/ (.env)");

          yield* Effect.promise(() => fs.rm(path.join(worktreePath, ".env")));
          yield* Effect.promise(() => fs.writeFile(path.join(worktreePath, "new.txt"), "x\n"));
          const untracked = yield* worker.dryRun;
          expect(untracked.targets[0]!.reason).toContain("it has uncommitted changes");
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
            thread({ id: "thread-2", projectId: "project-1", worktreePath, branch: "feature" }),
          );
          const shared = yield* worker.runOnce;
          expect(shared.every((entry) => entry.action === "skip")).toBe(true);
          expect(shared[0]!.reason).toContain("used by 1 other thread(s)");
          expect(yield* Effect.promise(() => exists(worktreePath))).toBe(true);
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
          thread({ id: "thread-1", projectId: "project-1", worktreePath, branch: "feature" }),
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

  it("keeps a worktree a second thread started sharing while cleanup waited", async () => {
    await expectKept(
      ({ world, worktreePath }) =>
        world.threads.push(
          thread({ id: "thread-2", projectId: "project-1", worktreePath, branch: "feature" }),
        ),
      "used by 1 other thread(s)",
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
        const logs = calls.get("pruneTerminalThreadLogs") as { readonly modifiedBefore: string };
        expect(Math.abs(Date.parse(logs.modifiedBefore) - (Date.now() - 14 * DAY_MS))).toBeLessThan(
          60_000,
        );
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
