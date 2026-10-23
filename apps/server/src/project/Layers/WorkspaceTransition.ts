import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readProjectSettings } from "../projectSettings.ts";
import { sameMoveSnapshot, isMoveCopySnapshot } from "../../git/moveSnapshot.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildGeneratedWorktreeBranchName } from "../../git/worktreeBranchNames.ts";
import { WorkspaceRequiresNewWorktreeError } from "../../git/workspaceSwitch.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { lstat } from "node:fs/promises";
import { canonicalJsonHash } from "../../canonicalJsonHash.ts";
import { randomBytes } from "node:crypto";
import {
  CommandId,
  type ThreadId,
  type WorkspaceCheckoutIdentity,
  type WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { Cause, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore, type CheckoutInspection } from "../../git/Services/GitCore.ts";
import {
  WorkspaceTransitions,
  WorkspaceTransitionError,
  workspaceTransitionSnapshot,
  transitionIsActive,
  type WorkspaceTransitionRecord,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { assertExclusiveProfileCheckout } from "../../profiles/RepositorySharing.ts";
import { readWorktreeClaims, evaluateWorktreeRemoval } from "../worktreeClaims.ts";
import { canonicalWorkspace, inspectAttachableWorkspace } from "../workspaceAttachment.ts";
import { WorkspaceWriteContext } from "../workspaceTransitionContext.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import {
  WorkspaceTransition,
  type WorkspaceTransitionShape,
} from "../Services/WorkspaceTransition.ts";
import {
  withWorktreeLifecycleLock,
  withWorktreeLifecycleLocks,
  withRepositoryLifecycleLock,
  pathContains,
} from "./WorktreeLifecycleCoordinator.ts";

const digest = canonicalJsonHash;
const identity = (checkout: CheckoutInspection): WorkspaceCheckoutIdentity => ({
  path: checkout.canonicalRoot,
  repository: checkout.commonDir,
  branch: checkout.branch,
  headSha: checkout.headSha,
});
export const makeWorkspaceTransition = Effect.gen(function* () {
  const store = yield* WorkspaceTransitions;
  const engine = yield* OrchestrationEngineService;
  const git = yield* GitCore;
  const config = yield* ServerConfig;
  const queue = yield* NextTurnQueueStore;
  const dispatcher = yield* NextTurnQueueDispatcher;
  const setup = yield* WorktreeSetupGate;
  const preparation = yield* WorktreePreparation;
  const providers = yield* ProviderService;
  const services = yield* Effect.services<
    | OrchestrationEngineService
    | ProviderService
    | TerminalManager
    | NextTurnQueueStore
    | WorktreeSetupGate
    | GitCore
    | ServerConfig
    | WorkspaceTransitions
  >();
  const scope = yield* Effect.scope;
  const textGeneration = yield* Effect.serviceOption(TextGeneration);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const secret = randomBytes(32).toString("hex");
  const workers = new Map<
    string,
    {
      fiber: Fiber.Fiber<void, never>;
      result: Deferred.Deferred<WorkspaceTransitionSnapshot, Error>;
    }
  >();
  const owners = new Map<string, number>();
  const withOwner = <A, E, R>(operationId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        owners.set(operationId, (owners.get(operationId) ?? 0) + 1);
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          const count = (owners.get(operationId) ?? 1) - 1;
          if (count === 0) owners.delete(operationId);
          else owners.set(operationId, count);
        }),
    );
  const readTransition = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const record = yield* store.forThread(threadId);
      if (
        record &&
        transitionIsActive(record) &&
        record.phase !== "needs_recovery" &&
        !workers.has(record.operationId) &&
        !owners.has(record.operationId)
      ) {
        const interrupted = yield* store.update(record, {
          phase: "needs_recovery",
          error: "Workspace switching stopped before completion. Inspect it before continuing.",
        });
        yield* dispatcher.notify(threadId);
        return interrupted;
      }
      return record;
    });
  const context = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const thread = model.threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null && entry.archivedAt === null,
      );
      const project = model.projects.find(
        (entry) => entry.id === thread?.projectId && entry.deletedAt === null,
      );
      if (!thread || !project)
        return yield* Effect.fail(new Error("Conversation or project is unavailable."));
      return { thread, project };
    });
  const currentRecord = (operationId: string) =>
    Effect.gen(function* () {
      const record = yield* store.get(operationId);
      if (!record) return yield* Effect.fail(new Error("Unknown workspace transition."));
      return record;
    });
  const inspect = (path: string) => git.inspectCheckout(path);
  const claims = (path: string) => readWorktreeClaims(path).pipe(Effect.provideServices(services));
  const validateClaims = (record: WorkspaceTransitionRecord, path: string, inPlace: boolean) =>
    Effect.gen(function* () {
      const usage = yield* claims(path);
      if (usage.unknown)
        return yield* Effect.fail(new Error("Workspace usage could not be verified."));
      const foreign = usage.threadIds.filter((id) => id !== record.threadId);
      if (
        inPlace &&
        (foreign.length ||
          usage.terminals.length ||
          usage.sessions.length ||
          usage.activeThreadIds.some((id) => id !== record.threadId) ||
          usage.queuedThreadIds.some((id) => id !== record.threadId) ||
          usage.setupThreadIds.some((id) => id !== record.threadId))
      )
        return yield* Effect.fail(
          new WorkspaceRequiresNewWorktreeError(
            "Another conversation, terminal, session, or queued operation references this checkout. Create a new worktree instead.",
          ),
        );
      if (
        record.intent === "move_to_new_worktree" &&
        (foreign.length || usage.sessions.length || usage.terminals.length)
      )
        return yield* Effect.fail(
          new Error("Another conversation or process references the new worktree."),
        );
      if (usage.setupThreadIds.some((id) => id !== record.threadId))
        return yield* Effect.fail(new Error("Another setup or transition owns this checkout."));
      if (
        !inPlace &&
        foreign.length &&
        path !== record.source.path &&
        !record.request.sharedFilesystemConfirmed &&
        record.intent === "attach_existing"
      )
        return yield* Effect.fail(
          new Error("Confirm sharing this checkout's filesystem with the linked conversations."),
        );
      if (inPlace)
        yield* Effect.tryPromise(() => assertExclusiveProfileCheckout(config, path)).pipe(
          Effect.mapError((error) => (error.cause instanceof Error ? error.cause : error)),
        );
    });
  // Project root first when needed; remaining path locks are acquired in canonical order.
  const locked = <A, E, R>(record: WorkspaceTransitionRecord, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { project } = yield* context(record.threadId);
      if (
        record.source.path === (yield* canonicalWorkspace(project.workspaceRoot)) ||
        record.target.path === (yield* canonicalWorkspace(project.workspaceRoot))
      )
        return yield* withWorktreeLifecycleLock(
          project.workspaceRoot,
          withWorktreeLifecycleLocks(
            [record.source.path, record.target.path],
            withRepositoryLifecycleLock(config.baseDir, record.source.repository, effect),
          ),
        );
      return yield* withWorktreeLifecycleLocks(
        [record.source.path, record.target.path],
        withRepositoryLifecycleLock(config.baseDir, record.source.repository, effect),
      );
    });
  const checkContext = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const live = yield* currentRecord(record.operationId);
      if (!transitionIsActive(live) || live.version !== record.version)
        return yield* Effect.fail(new Error("Workspace transition ownership changed."));
      const { thread, project } = yield* context(record.threadId);
      if (
        thread.branch !== record.request.expected.branch ||
        thread.worktreePath !== record.request.expected.worktreePath
      )
        return yield* Effect.fail(new Error("The source workspace reference changed."));
      const setupToken = (yield* queue.listByThread(thread.id)).state.worktreeBlockToken;
      if (
        setupToken !== record.setupOwnerToken &&
        !(setupToken === null && record.setupOwnerToken !== null && record.setupOwnerOperationId)
      )
        return yield* Effect.fail(
          new Error("Workspace setup ownership changed during the transition."),
        );
      const repository = yield* git
        .resolveCommonDir(project.workspaceRoot)
        .pipe(Effect.flatMap(canonicalWorkspace));
      if (repository !== record.source.repository)
        return yield* Effect.fail(new Error("The project repository identity changed."));
      return { thread, project };
    });
  const stop = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const { thread } = yield* checkContext(record);
      const liveSessions = yield* providers.listSessions();
      const starting = yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([]);
      if (
        liveSessions.some(
          (session) =>
            session.threadId === thread.id &&
            (session.status === "connecting" || session.status === "running"),
        ) ||
        starting.some((session) => session.threadId === thread.id)
      )
        return yield* Effect.fail(
          new Error("Wait for the provider's active turn or session startup to finish."),
        );
      if (thread.session && thread.session.status !== "stopped")
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe(`workspace-stop:${record.operationId}:${record.version}`),
          threadId: thread.id,
          createdAt: new Date().toISOString(),
        });
      if (
        !thread.session &&
        (yield* providers.listSessions()).some(
          (session) => session.threadId === thread.id && session.status !== "closed",
        )
      )
        yield* providers.stopSession({ threadId: thread.id });
      yield* Effect.gen(function* () {
        while (true) {
          const sessions = yield* providers.listSessions();
          const starting = yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([]);
          const current = (yield* context(record.threadId)).thread;
          if (
            !sessions.some(
              (session) => session.threadId === record.threadId && session.status !== "closed",
            ) &&
            !starting.some((session) => session.threadId === record.threadId) &&
            (!current.session || current.session.status === "stopped")
          )
            return;
          yield* Effect.sleep("50 millis");
        }
      }).pipe(Effect.timeout("10 seconds"));
    }).pipe(Effect.timeout("10 seconds"));
  const commit = (record: WorkspaceTransitionRecord, checkout: CheckoutInspection) =>
    Effect.gen(function* () {
      const { thread, project } = yield* checkContext(record);
      const root = yield* canonicalWorkspace(project.workspaceRoot);
      const result = {
        branch: checkout.branch,
        worktreePath: checkout.canonicalRoot === root ? null : checkout.canonicalRoot,
        sessionUpdatedAt: thread.session?.updatedAt ?? null,
      };
      const applied = yield* store.update(record, {
        phase: "applied",
        observed: identity(checkout),
        fingerprint: digest(checkout),
        result,
        error: null,
        commandId: `workspace:${record.operationId}:${record.version + 1}`,
      });
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(applied.commandId),
          threadId: record.threadId,
          branch: result.branch,
          worktreePath: result.worktreePath,
        })
        .pipe(
          Effect.provideService(WorkspaceWriteContext, {
            expected: record.request.expected,
            operationId: record.operationId,
            version: applied.version,
          }),
        );
      return yield* currentRecord(record.operationId);
    });
  const releaseMoveRef = (record: WorkspaceTransitionRecord, cwd = record.source.path) =>
    Effect.gen(function* () {
      const move = record.moveData;
      if (!move?.snapshotRef) return record;
      if (move.snapshotRef !== `refs/f5/moves/${record.operationId}`)
        return yield* Effect.fail(
          new Error("Move snapshot ref identity changed; retained for inspection."),
        );
      const sha = yield* git.resolveCommit(cwd, move.snapshotRef);
      if (sha && sha !== move.snapshot.trackedStashSha)
        return yield* Effect.fail(new Error("Move snapshot ref changed; retained for inspection."));
      if (sha) yield* git.deleteMoveRef(cwd, move.snapshotRef, sha);
      return yield* store.update(record, { moveData: { ...move, snapshotRef: null } });
    });
  // Private refs belong to the repository, so cleanup must work after archive/delete
  // and even when the original project checkout no longer exists.
  const releaseRetainedMove = (initial: WorkspaceTransitionRecord) =>
    withRepositoryLifecycleLock(
      config.baseDir,
      initial.source.repository,
      Effect.gen(function* () {
        let record = yield* currentRecord(initial.operationId);
        const repository = yield* git
          .resolveCommonDir(record.source.repository)
          .pipe(Effect.flatMap(canonicalWorkspace));
        if (repository !== record.source.repository)
          return yield* Effect.fail(
            new Error("Move repository identity changed; private ref retained."),
          );
        if (record.phase !== "completed")
          record = yield* store.update(record, {
            phase: "cancelled",
            error: `Move cancelled. Retained checkout ${record.target.path} and branch ${record.target.branch ?? "(unknown)"}; the project checkout was kept.`,
          });
        return yield* releaseMoveRef(record, repository);
      }),
    );
  // Only byte-for-byte copies are disposable. The shared gate still protects ignored files,
  // foreign claims, changed commits, registration and creation ownership.
  const rollbackMove = (
    initial: WorkspaceTransitionRecord,
    message: string,
    phase: "failed" | "needs_recovery" = "failed",
  ) =>
    locked(
      initial,
      Effect.gen(function* () {
        let record = yield* currentRecord(initial.operationId);
        const move = record.moveData;
        const retained: string[] = [];
        if (move && record.mutationAttempted) {
          const receipt = yield* git.readWorktreePreparation(record.target.path);
          const registrations = yield* git.listWorktrees(record.source.path);
          const registration = registrations.find(
            (entry) => entry.canonicalPath === record.target.path,
          );
          if (
            registration &&
            receipt?.operationId === `move:${record.operationId}` &&
            receipt.createdCheckout
          ) {
            const actual = yield* git.readMoveSnapshot(record.target.path).pipe(Effect.option);
            const snapshot = Option.getOrNull(actual);
            const onlyCopies = snapshot && isMoveCopySnapshot(snapshot, move.snapshot);
            const policy = {
              kind: "ownedRollback" as const,
              ownThreadId: record.threadId,
              ownedCreation: {
                path: record.target.path,
                commonDir: record.source.repository,
                baseSha: move.snapshot.baseSha,
                created: true,
                transitionOperationId: record.operationId,
                ...(onlyCopies && snapshot ? { copiedSnapshot: snapshot } : {}),
              },
            };
            const checked = yield* evaluateWorktreeRemoval({
              projectCwd: record.source.path,
              path: record.target.path,
              policy,
            }).pipe(Effect.provideServices(services));
            const usage = yield* claims(record.target.path);
            if (usage.threadIds.length || usage.sessions.length || usage.terminals.length)
              checked.blockedReasons.push(
                "another conversation or process references the copied checkout",
              );
            if (checked.blockedReasons.length) retained.push(...checked.blockedReasons);
            else {
              if (snapshot && onlyCopies) yield* git.cleanMoveCopies(record.target.path, snapshot);
              const clean = yield* evaluateWorktreeRemoval({
                projectCwd: record.source.path,
                path: record.target.path,
                policy: {
                  ...policy,
                  ownedCreation: { ...policy.ownedCreation, copiedSnapshot: undefined },
                },
              }).pipe(Effect.provideServices(services));
              if (clean.blockedReasons.length) retained.push(...clean.blockedReasons);
              else yield* git.removeWorktree({ cwd: record.source.path, path: record.target.path });
            }
          } else if (registration) retained.push("creation ownership could not be verified");
          // Allocation proves intent only. A post-add marker proves branch creation.
          if (
            !retained.length &&
            receipt?.operationId === `move:${record.operationId}` &&
            (receipt.createdCheckout || move.createdBranch) &&
            record.target.branch
          ) {
            const checkedOut = (yield* git.listWorktrees(record.source.path)).some(
              (entry) => entry.branch === record.target.branch,
            );
            const removed =
              !checkedOut &&
              (yield* git.deleteBranchIfAt({
                cwd: record.source.path,
                branch: record.target.branch,
                expectedSha: move.snapshot.baseSha,
              }));
            if (!removed) retained.push("the new branch changed and was retained");
          } else if (
            !retained.length &&
            record.target.branch &&
            (yield* git.branchExists(record.source.path, record.target.branch))
          ) {
            retained.push(`branch ${record.target.branch} has no creation proof and was retained`);
          }
        }
        record = yield* releaseMoveRef(record);
        return yield* store.update(record, {
          phase,
          error:
            message +
            (retained.length ? ` Retained ${record.target.path}: ${retained.join("; ")}.` : ""),
        });
      }),
    );
  const applyMove = (initial: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      let record = initial;
      const { thread, project } = yield* checkContext(record);
      if (thread.worktreePath !== null)
        return yield* Effect.fail(
          new Error("Only a local conversation can be moved to a new worktree."),
        );
      const before = yield* inspect(record.source.path);
      if (!before.headSha)
        return yield* Effect.fail(
          new Error("Commit to the project checkout before moving this conversation."),
        );
      if (before.operation)
        return yield* Effect.fail(
          new Error(`Finish the ${before.operation} before moving this conversation.`),
        );
      if (
        before.commonDir !== record.source.repository ||
        before.canonicalRoot !== record.source.path ||
        before.headSha !== record.source.headSha ||
        before.branch !== record.source.branch
      )
        return yield* Effect.fail(
          new Error("The project checkout changed before the move. Try again."),
        );
      if (yield* git.branchExists(project.workspaceRoot, record.target.branch!))
        return yield* Effect.fail(new Error(`Branch '${record.target.branch}' already exists.`));
      const snapshot = yield* git.readMoveSnapshot(record.source.path);
      if (snapshot.baseSha !== record.source.headSha)
        return yield* Effect.fail(new Error("The project HEAD changed before the move."));
      record = yield* store.update(record, {
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
      });
      if (snapshot.trackedStashSha)
        yield* git.setMoveRef(
          record.source.path,
          record.moveData!.snapshotRef!,
          snapshot.trackedStashSha,
        );
      record = yield* store.update(record, { mutationAttempted: true });
      yield* git.createWorktree({
        cwd: project.workspaceRoot,
        branch: snapshot.baseSha,
        baseRefName: snapshot.baseSha,
        newBranch: record.target.branch!,
        path: record.target.path,
        submodules: "none",
        preparation: {
          owner: `thread:${thread.id}`,
          operationId: `move:${record.operationId}`,
          runSetupScript: true,
          setupIdentity: setupProjectScript(project.scripts)?.command ?? null,
          namingIntent: record.request.branch ? "explicit" : "generated",
        },
      });
      record = yield* store.update(record, {
        moveData: {
          ...record.moveData!,
          createdBranch: true,
          createdWorktree: true,
          copyStarted: true,
        },
      });
      if (snapshot.trackedStashSha)
        yield* git.stashApplySha(record.target.path, snapshot.trackedStashSha);
      yield* git.copyMoveUntracked(record.source.path, record.target.path, snapshot.untracked);
      const copied = yield* git.readMoveSnapshot(record.target.path);
      const source = yield* git.readMoveSnapshot(record.source.path);
      if (!sameMoveSnapshot(snapshot, copied) || !sameMoveSnapshot(snapshot, source))
        return yield* Effect.fail(
          new Error("The project checkout or copied files changed during the move. Try again."),
        );
      const checkout = yield* inspectAttachableWorkspace(
        git,
        config,
        project.workspaceRoot,
        record.target.path,
        record.target.branch,
      );
      return yield* store.update(record, {
        phase: "applied",
        observed: identity(checkout),
        fingerprint: digest(checkout),
        error: null,
      });
    });
  const apply = (initial: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      let record = yield* store.update(initial, { phase: "stopping", error: null });
      yield* stop(record);
      record = yield* locked(
        record,
        Effect.gen(function* () {
          const { thread, project } = yield* checkContext(record);
          if (record.intent === "move_to_new_worktree") return yield* applyMove(record);
          const inPlace =
            record.intent === "checkout_branch" || record.intent === "create_branch_and_checkout";
          if (thread.session && thread.session.status !== "stopped")
            return yield* Effect.fail(new Error("The provider session did not stop."));
          yield* validateClaims(record, record.target.path, inPlace);
          if (inPlace) {
            const before = yield* inspect(record.source.path);
            if (
              before.commonDir !== record.source.repository ||
              before.canonicalRoot !== record.source.path ||
              before.operation ||
              !before.branch ||
              before.registration?.locked !== null
            )
              return yield* Effect.fail(
                new Error("The source checkout identity or Git operation changed."),
              );
            if (record.source.headSha !== before.headSha || record.source.branch !== before.branch)
              return yield* Effect.fail(
                new Error("The source checkout changed after the request."),
              );
          }
          if (inPlace && !record.request.branch)
            return yield* Effect.fail(new Error("Choose a branch."));
          if (
            record.intent === "create_branch_and_checkout" &&
            (!(yield* git.isValidBranchName(record.request.branch!)) ||
              (yield* git.branchExists(project.workspaceRoot, record.request.branch!)))
          )
            return yield* Effect.fail(
              new Error("The new branch name is invalid or already exists."),
            );
          if (record.intent === "checkout_branch") {
            const planned = yield* git.resolveCheckoutTarget({
              cwd: record.source.path,
              branch: record.request.branch!,
            });
            if (
              planned.branch !== record.target.branch ||
              planned.headSha !== record.target.headSha
            )
              return yield* Effect.fail(
                new Error("The target branch changed during workspace switching."),
              );
          } else if (
            record.intent === "attach_existing" ||
            record.intent === "use_project_checkout"
          ) {
            const checked = yield* inspectAttachableWorkspace(
              git,
              config,
              project.workspaceRoot,
              record.target.path,
              record.target.branch,
            );
            if (digest(identity(checked)) !== digest(record.target))
              return yield* Effect.fail(
                new Error("The target checkout changed during workspace switching."),
              );
          }
          record = yield* store.update(record, { phase: "applying" });
          if (inPlace) {
            const branch = record.request.branch;
            if (!branch) return yield* Effect.fail(new Error("Choose a branch."));
            record = yield* store.update(record, { mutationAttempted: true });
            if (record.intent === "create_branch_and_checkout") {
              yield* git.createBranch({ cwd: record.source.path, branch });
            }
            yield* Effect.scoped(
              git.checkoutBranch(
                { cwd: record.source.path, branch },
                {
                  refreshUpstream: false,
                  expectedTarget: {
                    branch: record.target.branch!,
                    headSha: record.target.headSha!,
                  },
                },
              ),
            );
          } else if (record.intent === "recreate") {
            if (!thread.worktreePath || !thread.branch)
              return yield* Effect.fail(new Error("The worktree branch is unavailable."));
            record = yield* store.update(record, { mutationAttempted: true });
            yield* git.ensureWorktree({
              owner: `thread:${thread.id}`,
              cwd: project.workspaceRoot,
              path: record.target.path,
              branch: thread.branch,
              submodules: "none",
            });
          } else if (record.intent === "recreate_from_base") {
            const base = yield* git.resolveCommit(
              project.workspaceRoot,
              record.baseRef ?? record.target.headSha ?? "HEAD",
            );
            if (!base || base !== record.target.headSha)
              return yield* Effect.fail(new Error("The recorded recovery base changed."));
            record = yield* store.update(record, { mutationAttempted: true });
            yield* git.clearMissingRegistration(project.workspaceRoot, record.target.path);
            yield* git.createWorktree({
              cwd: project.workspaceRoot,
              branch: base,
              baseRefName: base,
              newBranch: record.target.branch!,
              path: record.target.path,
              submodules: "none",
              preparation: {
                owner: `thread:${thread.id}`,
                runSetupScript: true,
                replaceMissing: true,
              },
            });
          }
          const checkout = yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            record.target.path,
            inPlace ? undefined : record.target.branch,
          );
          const applied = yield* store.update(record, {
            phase: "applied",
            observed: identity(checkout),
            fingerprint: digest(checkout),
            error: null,
          });
          return applied;
        }),
      );
      // Preparation and submodule/network work never run under lifecycle locks.
      if (
        (record.intent === "recreate" || record.intent === "recreate_from_base") &&
        record.observed?.branch
      ) {
        const { project } = yield* context(record.threadId);
        yield* preparation.prepare({
          threadId: record.threadId,
          projectId: project.id,
          worktreePath: record.target.path,
          branch: record.observed.branch,
          retry: true,
        });
      }
      const completed = yield* locked(
        record,
        Effect.gen(function* () {
          const { project } = yield* checkContext(record);
          const checkout = yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            record.target.path,
            record.observed?.branch,
          );
          if (digest(identity(checkout)) !== digest(record.observed))
            return yield* Effect.fail(
              new Error("The checkout changed before workspace commit. Inspect it to continue."),
            );
          yield* validateClaims(
            record,
            record.target.path,
            record.intent === "checkout_branch" || record.intent === "create_branch_and_checkout",
          );
          return yield* commit(record, checkout);
        }),
      );
      if (completed.intent === "move_to_new_worktree")
        return yield* locked(completed, releaseMoveRef(completed));
      return completed;
    });
  const resumeMissingPause = (record: WorkspaceTransitionSnapshot) =>
    Effect.gen(function* () {
      if (
        record.phase !== "completed" ||
        !["recreate", "recreate_from_base", "use_project_checkout"].includes(record.intent)
      )
        return;
      const state = (yield* queue.listByThread(record.threadId)).state;
      if (state.paused && state.pauseReasonCode === "worktree_missing")
        yield* queue.setPaused({
          threadId: record.threadId,
          paused: false,
          expectedRevision: state.revision,
        });
    }).pipe(Effect.catch(() => Effect.void));
  const start = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const existing = workers.get(record.operationId);
      if (existing) return yield* Deferred.await(existing.result);
      const result = yield* Deferred.make<WorkspaceTransitionSnapshot, Error>();
      const work = apply(record).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const live = yield* currentRecord(record.operationId);
            if (
              live.phase === "needs_recovery" &&
              live.error === "Workspace recovery was cancelled. Inspect it before continuing."
            )
              return live;
            const failure = Cause.squash(cause);
            if (live.intent === "move_to_new_worktree") {
              if (live.phase === "completed" || live.phase === "cancelled") return live;
              const message = failure instanceof Error ? failure.message : String(failure);
              return yield* rollbackMove(live, message).pipe(
                Effect.catch((error) =>
                  currentRecord(live.operationId).pipe(
                    Effect.flatMap((current) =>
                      store.update(current, {
                        phase: "needs_recovery",
                        error: `${message} Cleanup needs attention: ${error.message}`,
                      }),
                    ),
                  ),
                ),
              );
            }
            const conflict = Schema.is(GitCommandError)(failure)
              ? failure.checkoutConflict
              : undefined;
            let definitelyUnchanged = !live.mutationAttempted && live.phase !== "applied";
            if (live.intent === "checkout_branch" && conflict) {
              const actual = yield* locked(live, inspect(live.source.path)).pipe(Effect.option);
              definitelyUnchanged =
                Option.isSome(actual) && digest(identity(actual.value)) === digest(live.source);
            }
            if (transitionIsActive(live))
              return yield* store.update(live, {
                phase: definitelyUnchanged ? "failed" : "needs_recovery",
                mutationAttempted: definitelyUnchanged ? false : live.mutationAttempted,
                ...(conflict ? { checkoutConflict: conflict } : {}),
                ...(failure instanceof WorkspaceRequiresNewWorktreeError
                  ? { errorCode: failure.code }
                  : {}),
                error: failure instanceof Error ? failure.message : String(failure),
              });
            return live;
          }),
        ),
        Effect.tap(resumeMissingPause),
        Effect.tap((value) => Deferred.succeed(result, value)),
        Effect.catch((error) => Deferred.fail(result, error)),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            workers.delete(record.operationId);
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            const live = yield* store
              .get(record.operationId)
              .pipe(Effect.orElseSucceed(() => null));
            if (live && ["cancelled", "needs_recovery"].includes(live.phase))
              yield* Deferred.succeed(result, live);
            else
              yield* Deferred.fail(
                result,
                new Error(
                  "The workspace worker stopped. Inspect the transition before continuing.",
                ),
              );
          }),
        ),
        Effect.ensuring(dispatcher.notify(record.threadId).pipe(Effect.ignore)),
      );
      const fiber = yield* Effect.forkIn(work, scope, { startImmediately: false });
      workers.set(record.operationId, { fiber, result });
      yield* dispatcher.notify(record.threadId);
      return yield* Deferred.await(result);
    });
  const switchWorkspace: WorkspaceTransitionShape["switchWorkspace"] = (input, setupOwnerToken) =>
    Effect.gen(function* () {
      const request = {
        ...input,
        ...(input.targetPath ? { targetPath: yield* canonicalWorkspace(input.targetPath) } : {}),
        sharedFilesystemConfirmed: input.sharedFilesystemConfirmed ?? false,
      };
      const requestHash = digest(request);
      const existing = yield* store.get(input.operationId);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.threadId !== input.threadId)
          return yield* Effect.fail(new Error("This operation ID belongs to another request."));
        const worker = workers.get(input.operationId);
        return worker ? yield* Deferred.await(worker.result) : existing;
      }
      const { thread, project } = yield* context(input.threadId);
      // Branches and worktrees belong to a Git checkout; a thread without a project has neither.
      if (isScratchProject(project))
        return yield* Effect.fail(new Error("Threads without a project have no branch to switch."));
      const queueState = (yield* queue.listByThread(thread.id)).state;
      if (
        setupOwnerToken &&
        queueState.worktreeBlockToken !== null &&
        queueState.worktreeBlockToken !== setupOwnerToken
      )
        return yield* Effect.fail(new Error("Workspace setup ownership changed."));
      if (
        (yield* setup.check(
          thread.id,
          (yield* queue.listByThread(thread.id)).state.worktreeBlockToken,
        )) === "gating" &&
        !setupOwnerToken
      )
        return yield* Effect.fail(new Error("Workspace setup is in progress."));
      const repository = yield* git
        .resolveCommonDir(project.workspaceRoot)
        .pipe(Effect.flatMap(canonicalWorkspace));
      const sourcePath = yield* canonicalWorkspace(
        threadWorkspaceCwd(thread, project) ?? project.workspaceRoot,
      );
      // Missing sources are supported by recovery; all other inspection errors remain blocking.
      const source = yield* inspect(sourcePath).pipe(
        Effect.map(identity),
        Effect.catch((error) =>
          ["recreate", "recreate_from_base", "use_project_checkout"].includes(input.intent) &&
          thread.worktreePath !== null
            ? Effect.succeed({ path: sourcePath, repository, branch: thread.branch, headSha: null })
            : Effect.fail(error),
        ),
      );
      if (source.repository !== repository)
        return yield* Effect.fail(new Error("The source belongs to another repository."));
      let target = source;
      let baseRef: string | undefined;
      if (input.intent === "move_to_new_worktree") {
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.operationId))
          return yield* Effect.fail(new Error("Invalid move operation ID."));
        if (thread.worktreePath !== null)
          return yield* Effect.fail(
            new Error("Only a local conversation can be moved to a new worktree."),
          );
        if (!source.headSha)
          return yield* Effect.fail(
            new Error("Commit to the project checkout before moving this conversation."),
          );
        let branch = input.branch;
        if (branch) {
          if (!(yield* git.isValidBranchName(branch)) || /^t3code\/[0-9a-f]{8}$/i.test(branch))
            return yield* Effect.fail(new Error("Invalid branch name."));
          if (yield* git.branchExists(project.workspaceRoot, branch))
            return yield* Effect.fail(new Error(`Branch '${branch}' already exists.`));
        } else {
          const first = thread.messages.find((message) => message.role === "user");
          const namingSettings = Option.isSome(settings)
            ? (yield* readProjectSettings(yield* settings.value.getSettings, project)).settings
            : null;
          const generated =
            Option.isSome(textGeneration) &&
            first &&
            (first.text.trim() || (first.attachments?.length ?? 0) > 0)
              ? yield* textGeneration.value
                  .generateBranchName({
                    cwd: project.workspaceRoot,
                    message: first.text,
                    attachments: first.attachments,
                    ...(namingSettings
                      ? {
                          modelSelection: namingSettings.textGenerationModelSelection,
                          writingPreferences: namingSettings.sourceControlWriting,
                        }
                      : {}),
                  })
                  .pipe(Effect.timeout("3 seconds"), Effect.option)
              : Option.none();
          branch = Option.isSome(generated)
            ? yield* git.resolveAvailableBranchName(
                project.workspaceRoot,
                buildGeneratedWorktreeBranchName(
                  generated.value.branch,
                  namingSettings?.sourceControlWriting.branchNamePrefix ?? "f5",
                ),
              )
            : `t3code/${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
        }
        target = {
          path: yield* canonicalWorkspace(
            yield* git.allocateWorktreePath({ cwd: project.workspaceRoot, branch }),
          ),
          repository,
          branch,
          headSha: source.headSha,
        };
      } else if (input.intent === "attach_existing" || input.intent === "use_project_checkout") {
        const path =
          input.intent === "use_project_checkout" ? project.workspaceRoot : input.targetPath;
        if (!path) return yield* Effect.fail(new Error("Choose a checkout."));
        target = identity(
          yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            path,
            input.intent === "attach_existing" ? input.branch : undefined,
          ),
        );
      } else if (input.intent === "recreate_from_base") {
        const base =
          (yield* git.readDefaultBranch(project.workspaceRoot)) ??
          (yield* git.inspectCheckoutIdentity(project.workspaceRoot)).branch;
        const sha = base ? yield* git.resolveCommit(project.workspaceRoot, base) : null;
        if (!sha) return yield* Effect.fail(new Error("No committed recovery base is available."));
        const branch =
          thread.branch && !(yield* git.branchExists(project.workspaceRoot, thread.branch))
            ? thread.branch
            : `t3code/${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
        baseRef = base!;
        const managed = yield* canonicalWorkspace(config.worktreesDir);
        const missing = yield* Effect.tryPromise({
          try: async () => {
            try {
              await lstat(sourcePath);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
              throw error;
            }
          },
          catch: (error) => new WorkspaceTransitionError(String(error)),
        });
        target = {
          path:
            missing && sourcePath !== managed && pathContains(managed, sourcePath)
              ? sourcePath
              : yield* git.allocateWorktreePath({ cwd: project.workspaceRoot, branch }),
          repository,
          branch,
          headSha: sha,
        };
      } else if (input.intent === "checkout_branch") {
        if (!input.branch) return yield* Effect.fail(new Error("Choose a branch."));
        const planned = yield* git.resolveCheckoutTarget({
          cwd: source.path,
          branch: input.branch,
        });
        if (!planned.branch || !planned.headSha)
          return yield* Effect.fail(
            new WorkspaceRequiresNewWorktreeError(
              "The branch is unavailable or would detach this checkout. Create a new worktree instead.",
            ),
          );
        target = { ...source, branch: planned.branch, headSha: planned.headSha };
      } else if (input.intent === "create_branch_and_checkout")
        target = { ...source, branch: input.branch ?? null };
      const at = new Date().toISOString();
      const proposed: WorkspaceTransitionRecord = {
        operationId: input.operationId,
        threadId: input.threadId,
        version: 0,
        intent: input.intent,
        phase: "reserved",
        request,
        requestHash,
        ...(baseRef ? { baseRef } : {}),
        source,
        target,
        observed: null,
        fingerprint: null,
        mutationAttempted: false,
        error: null,
        result: null,
        setupOwnerToken: setupOwnerToken ? queueState.worktreeBlockToken : null,
        ...(setupOwnerToken ? { setupOwnerOperationId: setupOwnerToken } : {}),
        commandId: `workspace:${input.operationId}`,
        createdAt: at,
        updatedAt: at,
      };
      const record = yield* locked(proposed, store.reserve(proposed));
      return yield* start(record);
    });
  const recoveryInspection = (record: WorkspaceTransitionRecord) =>
    Effect.gen(function* () {
      const actual = yield* git
        .inspectCheckout(record.observed?.path ?? record.target.path, { recoveryFingerprint: true })
        .pipe(Effect.option);
      const original = yield* git
        .inspectCheckout(record.source.path, { recoveryFingerprint: true })
        .pipe(Effect.option);
      const { project } = yield* context(record.threadId);
      const projectCheckout = yield* git
        .inspectCheckout(project.workspaceRoot, { recoveryFingerprint: true })
        .pipe(Effect.option);
      const token = digest({
        secret,
        version: record.version,
        operationId: record.operationId,
        actual: Option.getOrNull(actual),
        original: Option.getOrNull(original),
        projectCheckout: Option.getOrNull(projectCheckout),
      });
      return {
        actual: Option.getOrNull(actual),
        original: Option.getOrNull(original),
        projectCheckout: Option.getOrNull(projectCheckout),
        token,
      };
    });
  const previewRecovery: WorkspaceTransitionShape["previewRecovery"] = ({ operationId }) =>
    Effect.gen(function* () {
      const record = yield* currentRecord(operationId);
      const inspected = yield* locked(record, recoveryInspection(record));
      return {
        transition: workspaceTransitionSnapshot(record),
        actual: inspected.actual ? identity(inspected.actual) : null,
        original: inspected.original ? identity(inspected.original) : null,
        projectCheckout: inspected.projectCheckout ? identity(inspected.projectCheckout) : null,
        acceptanceToken: inspected.token,
        canRetry: !record.mutationAttempted && !workers.has(record.operationId),
        blockedReasons: inspected.actual ? [] : ["The target checkout could not be verified."],
      };
    });
  const resolve: WorkspaceTransitionShape["resolve"] = (input) =>
    Effect.gen(function* () {
      let record = yield* currentRecord(input.operationId);
      if (workers.has(record.operationId))
        return yield* Effect.fail(new Error("The workspace worker is still running."));
      if (record.version !== input.version || !["needs_recovery", "failed"].includes(record.phase))
        return yield* Effect.fail(new Error("The transition changed. Preview recovery again."));
      if (input.action !== "retry") {
        if (record.phase === "failed")
          return yield* Effect.fail(
            new Error("Retry this pre-mutation failure or start a new workspace switch."),
          );
        // Closing an idle session and waiting for its projection must happen outside all lifecycle locks.
        yield* stop(record);
      }
      let retry = false;
      const resolved = yield* locked(
        record,
        Effect.gen(function* () {
          record = yield* currentRecord(input.operationId);
          if (
            record.version !== input.version ||
            !["needs_recovery", "failed"].includes(record.phase)
          )
            return yield* Effect.fail(new Error("The transition changed. Preview recovery again."));
          const inspected = yield* recoveryInspection(record);
          if (inspected.token !== input.acceptanceToken)
            return yield* Effect.fail(new Error("The checkout changed. Preview recovery again."));
          if (record.intent === "move_to_new_worktree" && input.action !== "retry") {
            if (input.action === "accept_inspected_workspace") {
              if (
                !inspected.actual ||
                inspected.actual.canonicalRoot !== record.target.path ||
                !record.moveData ||
                !sameMoveSnapshot(
                  yield* git.readMoveSnapshot(record.target.path),
                  record.moveData.snapshot,
                )
              )
                return yield* Effect.fail(
                  new Error(
                    "The move copy is incomplete or changed. Keep the original workspace instead.",
                  ),
                );
              const { project } = yield* checkContext(record);
              yield* inspectAttachableWorkspace(
                git,
                config,
                project.workspaceRoot,
                record.target.path,
                record.target.branch,
              );
              yield* validateClaims(record, record.target.path, false);
              return yield* releaseMoveRef(yield* commit(record, inspected.actual));
            }
            const original =
              input.action === "use_project_checkout"
                ? inspected.projectCheckout
                : inspected.original;
            if (
              !original ||
              original.canonicalRoot !== record.source.path ||
              original.commonDir !== record.source.repository ||
              (input.action === "keep_original_workspace" &&
                digest(identity(original)) !== digest(record.source))
            )
              return yield* Effect.fail(
                new Error(
                  "The original checkout no longer matches its recorded identity. No files were restored.",
                ),
              );
            yield* checkContext(record);
            const rolledBack = yield* rollbackMove(
              record,
              "Kept the original workspace.",
              "needs_recovery",
            );
            const completed = yield* commit(rolledBack, original);
            return rolledBack.error?.includes(" Retained ")
              ? yield* store.update(completed, { error: rolledBack.error })
              : completed;
          }
          if (input.action === "retry") {
            if (record.mutationAttempted)
              return yield* Effect.fail(
                new Error(
                  "The Git outcome may be partial. Accept a verified workspace instead of repeating Git.",
                ),
              );
            if (record.intent === "move_to_new_worktree") record = yield* releaseMoveRef(record);
            record = yield* store.reactivate(record);
            retry = true;
            return record;
          }
          const selected =
            input.action === "keep_original_workspace"
              ? inspected.original
              : input.action === "use_project_checkout"
                ? inspected.projectCheckout
                : inspected.actual;
          if (!selected)
            return yield* Effect.fail(new Error("The selected checkout is unavailable."));
          if (
            input.action === "keep_original_workspace" &&
            (selected.commonDir !== record.source.repository ||
              selected.branch !== record.source.branch ||
              selected.headSha !== record.source.headSha)
          )
            return yield* Effect.fail(
              new Error(
                "The original checkout no longer matches its recorded identity. No files were restored.",
              ),
            );
          const { project } = yield* checkContext(record);
          yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            selected.canonicalRoot,
            selected.branch,
          );
          yield* validateClaims(
            input.action === "use_project_checkout"
              ? { ...record, intent: "use_project_checkout" }
              : record,
            selected.canonicalRoot,
            false,
          );
          return yield* commit(record, selected);
        }),
      );
      const result = retry ? yield* start(resolved) : resolved;
      yield* resumeMissingPause(result);
      yield* dispatcher.notify(record.threadId);
      return result;
    });
  const cancel: WorkspaceTransitionShape["cancel"] = (threadId, retainBarrier = false) =>
    Effect.gen(function* () {
      const record = yield* store.forThread(threadId);
      if (!record) return;
      if (retainBarrier && transitionIsActive(record))
        yield* store.update(record, {
          phase: "needs_recovery",
          error: "Workspace recovery was cancelled. Inspect it before continuing.",
        });
      else yield* store.cancel(threadId);
      const worker = workers.get(record.operationId);
      if (worker) yield* Fiber.interrupt(worker.fiber);
      const latest = yield* currentRecord(record.operationId);
      if (
        !retainBarrier &&
        latest.intent === "move_to_new_worktree" &&
        latest.phase === "cancelled"
      )
        yield* releaseRetainedMove(latest);
    });
  yield* store.reconcile;
  for (const initial of yield* store.unfinishedMoves) {
    const model = yield* engine.getReadModel();
    const thread = model.threads.find((entry) => entry.id === initial.threadId);
    if (
      !thread ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      initial.phase === "cancelled"
    ) {
      yield* releaseRetainedMove(initial).pipe(
        Effect.catch((error) => Effect.logWarning("Cancelled move retained artifacts", error)),
      );
      continue;
    }
    yield* withOwner(
      initial.operationId,
      Effect.gen(function* () {
        let record = initial;
        if (thread.worktreePath === record.target.path && thread.branch === record.target.branch) {
          if (record.phase !== "completed")
            record = yield* store.update(record, { phase: "completed", error: null });
          yield* locked(record, releaseMoveRef(record));
        } else if (transitionIsActive(record)) {
          yield* rollbackMove(
            record,
            "Move interrupted before workspace commit; the project checkout was kept.",
          );
        } else yield* locked(record, releaseMoveRef(record));
      }),
    ).pipe(Effect.catch((error) => Effect.logWarning("Move recovery retained artifacts", error)));
  }
  yield* Effect.forkIn(
    Stream.runForEach(engine.streamDomainEvents, (event) => {
      if (event.type !== "thread.archived" && event.type !== "thread.deleted") return Effect.void;
      return cancel(event.payload.threadId).pipe(Effect.ignore);
    }),
    scope,
    { startImmediately: true },
  );
  const moveThread: WorkspaceTransitionShape["moveThread"] = (input) =>
    Effect.gen(function* () {
      const { thread } = yield* context(input.threadId);
      const operationId = crypto.randomUUID();
      const result = yield* withOwner(
        operationId,
        switchWorkspace({
          operationId,
          threadId: input.threadId,
          intent: "move_to_new_worktree",
          expected: {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            sessionUpdatedAt: thread.session?.updatedAt ?? null,
          },
          ...(input.branch ? { branch: input.branch } : {}),
        }),
      );
      if (result.phase !== "completed" || !result.result?.worktreePath || !result.result.branch)
        return yield* Effect.fail(
          new Error(result.error ?? "Move did not complete. Inspect the workspace transition."),
        );
      return {
        operationId,
        branch: result.result.branch,
        worktreePath: result.result.worktreePath,
        copiedFileCount: result.move?.copiedFileCount ?? 0,
      };
    });
  const discardMovedChanges: WorkspaceTransitionShape["discardMovedChanges"] = (input) =>
    Effect.gen(function* () {
      const record = yield* currentRecord(input.operationId);
      if (
        record.threadId !== input.threadId ||
        record.intent !== "move_to_new_worktree" ||
        record.phase !== "completed" ||
        !record.moveData
      )
        return yield* Effect.fail(
          new Error("No completed move is available for this conversation."),
        );
      return yield* locked(
        record,
        Effect.gen(function* () {
          let current = yield* currentRecord(record.operationId);
          const { thread, project } = yield* context(record.threadId);
          if (thread.worktreePath !== record.target.path || thread.branch !== record.target.branch)
            return yield* Effect.fail(
              new Error("The conversation workspace changed after the move."),
            );
          if (current.moveData!.discarded) return { discarded: true };
          if (current.moveData!.discardStarted)
            return yield* Effect.fail(
              new Error(
                "Discard was interrupted. Inspect the project checkout and saved stashes manually.",
              ),
            );
          const usage = yield* claims(project.workspaceRoot);
          if (
            usage.unknown ||
            usage.sessions.length ||
            usage.terminals.length ||
            usage.activeThreadIds.length ||
            usage.queuedThreadIds.length ||
            usage.transitionThreadIds.length ||
            usage.setupThreadIds.some((id) => id !== record.threadId)
          )
            return yield* Effect.fail(
              new Error(
                "Another session, terminal, or operation uses the project checkout. Stop it before discarding.",
              ),
            );
          yield* Effect.tryPromise({
            try: () => assertExclusiveProfileCheckout(config, record.source.path),
            catch: (cause) =>
              new WorkspaceTransitionError(cause instanceof Error ? cause.message : String(cause)),
          });
          const sourceCheckout = yield* inspect(record.source.path);
          if (
            (yield* canonicalWorkspace(project.workspaceRoot)) !== record.source.path ||
            sourceCheckout.commonDir !== record.source.repository ||
            sourceCheckout.branch !== record.source.branch
          )
            return yield* Effect.fail(
              new Error("The project checkout changed after the move; discard manually."),
            );
          const actual = yield* git.readMoveSnapshot(record.source.path);
          if (
            (yield* git.readOperationInProgress(record.source.path)) ||
            !sameMoveSnapshot(actual, current.moveData!.snapshot)
          )
            return yield* Effect.fail(
              new Error("The project checkout changed after the move; discard manually."),
            );
          const stashBefore = yield* git.resolveCommit(record.source.path, "refs/stash");
          current = yield* store.update(current, {
            moveData: { ...current.moveData!, discardStarted: true },
          });
          yield* git
            .stashPushAll(
              record.source.path,
              `f5: copied to ${record.target.branch} (${record.operationId})`,
            )
            .pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const snapshot = yield* git
                    .readMoveSnapshot(record.source.path)
                    .pipe(Effect.option);
                  const stashAfter = yield* git
                    .resolveCommit(record.source.path, "refs/stash")
                    .pipe(Effect.option);
                  if (
                    Option.isSome(snapshot) &&
                    Option.isSome(stashAfter) &&
                    stashAfter.value === stashBefore &&
                    sameMoveSnapshot(snapshot.value, current.moveData!.snapshot)
                  )
                    current = yield* store.update(current, {
                      moveData: { ...current.moveData!, discardStarted: false },
                    });
                  return yield* Effect.fail(error);
                }),
              ),
            );

          yield* store.update(current, {
            moveData: { ...current.moveData!, discarded: true },
            move: { copiedFileCount: current.move!.copiedFileCount, discarded: true },
          });
          return { discarded: true };
        }),
      );
    });
  return {
    moveThread,
    discardMovedChanges,
    switchWorkspace: (input, owner) =>
      withOwner(input.operationId, switchWorkspace(input, owner)).pipe(
        Effect.map((record) => workspaceTransitionSnapshot(record)),
      ),
    getTransition: ({ threadId }) =>
      readTransition(threadId).pipe(
        Effect.map((record) => (record ? workspaceTransitionSnapshot(record) : null)),
      ),
    previewRecovery,
    resolve: (input) =>
      withOwner(input.operationId, resolve(input)).pipe(
        Effect.map((record) => workspaceTransitionSnapshot(record)),
      ),
    cancel,
  } satisfies WorkspaceTransitionShape;
});
export const WorkspaceTransitionLive = Layer.effect(WorkspaceTransition, makeWorkspaceTransition);
