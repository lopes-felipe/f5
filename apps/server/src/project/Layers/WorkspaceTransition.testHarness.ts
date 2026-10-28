import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, expect } from "vitest";
import { ServerConfig } from "../../config.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { makeFakeTextGeneration } from "../../git/testDoubles.ts";
import { NextTurnQueueStoreLive } from "../../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeWorkspaceTransitions } from "../../persistence/Layers/WorkspaceTransitions.ts";
import {
  WorkspaceTransitionError,
  WorkspaceTransitions,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import {
  PreparationError,
  WorktreePreparations,
} from "../../persistence/Services/WorktreePreparations.ts";
import { ProfileRegistryStore } from "../../profiles/ProfileRegistryStore.ts";
import {
  automationLayer,
  git,
  makeClonedRepo,
  makeWorld,
} from "../../storage/storageAutomation.testHarness.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { WorktreeSetup } from "../Services/WorktreeSetup.ts";
import { WorktreeSetupGateLive } from "../Services/WorktreeSetupGate.ts";
import { WorkspaceTransitionLive } from "./WorkspaceTransition.ts";
import { holdsWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";
import { makeWorktreeManager } from "./WorktreeManager.ts";
import { WorktreeSetupLive } from "./WorktreeSetup.ts";

// Each test gets its own real Git repository, runtime and SQL pipeline.
export function createWorkspaceTransitionFixture() {
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
  return fixture;
}
