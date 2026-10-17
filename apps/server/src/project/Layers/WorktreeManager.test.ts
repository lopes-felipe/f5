import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import {
  automationLayer,
  makeWorld,
  makeClonedRepo,
  git,
  project,
  thread,
} from "../../storage/storageAutomation.testHarness.ts";
import { WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { makeWorktreeManager } from "./WorktreeManager.ts";

describe("WorktreeManager safety and recovery", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  async function fixture() {
    const repo = await makeClonedRepo("f5-manager-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    world.projects.push(project("p", repo.root));
    const projectId = ProjectId.makeUnsafe("p");
    const notified: string[] = [];
    const run = <A, E>(
      effect: (
        manager: Effect.Success<typeof makeWorktreeManager>,
        root: string,
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* makeWorktreeManager;
          const config = yield* ServerConfig;
          return yield* effect(manager, config.worktreesDir);
        }).pipe(
          Effect.provide(WorktreeSetupGateLive),
          Effect.provideService(NextTurnQueueDispatcher, {
            notify: (id: string) =>
              Effect.sync(() => {
                notified.push(id);
              }),
          } as never),
          Effect.provide(automationLayer(world, {}, "f5-manager-state-")),
          Effect.scoped,
        ),
      );
    return { repo, world, projectId, run, notified };
  }
  it("rechecks HEAD and claims, then deletes only an unreferenced merged branch", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "feature");
        git(repo.root, "worktree", "add", "-q", "-b", "feature", target, "main");
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.branchMerged).toBe(true);
        expect(preview.branchDeletable).toBe(true);
        expect(
          (yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: "wrong",
          })).removed,
        ).toBe(false);
        world.threads.push(
          thread({ id: "linked", projectId, worktreePath: target, branch: "feature" }),
        );
        world.queuedThreadIds.add("linked");
        expect(
          (yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: preview.headSha,
          })).removed,
        ).toBe(false);
        world.queuedThreadIds.clear();
        const kept = yield* manager.remove({
          projectId,
          path: target,
          deleteBranch: true,
          expectedHead: preview.headSha,
        });
        expect(kept.removed).toBe(true);
        expect(kept.branchDeleted).toBe(false);
        expect(world.threads[0]?.worktreePath).toBe(target);
        git(repo.root, "worktree", "add", "-q", "-b", "unlinked", target, "main");
        world.threads.length = 0;
        const fresh = yield* manager.inspect({ projectId, path: target });
        expect(
          yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: fresh.headSha,
          }),
        ).toEqual({ removed: true, branchDeleted: true, blockedReasons: [] });
      }),
    );
  });
  it("stops deleted owners and permits an unreferenced branch whose upstream is gone", async () => {
    const { repo, world, projectId, run } = await fixture();
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "upstream-gone");
        git(repo.root, "worktree", "add", "-q", "-b", "upstream-gone", target, "main");
        git(target, "commit", "--allow-empty", "-qm", "unique commit");
        git(target, "config", "branch.upstream-gone.remote", "origin");
        git(target, "config", "branch.upstream-gone.merge", "refs/heads/deleted-upstream");
        world.threads.push(
          thread({
            id: "deleted",
            projectId,
            worktreePath: null,
            deletedAt: new Date().toISOString(),
          }),
        );
        world.sessions.push({ threadId: "deleted", cwd: target, status: "ready" });
        world.terminals.push({
          threadId: "deleted",
          terminalId: "shell",
          cwd: target,
          status: "running",
        });
        const preview = yield* manager.inspect({ projectId, path: target });
        expect(preview.branchMerged).toBe(false);
        expect(preview.branchUpstreamGone).toBe(true);
        expect(preview.branchDeletable).toBe(true);
        expect(preview.deletedThreadClaims).toContain("deleted");
        expect(
          yield* manager.remove({
            projectId,
            path: target,
            deleteBranch: true,
            expectedHead: preview.headSha,
          }),
        ).toEqual({ removed: true, branchDeleted: true, blockedReasons: [] });
        expect(world.sessions).toEqual([]);
        expect(world.terminals).toEqual([]);
      }),
    );
  });
  it("recreates stale registrations and resumes only a missing-worktree pause", async () => {
    const { repo, world, run, notified } = await fixture();
    const threadId = ThreadId.makeUnsafe("recover");
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "missing");
        git(repo.root, "worktree", "add", "-q", "-b", "recovery", target, "main");
        yield* Effect.promise(() => fs.rm(target, { recursive: true }));
        world.threads.push(
          thread({ id: threadId, projectId: "p", worktreePath: target, branch: "recovery" }),
        );
        world.queueStates.set(threadId, {
          revision: 1,
          paused: true,
          pauseReasonCode: "worktree_missing",
          worktreeBlockToken: null,
        });
        expect((yield* manager.threadState({ threadId })).registration).toBe("stale");
        expect(
          (yield* manager.recover({ threadId, action: "recreate", expectedQueueRevision: 1 }))
            .directoryExists,
        ).toBe(true);
        expect(world.queueStates.get(threadId)?.paused).toBe(false);
        yield* Effect.promise(() => fs.rm(target, { recursive: true }));
        world.queueStates.set(threadId, {
          revision: 10,
          paused: true,
          pauseReasonCode: "manual_pause",
          worktreeBlockToken: null,
        });
        const recovered = yield* manager.recover({
          threadId,
          action: "recreateFromBase",
          expectedQueueRevision: 10,
        });
        expect(recovered.directoryExists).toBe(true);
        expect(recovered.registration).toBe("matching");
        expect(recovered.branch).not.toBe("recovery");
        expect(world.queueStates.get(threadId)?.pauseReasonCode).toBe("manual_pause");
        expect(notified).toEqual([threadId, threadId]);
      }),
    );
  });
  it("rejects pending turns and stale revisions before changing workspace", async () => {
    const { repo, world, run } = await fixture();
    const threadId = ThreadId.makeUnsafe("blocked");
    await run((manager, root) =>
      Effect.gen(function* () {
        const target = path.join(root, "absent");
        world.threads.push(thread({ id: threadId, projectId: "p", worktreePath: target }));
        world.pendingTurnStarts.add(threadId);
        expect(
          (yield* manager
            .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 0 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        world.pendingTurnStarts.clear();
        expect(
          (yield* manager
            .recover({ threadId, action: "useProjectCheckout", expectedQueueRevision: 9 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(world.threads[0]?.worktreePath).toBe(target);
        world.sessions.push({ threadId, cwd: target, status: "ready" });
        expect(
          (yield* manager.recover({
            threadId,
            action: "useProjectCheckout",
            expectedQueueRevision: 0,
          })).worktreePath,
        ).toBe(null);
        expect(world.sessions).toEqual([]);
        expect(git(repo.root, "branch", "--show-current")).toBe("main");
      }),
    );
  });
});
