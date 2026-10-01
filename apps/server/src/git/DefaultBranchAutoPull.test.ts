import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { repositoryLockPath } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { acquireInstanceLock } from "../profiles/InstanceLock.ts";
import { listStorageAutomationAudit } from "../storage/automationAudit.ts";
import {
  automationLayer,
  git,
  makeClonedRepo,
  makeWorld,
  project,
  pushUpstreamCommit,
  thread,
  type AutomationWorld,
} from "../storage/storageAutomation.testHarness.ts";
import { DefaultBranchAutoPull, DefaultBranchAutoPullLive } from "./DefaultBranchAutoPull.ts";

// Real repositories and many git calls per case: allow for loaded CI runners.
describe("DefaultBranchAutoPull", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const withRepo = <A, E>(
    settings: Parameters<typeof automationLayer>[1],
    body: (input: {
      world: AutomationWorld;
      repo: Awaited<ReturnType<typeof makeClonedRepo>>;
      upstreamSha: string;
      baseDir: string;
      autoPull: typeof DefaultBranchAutoPull.Service;
    }) => Effect.Effect<A, E, SqlClient.SqlClient>,
  ) =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeClonedRepo("f5-autopull-"));
      cleanups.push(repo.cleanup);
      const upstreamSha = yield* Effect.promise(() =>
        pushUpstreamCommit(repo.dir, repo.origin, "upstream"),
      );
      git(repo.root, "fetch", "-q");
      const world = makeWorld();
      world.projects.push(project("project-1", repo.root));
      const layer = DefaultBranchAutoPullLive.pipe(
        Layer.provideMerge(automationLayer(world, settings, "f5-autopull-state-")),
      );
      return yield* Effect.gen(function* () {
        const { baseDir } = yield* ServerConfig;
        const autoPull = yield* DefaultBranchAutoPull;
        return yield* body({ world, repo, upstreamSha, baseDir, autoPull });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

  it("does nothing while auto-pull is off", async () => {
    await Effect.runPromise(
      withRepo({}, ({ autoPull, repo, upstreamSha }) =>
        Effect.gen(function* () {
          expect(yield* autoPull.dryRun).toEqual([]);
          expect(yield* autoPull.runOnce).toEqual([]);
          expect(git(repo.root, "rev-parse", "HEAD")).not.toBe(upstreamSha);
        }),
      ),
    );
  });

  it("fast-forwards a clean default branch and audits the pull", async () => {
    await Effect.runPromise(
      withRepo({ autoPullDefaultBranch: true }, ({ autoPull, repo, upstreamSha }) =>
        Effect.gen(function* () {
          const before = git(repo.root, "rev-parse", "HEAD");
          expect(yield* autoPull.dryRun).toEqual([
            {
              job: "auto-pull",
              target: "Project project-1",
              projectId: "project-1",
              threadId: null,
              action: "pull",
              reason: "1 commit(s) behind as of the last fetch",
            },
          ]);
          expect(git(repo.root, "rev-parse", "HEAD")).toBe(before);

          const results = yield* autoPull.runOnce;
          expect(results[0]).toMatchObject({ action: "pull", reason: "fast-forwarded main" });
          expect(git(repo.root, "rev-parse", "HEAD")).toBe(upstreamSha);
          const audit = yield* listStorageAutomationAudit(10);
          expect(audit[0]).toMatchObject({
            job: "auto-pull",
            result: "pulled",
            beforeRef: before,
            afterRef: upstreamSha,
          });
        }),
      ),
    );
  });

  it("skips dirty, diverged, in-progress and non-default checkouts", async () => {
    await Effect.runPromise(
      withRepo({ autoPullDefaultBranch: true }, ({ autoPull, repo, world }) =>
        Effect.gen(function* () {
          const reason = () => autoPull.dryRun.pipe(Effect.map((targets) => targets[0]!.reason));

          yield* Effect.promise(() => fs.writeFile(path.join(repo.root, "scratch.txt"), "x\n"));
          expect(yield* reason()).toBe("the checkout has uncommitted or untracked files");
          yield* Effect.promise(() => fs.rm(path.join(repo.root, "scratch.txt")));

          git(repo.root, "checkout", "-q", "-b", "topic");
          expect(yield* reason()).toBe("topic is checked out, not main");
          git(repo.root, "checkout", "-q", "main");

          git(repo.root, "commit", "-q", "--allow-empty", "-m", "local");
          expect(yield* reason()).toBe("the branch has commits its upstream lacks");
          git(repo.root, "reset", "-q", "--hard", "HEAD~1");

          const mergeHead = git(repo.root, "rev-parse", "HEAD");
          const gitDir = git(repo.root, "rev-parse", "--absolute-git-dir");
          yield* Effect.promise(() => fs.writeFile(path.join(gitDir, "MERGE_HEAD"), mergeHead));
          expect(yield* reason()).toBe("a merge is in progress");
          yield* Effect.promise(() => fs.rm(path.join(gitDir, "MERGE_HEAD")));

          world.sessions.push({ threadId: "thread-1", cwd: repo.root, status: "ready" });
          expect(yield* reason()).toBe("an agent session is open in the project root");
          world.sessions.length = 0;

          // A turn accepted in the root has no provider session yet, but still blocks.
          world.threads.push(
            thread({ id: "thread-root", projectId: "project-1", worktreePath: null }),
          );
          world.pendingTurnStarts.add("thread-root");
          expect(yield* reason()).toBe("an agent turn is starting or running in the project root");
          world.pendingTurnStarts.clear();
          world.threads[0] = {
            ...world.threads[0]!,
            session: { status: "running", activeTurnId: "turn-1" },
          } as (typeof world.threads)[number];
          expect(yield* reason()).toBe("an agent turn is starting or running in the project root");
          world.threads.length = 0;

          const results = yield* autoPull.runOnce;
          expect(results[0]!.action).toBe("pull");
        }),
      ),
    );
  });

  it("skips the cycle while another profile holds the repository lock", async () => {
    await Effect.runPromise(
      withRepo({ autoPullDefaultBranch: true }, ({ autoPull, repo, upstreamSha, baseDir }) =>
        Effect.gen(function* () {
          const commonDir = yield* Effect.promise(() =>
            fs.realpath(git(repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir")),
          );
          const otherProfile = yield* Effect.promise(() =>
            acquireInstanceLock(repositoryLockPath(baseDir, commonDir)),
          );
          const before = git(repo.root, "rev-parse", "HEAD");
          const busy = yield* autoPull.runOnce.pipe(
            Effect.ensuring(Effect.sync(() => otherProfile.release())),
          );
          expect(busy[0]).toMatchObject({ action: "skip" });
          expect(busy[0]!.reason).toMatch(/another F5 profile/i);
          expect(git(repo.root, "rev-parse", "HEAD")).toBe(before);
          expect((yield* listStorageAutomationAudit(10))[0]).toMatchObject({
            result: "skipped",
          });

          const pulled = yield* autoPull.runOnce;
          expect(pulled[0]!.action).toBe("pull");
          expect(git(repo.root, "rev-parse", "HEAD")).toBe(upstreamSha);
        }),
      ),
    );
  });

  it("serializes overlapping passes over one repository", async () => {
    await Effect.runPromise(
      withRepo({ autoPullDefaultBranch: true }, ({ autoPull, repo, upstreamSha }) =>
        Effect.gen(function* () {
          const [first, second] = yield* Effect.all([autoPull.runOnce, autoPull.runOnce], {
            concurrency: 2,
          });
          const reasons = [...first, ...second].map((entry) => entry.reason);
          expect(reasons).toContain("fast-forwarded main");
          expect(git(repo.root, "rev-parse", "HEAD")).toBe(upstreamSha);
        }),
      ),
    );
  });
});
