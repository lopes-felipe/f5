import fsPromises from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { profileRegistryPath, profileStateDir } from "@t3tools/shared/profilePaths";
import { ProfileId } from "@t3tools/contracts";
import { WorkspaceWriteContext } from "../workspaceTransitionContext.ts";
import { WorktreePreparations } from "../../persistence/Services/WorktreePreparations.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { WorktreeSetupLive } from "./WorktreeSetup.ts";
import { WorktreeSetup } from "../Services/WorktreeSetup.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { makeFakeTextGeneration } from "../../git/testDoubles.ts";
import { PreparationError } from "../../persistence/Services/WorktreePreparations.ts";
import { makeWorktreeManager } from "./WorktreeManager.ts";
import { ProfileRegistryStore } from "../../profiles/ProfileRegistryStore.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Deferred, Fiber } from "effect";
import {
  automationLayer,
  makeClonedRepo,
  makeWorld,
  git,
} from "../../storage/storageAutomation.testHarness.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { makeWorkspaceTransitions } from "../../persistence/Layers/WorkspaceTransitions.ts";
import {
  WorkspaceTransitions,
  WorkspaceTransitionError,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import { NextTurnQueueStoreLive } from "../../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { makeWorkspaceTransition, WorkspaceTransitionLive } from "./WorkspaceTransition.ts";
import {
  holdsWorktreeLifecycleLock,
  withWorktreeLifecycleLock,
} from "./WorktreeLifecycleCoordinator.ts";

// Use the existing real-Git automation fixture and the real engine/SQL transaction pipeline.
describe("workspace transition execution", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture() {
    const repo = await makeClonedRepo("f5-transition-");
    cleanups.push(repo.cleanup);
    const world = makeWorld();
    const base = automationLayer(world, {}, "f5-transition-state-");
    const failPhase: { current: string | null } = { current: null };
    const preparationControl = { fail: false, block: false };
    const preparationEntered = Deferred.makeUnsafe<void>();
    const stoppingEntered = Deferred.makeUnsafe<void>();
    const mutationEntered = Deferred.makeUnsafe<void>();
    const mutationControl = { fail: false, block: false, raceBranch: false };
    const discardControl: { failure: "unchanged" | "after_stash" | null } = { failure: null };
    const cleanupControl = { fail: false };
    const copyControl = { fail: false, unexpected: false, block: false };
    const copyEntered = Deferred.makeUnsafe<void>();
    const copyRelease = Deferred.makeUnsafe<void>();
    const gitLayer = Layer.effect(
      GitCore,
      Effect.gen(function* () {
        const gitCore = yield* GitCore;
        const beforeMutation = Effect.suspend(() =>
          Deferred.succeed(mutationEntered, undefined).pipe(
            Effect.andThen(
              mutationControl.block
                ? Effect.never
                : mutationControl.fail
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "test-worktree-add",
                        cwd: repo.root,
                        command: "git worktree add",
                        detail: "Git add failed before creating a checkout",
                      }),
                    )
                  : Effect.void,
            ),
          ),
        );
        return {
          ...gitCore,
          stashPushAll: (cwd: string, message: string) =>
            Effect.gen(function* () {
              if (discardControl.failure === "unchanged")
                return yield* Effect.fail(new Error("stash push failed"));
              yield* gitCore.stashPushAll(cwd, message);
              if (discardControl.failure === "after_stash")
                return yield* Effect.fail(new Error("stash push failed after saving"));
            }),
          cleanMoveCopies: (cwd: string, snapshot: Parameters<typeof gitCore.cleanMoveCopies>[1]) =>
            cleanupControl.fail
              ? Effect.fail(new Error("rollback unavailable"))
              : gitCore.cleanMoveCopies(cwd, snapshot),
          copyMoveUntracked: (
            source: string,
            target: string,
            files: Parameters<typeof gitCore.copyMoveUntracked>[2],
          ) =>
            Effect.gen(function* () {
              if (copyControl.fail) {
                yield* gitCore.copyMoveUntracked(source, target, files.slice(0, 1));
                if (copyControl.unexpected)
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(target, ".env"), "generated secret"),
                  );
                return yield* Effect.fail(new Error("copy failed"));
              }
              yield* gitCore.copyMoveUntracked(source, target, files);
              yield* Deferred.succeed(copyEntered, undefined);
              if (copyControl.block) yield* Deferred.await(copyRelease);
            }),
          ensureWorktree: (input: Parameters<typeof gitCore.ensureWorktree>[0]) =>
            beforeMutation.pipe(Effect.andThen(gitCore.ensureWorktree(input))),
          createWorktree: (input: Parameters<typeof gitCore.createWorktree>[0]) =>
            beforeMutation.pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (mutationControl.raceBranch && input.newBranch)
                    yield* Effect.promise(() =>
                      Promise.resolve(git(repo.root, "branch", input.newBranch!, input.branch)),
                    );
                  return yield* gitCore.createWorktree(input);
                }),
              ),
            ),
        };
      }),
    ).pipe(Layer.provide(base));
    const storeLayer = Layer.effect(
      WorkspaceTransitions,
      makeWorkspaceTransitions.pipe(
        Effect.map((store) => ({
          ...store,
          update: (
            record: Parameters<typeof store.update>[0],
            patch: Parameters<typeof store.update>[1],
          ) =>
            store.update(record, patch).pipe(
              Effect.tap((next) =>
                next.phase === "stopping"
                  ? Deferred.succeed(stoppingEntered, undefined)
                  : Effect.void,
              ),
              Effect.tap((next) =>
                failPhase.current === next.phase
                  ? Effect.fail(new WorkspaceTransitionError(`crash after ${next.phase}`))
                  : Effect.void,
              ),
            ),
        })),
      ),
    );
    const engineLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(NextTurnQueueStoreLive),
    );
    const preparations: string[] = [];
    const transitionLayer = WorkspaceTransitionLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(WorktreeSetupGateLive),
      Layer.provideMerge(
        Layer.effect(
          WorktreePreparation,
          Effect.gen(function* () {
            const receipts = yield* WorktreePreparations;
            return {
              startup: Effect.void,
              needsPreparation: () => Effect.succeed(false),
              startBackground: () => Effect.void,
              prepare: ({ worktreePath }) =>
                Effect.gen(function* () {
                  expect(yield* holdsWorktreeLifecycleLock(worktreePath).pipe(Effect.orDie)).toBe(
                    false,
                  );
                  preparations.push(worktreePath);
                  yield* Deferred.succeed(preparationEntered, undefined);
                  if (preparationControl.fail)
                    return yield* new PreparationError({
                      message: "setup interrupted",
                      path: worktreePath,
                    });
                  if (preparationControl.block) return yield* Effect.never;
                  const receipt = yield* receipts.latest(
                    yield* Effect.promise(() => fs.realpath(worktreePath)),
                  );
                  if (receipt) yield* receipts.update(receipt, { phase: "completed" });
                }),
            };
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(NextTurnQueueDispatcher, { notify: () => Effect.void } as never),
      ),
      Layer.provideMerge(gitLayer),
      Layer.provideMerge(base),
    );
    const layer = WorktreeSetupLive.pipe(
      Layer.provideMerge(Layer.succeed(TextGeneration, makeFakeTextGeneration())),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(transitionLayer),
    );
    const runtime = ManagedRuntime.make(layer);
    cleanups.push(() => runtime.dispose());
    const services = await runtime.runPromise(
      Effect.gen(function* () {
        return {
          transition: yield* WorkspaceTransition,
          setupService: yield* WorktreeSetup,
          engine: yield* OrchestrationEngineService,
          store: yield* WorkspaceTransitions,
          queue: yield* NextTurnQueueStore,
          config: yield* ServerConfig,
        };
      }),
    );
    if (services.config.defaultStateDir)
      await new ProfileRegistryStore(services.config.defaultStateDir).init();
    const threadId = ThreadId.makeUnsafe("thread"),
      projectId = ProjectId.makeUnsafe("project"),
      at = new Date().toISOString();
    await runtime.runPromise(
      services.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("project"),
        projectId,
        title: "Project",
        workspaceRoot: repo.root,
        defaultModel: "gpt-5-codex",
        createdAt: at,
      }),
    );
    const create = (id = threadId, branch = "main", worktreePath: string | null = null) =>
      runtime.runPromise(
        services.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create:${id}`),
          threadId: id,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch,
          worktreePath,
          createdAt: at,
        }),
      );
    await create();
    const request = async (
      intent: import("@t3tools/contracts").WorktreesSwitchWorkspaceInput["intent"],
      extra: Partial<import("@t3tools/contracts").WorktreesSwitchWorkspaceInput> = {},
    ) => {
      const thread = (await runtime.runPromise(services.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      return {
        operationId: crypto.randomUUID(),
        threadId,
        intent,
        expected: {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          sessionUpdatedAt: thread.session?.updatedAt ?? null,
        },
        ...extra,
      };
    };
    return {
      ...services,
      runtime,
      repo,
      world,
      threadId,
      projectId,
      create,
      request,
      preparations,
      failPhase,
      preparationControl,
      preparationEntered,
      stoppingEntered,
      mutationControl,
      mutationEntered,
      discardControl,
      cleanupControl,
      copyControl,
      copyEntered,
      copyRelease,
      manager: await runtime.runPromise(makeWorktreeManager),
    };
  }
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
  it.each(["reserved", "snapshot", "ref", "checkout", "copy", "applied", "committed"])(
    "reconciles an interrupted move after %s",
    async (step) => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo.root, "README.md"), "snapshot tracked\n");
      await fs.writeFile(path.join(f.repo.root, "loose"), "snapshot loose");
      const before = git(f.repo.root, "status", "--porcelain=v2", "-z");
      const request = await f.request("move_to_new_worktree", { branch: "restart-move" });
      const gitCore = await f.runtime.runPromise(Effect.service(GitCore));
      const source = await f.runtime.runPromise(gitCore.inspectCheckout(f.repo.root));
      const snapshot = await f.runtime.runPromise(gitCore.readMoveSnapshot(f.repo.root));
      const targetPath = await canonicalWorktreePath(
        await f.runtime.runPromise(
          gitCore.allocateWorktreePath({ cwd: f.repo.root, branch: "restart-move" }),
        ),
      );
      const at = new Date().toISOString();
      let record = await f.runtime.runPromise(
        f.store.reserve({
          operationId: request.operationId,
          threadId: f.threadId,
          version: 0,
          intent: request.intent,
          phase: "reserved",
          request,
          requestHash: "restart-fixture",
          source: {
            path: source.canonicalRoot,
            repository: source.commonDir,
            branch: source.branch,
            headSha: source.headSha,
          },
          target: {
            path: targetPath,
            repository: source.commonDir,
            branch: "restart-move",
            headSha: source.headSha,
          },
          observed: null,
          fingerprint: null,
          mutationAttempted: false,
          commandId: `workspace:${request.operationId}`,
          setupOwnerToken: null,
          result: null,
          error: null,
          createdAt: at,
          updatedAt: at,
        }),
      );
      if (step !== "reserved") {
        record = await f.runtime.runPromise(
          f.store.update(record, {
            phase: "applying",
            moveData: {
              snapshot,
              snapshotRef: `refs/f5/moves/${record.operationId}`,
              createdBranch: false,
              createdWorktree: false,
              copyStarted: false,
              discarded: false,
              discardStarted: false,
            },
            move: { copiedFileCount: snapshot.copiedFileCount, discarded: false },
          }),
        );
        if (step !== "snapshot")
          await f.runtime.runPromise(
            gitCore.setMoveRef(
              f.repo.root,
              record.moveData!.snapshotRef!,
              snapshot.trackedStashSha!,
            ),
          );
        if (["checkout", "copy", "applied", "committed"].includes(step)) {
          record = await f.runtime.runPromise(f.store.update(record, { mutationAttempted: true }));
          await f.runtime.runPromise(
            gitCore.createWorktree({
              cwd: f.repo.root,
              path: targetPath,
              branch: snapshot.baseSha,
              newBranch: "restart-move",
              submodules: "none",
              preparation: {
                owner: `thread:${f.threadId}`,
                operationId: `move:${record.operationId}`,
                runSetupScript: true,
              },
            }),
          );
          if (step !== "checkout") {
            await f.runtime.runPromise(
              gitCore.stashApplySha(targetPath, snapshot.trackedStashSha!),
            );
            await f.runtime.runPromise(
              gitCore.copyMoveUntracked(f.repo.root, targetPath, snapshot.untracked),
            );
          }
          if (["applied", "committed"].includes(step))
            record = await f.runtime.runPromise(
              f.store.update(record, { phase: "applied", observed: record.target }),
            );
          if (step === "committed") {
            record = await f.runtime.runPromise(
              f.store.update(record, {
                result: {
                  branch: "restart-move",
                  worktreePath: targetPath,
                  sessionUpdatedAt: null,
                },
              }),
            );
            await f.runtime.runPromise(
              f.engine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.makeUnsafe(record.commandId),
                  threadId: f.threadId,
                  branch: "restart-move",
                  worktreePath: targetPath,
                })
                .pipe(
                  Effect.provideService(WorkspaceWriteContext, {
                    expected: request.expected,
                    operationId: record.operationId,
                    version: record.version,
                  }),
                ),
            );
          }
        }
      }
      await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
      const recovered = (await f.runtime.runPromise(f.store.get(record.operationId)))!;
      expect(recovered.phase).toBe(step === "committed" ? "completed" : "failed");
      expect(git(f.repo.root, "status", "--porcelain=v2", "-z")).toBe(before);
      expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
      expect(
        await fs
          .stat(targetPath)
          .then(() => true)
          .catch(() => false),
      ).toBe(step === "committed");
      expect(git(f.repo.root, "branch", "--list", "restart-move").length > 0).toBe(
        step === "committed",
      );
    },
  );
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
  it("serializes competing move/recovery requests and blocks final turn acceptance without deadlocking", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "loose"), "copy");
    f.copyControl.block = true;
    const running = f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "concurrent-move" }),
    );
    await f.runtime.runPromise(Deferred.await(f.copyEntered));
    const second = f.runtime
      .runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "second-move" }))
      .then(
        () => null,
        (error: Error) => error,
      );
    const request = await f.request("use_project_checkout");
    const recovery = f.runtime.runPromise(f.transition.switchWorkspace(request)).then(
      (result) => result,
      (error: Error) => error,
    );
    const at = new Date().toISOString();
    await expect(
      f.runtime.runPromise(
        f.engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("send-during-move"),
            threadId: f.threadId,
            message: {
              messageId: MessageId.makeUnsafe("move-message"),
              role: "user",
              text: "wait",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: at,
          })
          .pipe(Effect.timeout("2 seconds")),
      ),
    ).rejects.toThrow(/transition|switch/i);
    await f.runtime.runPromise(Deferred.succeed(f.copyRelease, undefined));
    const moved = await running;
    expect(await second).toBeInstanceOf(Error);
    const recovered = await recovery;
    expect(recovered instanceof Error || recovered.phase === "failed").toBe(true);
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath).toBe(
      moved.worktreePath,
    );
    expect(git(f.repo.root, "branch", "--list", "second-move")).toBe("");
  });
  it("keeps copied checkout files when the conversation is archived during a move", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "loose"), "keep me");
    await fs.writeFile(path.join(f.repo.root, "README.md"), "tracked archive copy");
    f.copyControl.block = true;
    const running = f.runtime
      .runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "archive-move" }))
      .then(
        () => null,
        (error: Error) => error,
      );
    await f.runtime.runPromise(Deferred.await(f.copyEntered));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-move"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await running;
    await f.runtime.runPromise(f.transition.cancel(f.threadId));
    expect(result).toBeInstanceOf(Error);
    const record = (await f.runtime.runPromise(f.store.forThread(f.threadId)))!;
    expect(record.phase).toBe("cancelled");
    expect(record.error).toContain("Retained checkout");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    // Reproduce a cancelled record left by an older server before ref cleanup.
    const gitCore = await f.runtime.runPromise(Effect.service(GitCore));
    const latest = (await f.runtime.runPromise(f.store.get(record.operationId)))!;
    const ref = `refs/f5/moves/${record.operationId}`;
    await f.runtime.runPromise(
      gitCore.setMoveRef(f.repo.root, ref, latest.moveData!.snapshot.trackedStashSha!),
    );
    await f.runtime.runPromise(
      f.store.update(latest, { moveData: { ...latest.moveData!, snapshotRef: ref } }),
    );
    await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("unarchive-move"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
    expect((await f.runtime.runPromise(f.store.get(record.operationId)))?.phase).toBe("cancelled");
    expect((await f.runtime.runPromise(f.store.get(record.operationId)))?.error).toContain(
      "Retained checkout",
    );
    expect(await fs.readFile(path.join(record.target.path, "loose"), "utf8")).toBe("keep me");
    expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("keep me");
  });
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
  it.each([
    "accept_inspected_workspace",
    "keep_original_workspace",
    "use_project_checkout",
  ] as const)("cleans up move recovery for %s immediately", async (action) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "README.md"), "tracked snapshot");
    await fs.writeFile(path.join(f.repo.root, "loose"), "complete copy");
    f.failPhase.current = "applied";
    f.cleanupControl.fail = true;
    await expect(
      f.runtime.runPromise(
        f.transition.moveThread({ threadId: f.threadId, branch: "move-recovery" }),
      ),
    ).rejects.toThrow();
    let record = (await f.runtime.runPromise(f.store.forThread(f.threadId)))!;
    expect(record.phase).toBe("needs_recovery");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).not.toBe("");
    f.failPhase.current = null;
    f.cleanupControl.fail = false;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    const resolved = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: record.operationId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action,
      }),
    );
    expect(resolved.phase).toBe("completed");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    expect(
      await fs
        .stat(record.target.path)
        .then(() => true)
        .catch(() => false),
    ).toBe(action === "accept_inspected_workspace");
    expect(git(f.repo.root, "branch", "--list", "move-recovery").length > 0).toBe(
      action === "accept_inspected_workspace",
    );
    expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("complete copy");
  });
  it("waits for filesystem copying to settle before cancellation returns", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "a"), "first");
    await fs.writeFile(path.join(f.repo.root, "b"), "second");
    const core = await f.runtime.runPromise(Effect.service(GitCore));
    const snapshot = await f.runtime.runPromise(core.readMoveSnapshot(f.repo.root));
    const target = path.join(f.repo.dir, "cancel-copy");
    await fs.mkdir(target);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fsPromises.copyFile;
    const spy = vi.spyOn(fsPromises, "copyFile").mockImplementationOnce(async (...args) => {
      await original(...args);
      entered();
      await releasePromise;
    });
    const copying = Effect.runFork(core.copyMoveUntracked(f.repo.root, target, snapshot.untracked));
    try {
      await enteredPromise;
      let interrupted = false;
      const cancellation = Effect.runPromise(Fiber.interrupt(copying)).then(() => {
        interrupted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(interrupted).toBe(false);
      release();
      await cancellation;
      expect(await fs.readFile(path.join(target, "b"), "utf8")).toBe("second");
    } finally {
      release();
      await Effect.runPromise(Fiber.interrupt(copying));
      spy.mockRestore();
    }
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

  it("moves to a flat temporary branch when the t3code namespace is occupied", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "t3code");
    const request = await f.request("move_to_new_worktree");
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("completed");
    const thread = (await f.runtime.runPromise(f.engine.getReadModel())).threads[0]!;
    expect(thread.branch).toMatch(/^t3code-[0-9a-f]{8}$/);
    expect(git(thread.worktreePath!, "branch", "--show-current").trim()).toBe(thread.branch);
  });

  it.each(["t3code/abcdef12", "t3code-abcdef12", "t3code/12345678-1234-4234-8234-123456789abc"])(
    "reserves temporary branch %s for managed worktrees",
    async (branch) => {
      const f = await fixture();
      const request = await f.request("move_to_new_worktree", { branch });
      await expect(f.runtime.runPromise(f.transition.switchWorkspace(request))).rejects.toThrow(
        "Invalid branch name",
      );
    },
  );
  it("joins identical retries, commits once, and never accepts a changed payload", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "topic");
    git(f.repo.root, "worktree", "add", "-q", "-b", "topic", target, "main");
    const input = await f.request("attach_existing", { targetPath: target, branch: "topic" });
    const [one, two] = await Promise.all([
      f.runtime.runPromise(f.transition.switchWorkspace(input)),
      f.runtime.runPromise(f.transition.switchWorkspace(input)),
    ]);
    expect(one.phase).toBe("completed");
    expect(two).toEqual(one);
    expect(await f.runtime.runPromise(f.transition.switchWorkspace(input))).toEqual(one);
    await expect(
      f.runtime.runPromise(f.transition.switchWorkspace({ ...input, branch: "changed" })),
    ).rejects.toThrow(/another request|different/);
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath).toBe(
      await fs.realpath(target),
    );
  });
  it("blocks in-place checkout for an idle archived local reference and live terminals", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const foreign = ThreadId.makeUnsafe("archived");
    await f.create(foreign);
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId: foreign,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("checkout_branch", { branch: "topic", sharedFilesystemConfirmed: true }),
      ),
    );
    expect(result.phase).toBe("failed");
    expect(result.error).toMatch(/references this checkout/);
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it.each(["checkout_branch", "create_branch_and_checkout"] as const)(
    "refuses %s when the conversation's own terminal is live",
    async (intent) => {
      const f = await fixture();
      if (intent === "checkout_branch") git(f.repo.root, "branch", "topic");
      f.world.terminals.push({
        threadId: f.threadId,
        terminalId: "own-shell",
        cwd: f.repo.root,
        status: "running",
      });
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request(intent, { branch: "topic" })),
      );
      expect(result.phase).toBe("failed");
      expect(result.errorCode).toBe("WorkspaceRequiresNewWorktree");
      expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
    },
  );

  it("requires explicit sharing confirmation and rejects external attachments", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "shared");
    git(f.repo.root, "worktree", "add", "-q", "-b", "shared", target, "main");
    await f.create(ThreadId.makeUnsafe("other"), "shared", target);
    const rejected = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    expect(rejected.phase).toBe("failed");
    expect(rejected.error).toMatch(/sharing/);
    const accepted = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, sharedFilesystemConfirmed: true }),
      ),
    );
    expect(accepted.phase).toBe("completed");
    const external = path.join(f.repo.root, "..", "external");
    git(f.repo.root, "worktree", "add", "-q", "-b", "external", external, "main");
    await expect(
      f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: external })),
      ),
    ).rejects.toThrow(/profile/);
  });
  it("creates and checks out a branch atomically, leaving a manual pause alone", async () => {
    const f = await fixture();
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "manual_pause" }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("create_branch_and_checkout", { branch: "created" }),
      ),
    );
    expect(result.error).toBeNull();
    expect(result.phase).toBe("completed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("created");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("manual_pause");
  });
  it("recovers a partial Git outcome only after preview and rejects stale acceptance tokens", async () => {
    const f = await fixture();
    const request = await f.request("checkout_branch", { branch: "topic" });
    // Canonicalize exactly as the transition does; raw Git output differs on Windows
    // (forward slashes, 8.3 short names), which would read as a repository change.
    const repository = await canonicalWorktreePath(
      git(f.repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const source = {
      path: await canonicalWorktreePath(f.repo.root),
      repository,
      branch: "main",
      headSha: git(f.repo.root, "rev-parse", "HEAD"),
    };
    const record = await f.runtime.runPromise(
      f.store.reserve({
        operationId: request.operationId,
        threadId: f.threadId,
        version: 0,
        intent: request.intent,
        phase: "reserved",
        request,
        requestHash: "crashed",
        source,
        target: { ...source, branch: "topic" },
        observed: null,
        fingerprint: null,
        mutationAttempted: false,
        result: null,
        error: null,
        commandId: `workspace:${request.operationId}`,
        setupOwnerToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await f.runtime.runPromise(
      f.store.update(record, { phase: "applying", mutationAttempted: true }),
    );
    git(f.repo.root, "checkout", "-qb", "topic");
    await f.runtime.runPromise(f.store.reconcile);
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    await fs.writeFile(path.join(f.repo.root, "changed.txt"), "retained");
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: record.operationId,
          version: preview.transition.version,
          acceptanceToken: preview.acceptanceToken,
          action: "accept_inspected_workspace",
        }),
      ),
    ).rejects.toThrow(/changed/);
    const fresh = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: record.operationId,
          version: fresh.transition.version,
          acceptanceToken: fresh.acceptanceToken,
          action: "retry",
        }),
      ),
    ).rejects.toThrow(/partial/);
    const result = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: record.operationId,
        version: fresh.transition.version,
        acceptanceToken: fresh.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(result.phase).toBe("completed");
    expect(await fs.readFile(path.join(f.repo.root, "changed.txt"), "utf8")).toBe("retained");
  });
  it("recreates the recorded checkout, prepares outside locks, and resumes only a missing-worktree pause", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "recovery");
    git(f.repo.root, "worktree", "add", "-q", "-b", "recovery", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, branch: "recovery" }),
      ),
    );
    await fs.rm(target, { recursive: true });
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
    );
    const before = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
    const recovered = await f.runtime.runPromise(
      f.manager.recover({
        threadId: f.threadId,
        expectedQueueRevision: before.state.revision,
        action: "recreate",
      }),
    );
    expect(recovered.registration).toBe("matching");
    expect(f.preparations).toContain(await fs.realpath(target));
    expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.paused).toBe(false);
    await fs.rm(target, { recursive: true });
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "manual_pause" }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("recreate_from_base")),
    );
    expect(result.phase).toBe("completed");
    expect(result.target.path).toBe(await fs.realpath(target));
    expect(result.target.branch).not.toBe("recovery");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("manual_pause");
  });
  describe("restoring the recorded branch of a drifted worktree", () => {
    const drifted = async () => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "recorded");
      git(f.repo.root, "worktree", "add", "-q", "-b", "recorded", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(
          await f.request("attach_existing", { targetPath: target, branch: "recorded" }),
        ),
      );
      git(target, "checkout", "-q", "-b", "agent-branch");
      const restore = async () =>
        f.runtime.runPromise(
          f.manager
            .recover({
              threadId: f.threadId,
              action: "restoreRecordedBranch",
              expectedQueueRevision: (await f.runtime.runPromise(f.queue.listByThread(f.threadId)))
                .state.revision,
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
              Effect.orElseSucceed(() => null),
            ),
        );
      return { f, target, restore };
    };

    it("checks the branch out under the transition and resumes the paused queue item", async () => {
      const { f, target, restore } = await drifted();
      await fs.writeFile(path.join(target, "scratch.txt"), "wip");
      expect(await restore()).toContain("Commit or stash");
      await fs.rm(path.join(target, "scratch.txt"));
      const at = new Date().toISOString();
      await f.runtime.runPromise(
        f.queue.insertSubmission({
          submissionId: CommandId.makeUnsafe("drift-queued"),
          itemId: CommandId.makeUnsafe("drift-queued"),
          atHead: false,
          requestHash: "drift-queued",
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("drift-queued"),
            threadId: f.threadId,
            message: {
              messageId: MessageId.makeUnsafe("drift-queued"),
              role: "user",
              text: "next",
              attachments: [],
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            createdAt: at,
          },
        }),
      );
      await f.runtime.runPromise(
        f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
      );
      // The paused message that exposed the drift does not block its own recovery.
      expect(await restore()).toBeNull();
      expect(git(target, "branch", "--show-current")).toBe("recorded");
      const queue = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
      expect(queue.state.paused).toBe(false);
      expect(queue.items).toHaveLength(1);
    });

    it("refuses while another conversation shares the checkout", async () => {
      const { f, target, restore } = await drifted();
      await f.create(ThreadId.makeUnsafe("peer"), "agent-branch", target);
      expect(await restore()).toMatch(/references this checkout/);
      expect(git(target, "branch", "--show-current")).toBe("agent-branch");
    });

    it("refuses while an accepted turn waits for provider delivery", async () => {
      const { f, target, restore } = await drifted();
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_turns(thread_id,state,requested_at,checkpoint_files_json) VALUES (${f.threadId},'pending','now','[]')`;
        }),
      );
      expect(await restore()).toMatch(/active or pending turn/);
      expect(git(target, "branch", "--show-current")).toBe("agent-branch");
    });

    it("refuses during an in-progress Git operation or on a detached HEAD", async () => {
      const { target, restore } = await drifted();
      // A clean tree can still be mid-operation; switching would abandon its state.
      git(target, "bisect", "start");
      expect(await restore()).toMatch(/bisect in progress/);
      git(target, "bisect", "reset");
      await fs.writeFile(path.join(target, "README.md"), "agent\n");
      git(target, "commit", "-qam", "agent change");
      git(target, "checkout", "-q", "--detach");
      // The detached commit would be unreachable from the recorded branch.
      expect(await restore()).toContain("detached HEAD");
      expect(git(target, "branch", "--show-current")).toBe("");
    });
  });

  it("holds a preparation failure independently of queue resume and never repeats its Git step", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "retry");
    git(f.repo.root, "worktree", "add", "-q", "-b", "retry", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.preparationControl.fail = true;
    const request = await f.request("recreate");
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("needs_recovery");
    await f.runtime.runPromise(f.queue.setPaused({ threadId: f.threadId, paused: false }));
    expect((await f.runtime.runPromise(f.store.forThread(f.threadId, true)))?.operationId).toBe(
      request.operationId,
    );
    expect(await f.runtime.runPromise(f.transition.switchWorkspace(request))).toEqual(result);
    expect(f.preparations).toHaveLength(1);
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: request.operationId }),
    );
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: request.operationId,
          version: preview.transition.version,
          acceptanceToken: preview.acceptanceToken,
          action: "retry",
        }),
      ),
    ).rejects.toThrow(/partial/);
  });
  it("rolls back the metadata transaction if completion persistence fails after Git, then accepts the inspected checkout", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.failPhase.current = "completed";
    const request = await f.request("checkout_branch", { branch: "topic" });
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("needs_recovery");
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.branch).toBe("main");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("topic");
    f.failPhase.current = null;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: request.operationId }),
    );
    const accepted = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: request.operationId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(accepted.phase).toBe("completed");
  });
  it.each(["dirty.txt", "untracked/nested.txt", "ignored/nested.txt"])(
    "rejects a preview after contents change in %s",
    async (relative) => {
      const f = await fixture();
      git(f.repo.root, "branch", "topic");
      f.failPhase.current = "applied";
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
      );
      expect(result.phase).toBe("needs_recovery");
      f.failPhase.current = null;
      const file = path.join(f.repo.root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (relative.startsWith("ignored/"))
        await fs.appendFile(path.join(f.repo.root, ".git", "info", "exclude"), "\nignored/\n");
      await fs.writeFile(file, "first");
      const preview = await f.runtime.runPromise(
        f.transition.previewRecovery({ operationId: result.operationId }),
      );
      await fs.writeFile(file, "changed contents");
      await expect(
        f.runtime.runPromise(
          f.transition.resolve({
            operationId: result.operationId,
            version: preview.transition.version,
            acceptanceToken: preview.acceptanceToken,
            action: "accept_inspected_workspace",
          }),
        ),
      ).rejects.toThrow(/changed/);
    },
  );
  it("allows archive to interrupt preparation, settle its caller, and retain checkout files", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "cancel");
    git(f.repo.root, "worktree", "add", "-q", "-b", "cancel", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.preparationControl.block = true;
    const request = await f.request("recreate");
    const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
    await f.runtime.runPromise(Deferred.await(f.preparationEntered));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-active-transition"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    expect((await running).phase).toBe("cancelled");
    expect((await f.runtime.runPromise(f.store.get(request.operationId)))?.phase).toBe("cancelled");
    expect(await fs.stat(target)).toBeDefined();
  });
  it("refuses a live terminal that opens before locked revalidation", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.world.terminals.push({
      threadId: f.threadId,
      terminalId: "shell",
      cwd: f.repo.root,
      status: "running",
    });
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it("times out waiting for the stopped session projection without holding checkout locks", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const at = new Date().toISOString();
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("idle-session"),
        threadId: f.threadId,
        session: {
          threadId: f.threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      }),
    );
    const request = await f.request("checkout_branch", { branch: "topic" });
    const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
    await f.runtime.runPromise(Deferred.await(f.stoppingEntered));
    expect((await f.runtime.runPromise(f.store.get(request.operationId)))?.phase).toBe("stopping");
    await f.runtime.runPromise(
      withWorktreeLifecycleLock(f.repo.root, Effect.void).pipe(Effect.timeout("1 second")),
    );
    const result = await running;
    expect(result.phase).toBe("failed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it("preserves an ignored secret when the target branch tracks the same filename", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "env-topic");
    git(f.repo.root, "worktree", "add", "-q", "-b", "env-topic", target, "main");
    await fs.writeFile(path.join(target, ".env"), "branch file");
    git(target, "add", "-f", ".env");
    git(target, "commit", "-qm", "tracked configuration");
    git(target, "checkout", "-qb", "hold-topic");
    await fs.appendFile(path.join(f.repo.root, ".git", "info", "exclude"), "\n.env\n");
    await fs.writeFile(path.join(f.repo.root, ".env"), "local secret");
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "env-topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(result.checkoutConflict?.files).toContain(".env");
    expect(await fs.readFile(path.join(f.repo.root, ".env"), "utf8")).toBe("local secret");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
  it("refreshes the recorded branch in the same shared checkout without confirming a new attachment", async () => {
    const f = await fixture();
    await f.create(ThreadId.makeUnsafe("archived-peer"));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-peer"),
        threadId: ThreadId.makeUnsafe("archived-peer"),
        createdAt: new Date().toISOString(),
      }),
    );
    git(f.repo.root, "checkout", "-qb", "changed-outside");
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: f.repo.root, branch: "changed-outside" }),
      ),
    );
    expect(result.phase).toBe("completed");
    expect(result.result?.branch).toBe("changed-outside");
  });

  for (const intent of ["recreate", "recreate_from_base"] as const) {
    it.each(["failure", "cancel"] as const)(
      `can leave a missing checkout after ${intent} %s without repeating Git`,
      async (outcome) => {
        const f = await fixture();
        const target = path.join(f.config.worktreesDir, "missing");
        git(f.repo.root, "worktree", "add", "-q", "-b", "missing", target, "main");
        await f.runtime.runPromise(
          f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
        );
        await fs.rm(target, { recursive: true });
        await f.runtime.runPromise(
          f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
        );
        f.mutationControl.fail = outcome === "failure";
        f.mutationControl.block = outcome === "cancel";
        const request = await f.request(intent);
        const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
        await f.runtime.runPromise(Deferred.await(f.mutationEntered));
        if (outcome === "cancel") await f.runtime.runPromise(f.transition.cancel(f.threadId, true));
        expect((await running).phase).toBe("needs_recovery");
        const preview = await f.runtime.runPromise(
          f.transition.previewRecovery({ operationId: request.operationId }),
        );
        expect(preview.actual).toBeNull();
        expect(preview.original).toBeNull();
        expect(preview.canRetry).toBe(false);
        const resolved = await f.runtime.runPromise(
          f.transition.resolve({
            operationId: request.operationId,
            version: preview.transition.version,
            acceptanceToken: preview.acceptanceToken,
            action: "use_project_checkout",
          }),
        );
        expect(resolved.phase).toBe("completed");
        expect(resolved.result?.worktreePath).toBeNull();
        expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.paused).toBe(
          false,
        );
        expect(
          await fs.stat(target).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      },
    );
    it(`${intent} does not claim a Git mutation when applying fails before its first mutating call`, async () => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "preflight");
      git(f.repo.root, "worktree", "add", "-q", "-b", "preflight", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
      );
      await fs.rm(target, { recursive: true });
      f.failPhase.current = "applying";
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request(intent)),
      );
      expect(result.phase).toBe("failed");
      expect((await f.runtime.runPromise(f.store.get(result.operationId)))?.mutationAttempted).toBe(
        false,
      );
      expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
    });
  }

  it("finishes a recovered Work locally handoff with a real setup token and replays the setup action", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "handoff");
    git(f.repo.root, "worktree", "add", "-q", "-b", "handoff", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    const at = new Date().toISOString();
    const operationId = "setup-handoff";
    const itemId = CommandId.makeUnsafe("setup-first-turn");
    const snapshot: WorktreeSetupSnapshot = {
      threadId: f.threadId,
      operationId,
      itemId,
      phase: "failed",
      startedAt: at,
      endedAt: at,
      request: {
        projectCwd: f.repo.root,
        baseBranch: "main",
        branch: "handoff",
        requireWorktree: true,
        runSetupScript: true,
      },
      baseRef: "main",
      baseSha: git(f.repo.root, "rev-parse", "HEAD"),
      worktreePath: target,
      createdBranch: false,
      createdWorktree: false,
      setupScript: null,
      agentStarted: false,
      stages: [],
      error: "setup failed",
      generation: 0,
      sequence: 1,
    };
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("seed-setup"),
        threadId: f.threadId,
        activity: {
          id: EventId.makeUnsafe(`worktree-setup:${f.threadId}`),
          kind: "worktree-setup",
          tone: "error",
          summary: "Failed setup",
          payload: snapshot,
          turnId: null,
          createdAt: at,
        },
        createdAt: at,
      }),
    );
    await f.runtime.runPromise(
      f.queue.insertSubmission({
        submissionId: itemId,
        itemId,
        atHead: true,
        requestHash: "setup",
        worktreeBlockToken: operationId,
        command: {
          type: "thread.turn.start",
          commandId: itemId,
          threadId: f.threadId,
          message: {
            messageId: MessageId.makeUnsafe("message"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: at,
        },
      }),
    );
    await f.runtime.runPromise(
      f.queue.setPaused({
        threadId: f.threadId,
        paused: true,
        reasonCode: "worktree_setup_failed",
      }),
    );
    f.failPhase.current = "completed";
    await expect(
      f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId)),
    ).rejects.toThrow();
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.worktreeBlockToken,
    ).toBe(operationId);
    f.failPhase.current = null;
    const transitionId = `work-locally:${operationId}`;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: transitionId }),
    );
    const result = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: transitionId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(result.phase).toBe("completed");
    expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state).toMatchObject({
      worktreeBlockToken: null,
      paused: false,
    });
    const settled = await f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId));
    expect(settled?.phase).toBe("cancelled_kept");
    expect(await fs.stat(target)).toBeTruthy();
    expect(await f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId))).toEqual(
      settled,
    );
  });
  it("retries indeterminate async preparation after its old setup token was cleared, preserving the existing setup pause", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "async-restart");
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const gitCore = yield* GitCore;
        const receipts = yield* WorktreePreparations;
        yield* gitCore.createWorktree({
          cwd: f.repo.root,
          branch: "main",
          newBranch: "async-restart",
          path: target,
          preparation: { owner: "workflow:async", runSetupScript: true },
        });
        const receipt = (yield* gitCore.readWorktreePreparation(target))!;
        yield* receipts.update(receipt, { phase: "setup_running", result: '{"async":true}' });
        yield* receipts.reconcile;
      }),
    );
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await f.runtime.runPromise(
      f.queue.setPaused({
        threadId: f.threadId,
        paused: true,
        reasonCode: "worktree_setup_failed",
      }),
    );
    expect(
      (await f.runtime.runPromise(f.manager.threadState({ threadId: f.threadId }))).recovery,
    ).toBe("interrupted");
    const queue = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
    const state = await f.runtime.runPromise(
      f.manager.recover({
        threadId: f.threadId,
        action: "recreate",
        expectedQueueRevision: queue.state.revision,
      }),
    );
    expect(state.recovery).toBe("none");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("worktree_setup_failed");
  });
});
