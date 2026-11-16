import * as path from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, expect, it } from "vitest";
import { ServerConfig } from "../config.ts";
import { GitCommandError } from "../git/Errors.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import {
  automationLayer,
  git,
  makeClonedRepo,
  makeWorld,
  project,
} from "../storage/storageAutomation.testHarness.ts";
import { withRepositoryLifecycleLock } from "./Layers/WorktreeLifecycleCoordinator.ts";
import {
  assertWorktreeReady,
  readWorktreeState,
  WorktreeInspectionError,
  WorktreeNotReadyError,
} from "./worktreeReadiness.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it("checks identity without status scans and verifies existing worktrees while the repository lock is busy", async () => {
  const repo = await makeClonedRepo("f5-readiness-");
  cleanups.push(repo.cleanup);
  const world = makeWorld();
  world.projects.push(project("p", repo.root));
  await Effect.runPromise(
    Effect.gen(function* () {
      const core = yield* GitCore;
      const config = yield* ServerConfig;
      const target = path.join(config.worktreesDir, "ready");
      git(repo.root, "worktree", "add", "-q", "-b", "ready", target, "main");
      const input = { projectCwd: repo.root, worktreePath: target, branch: "ready" };
      const unexpected = () =>
        Effect.die(new Error("Readiness must not scan status or resolve the default branch"));
      yield* assertWorktreeReady(
        { ...core, inspectCheckout: unexpected, readDefaultBranch: unexpected },
        input,
      );
      const acquired = yield* Deferred.make<void>();
      const held = yield* withRepositoryLifecycleLock(
        config.baseDir,
        yield* core.resolveCommonDir(repo.root),
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      expect(
        yield* core
          .ensureWorktree({ cwd: repo.root, path: target, branch: "ready" })
          .pipe(Effect.timeout("3 seconds")),
      ).toEqual({ recreated: false });
      yield* Fiber.interrupt(held);
      const error = new GitCommandError({
        cwd: target,
        operation: "identity",
        command: "rev-parse",
        detail: "timed out",
      });
      const failed = yield* assertWorktreeReady(
        { ...core, inspectCheckoutIdentity: () => Effect.fail(error) },
        input,
      ).pipe(Effect.flip);
      expect(failed).toBeInstanceOf(WorktreeInspectionError);
      expect(failed.message).toContain("retry");
      expect(yield* readWorktreeState(core, input, false)).toMatchObject({
        checkoutBranch: "ready",
        branchDriftOnly: false,
      });
      git(target, "checkout", "-q", "-b", "agent-branch");
      expect(yield* assertWorktreeReady(core, input).pipe(Effect.flip)).toBeInstanceOf(
        WorktreeNotReadyError,
      );
      expect(yield* readWorktreeState(core, input, false)).toMatchObject({
        registration: "otherBranch",
        checkoutBranch: "agent-branch",
        branchDriftOnly: true,
      });
      // Steers into the live turn tolerate drift; new turns do not.
      expect(yield* assertWorktreeReady(core, input, false, { allowBranchDrift: true })).toEqual({
        branchDrift: true,
      });
      git(target, "checkout", "-q", "--detach");
      expect(yield* assertWorktreeReady(core, input).pipe(Effect.flip)).toBeInstanceOf(
        WorktreeNotReadyError,
      );
      expect(yield* readWorktreeState(core, input, false)).toMatchObject({
        checkoutBranch: null,
        branchDriftOnly: true,
      });
      // A foreign repository at the recorded path is never treated as drift.
      expect(
        yield* readWorktreeState(
          { ...core, resolveCommonDir: () => Effect.succeed("/elsewhere/.git") },
          input,
          false,
        ),
      ).toMatchObject({ branchDriftOnly: false });
      const missing = { ...input, worktreePath: path.join(config.worktreesDir, "missing") };
      expect(yield* readWorktreeState(core, missing, false)).toMatchObject({
        directoryExists: false,
        branchDriftOnly: false,
      });
      expect(
        yield* assertWorktreeReady(core, missing, false, { allowBranchDrift: true }).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(WorktreeNotReadyError);
    }).pipe(Effect.provide(automationLayer(world, {}, "f5-readiness-state-")), Effect.scoped),
  );
});
