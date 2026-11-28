import { isScratchProject } from "@t3tools/shared/scratchProject";
import { readManagedWorktreesDirectories } from "../../worktreesDirectory.ts";
import {
  buildFinalBranchName,
  buildPlaceholderBranchName,
  isPlaceholderBranch,
  PLACEHOLDER_BRANCH_RESERVED_MESSAGE,
} from "@t3tools/shared/branchNaming";
import { resolvePlaceholderBranch } from "../../git/placeholderBranch.ts";
import { makeBranchNamePrefixReader, readBranchNamePrefix } from "../branchNamePrefix.ts";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readProjectSettings } from "../projectSettings.ts";
import { sameMoveSnapshot, isMoveCopySnapshot } from "../../git/moveSnapshot.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { WorkspaceRequiresNewWorktreeError } from "../../git/workspaceSwitch.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { lstat } from "node:fs/promises";
import { canonicalJsonHash } from "../../canonicalJsonHash.ts";
import {
  CommandId,
  type ThreadId,
  type WorkspaceCheckoutIdentity,
  type WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore, type CheckoutInspection } from "../../git/Services/GitCore.ts";
import {
  WorkspaceTransitions,
  WorkspaceTransitionError,
  workspaceTransitionSnapshot,
  transitionIsActive,
  transitionIsUnsettled,
  type WorkspaceTransitionRecord,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { assertExclusiveProfileCheckout } from "../../profiles/RepositorySharing.ts";
import {
  captureOptionalClaimServices,
  readWorktreeClaims,
  evaluateWorktreeRemoval,
  formatInPlaceSwitchBlockers,
  inPlaceSwitchBlockers,
} from "../worktreeClaims.ts";
import { canonicalWorkspace, inspectAttachableWorkspace } from "../workspaceAttachment.ts";
import { syncObservedCheckout } from "../observedBranch.ts";
import { findRemoteBranch } from "../worktreeReadiness.ts";
import { WorkspaceWriteContext } from "../workspaceTransitionContext.ts";
import { appendWorkspaceNote } from "../workspaceNotes.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import {
  WORKSPACE_SWITCH_CANCELLED,
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
const INTERRUPTED = "The workspace switch was interrupted before it finished.";
/** How long a read waits for an interrupted switch to settle before it answers anyway. */
const ORPHAN_READ_WAIT = "2 seconds";
interface SettleOptions {
  /** Why the switch stopped. Kept on the row and returned to whoever started it. */
  readonly reason: string;
  /** What an unfinished switch becomes: `failed` for an error or a crash, `cancelled` on request. */
  readonly phase: "failed" | "cancelled";
  /** Nobody is waiting for the result, so the thread's timeline reports it. */
  readonly announce: boolean;
  readonly patch?: Pick<Partial<WorkspaceTransitionRecord>, "checkoutConflict" | "errorCode">;
}
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const keptText = (record: WorkspaceTransitionSnapshot, kept: ReadonlyArray<string>) =>
  kept.length ? ` Kept ${folderName(record.target.path)}: ${kept.join("; ")}.` : "";
const finishedSummary = (record: WorkspaceTransitionSnapshot) => {
  const branch = record.result?.branch ?? record.target.branch;
  if (record.intent === "recreate" || record.intent === "recreate_from_base")
    return branch ? `Worktree restored on ${branch}` : "Worktree restored";
  return branch ? `Switched to ${branch}` : "Workspace switch finished";
};
const unfinishedSummary = (record: WorkspaceTransitionSnapshot) => {
  switch (record.intent) {
    case "move_to_new_worktree":
      return "Moving this thread to a new worktree did not finish; it stays in the project folder.";
    case "use_project_checkout":
      return "Moving this thread to the project folder did not finish; it stays where it was.";
    case "attach_existing":
      return `Switching to ${folderName(record.target.path)} did not finish; this thread stays where it was.`;
    case "checkout_branch":
    case "create_branch_and_checkout":
      return `Switching to ${record.target.branch ?? "another branch"} did not finish.`;
    case "recreate":
    case "recreate_from_base":
      return "Restoring the worktree did not finish.";
  }
};
/** `<remote>/<branch>` as a base means the branch was restored from its remote copy. */
const remoteBranchOf = (baseRef: string | undefined, branch: string | null) =>
  baseRef && branch && baseRef.endsWith(`/${branch}`) && baseRef.length > branch.length + 1
    ? { remote: baseRef.slice(0, -branch.length - 1) }
    : null;
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
  // Transition claims read settlement hooks and transition rows as before this
  // capture existed: not here, so a stale row cannot block returning to Local.
  const withClaimServices = yield* captureOptionalClaimServices({ includeSql: false });
  const textGeneration = yield* Effect.serviceOption(TextGeneration);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  /** Operations `cancel` is stopping; it settles them and answers their callers itself. */
  const cancelling = new Set<string>();
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
  /** Nobody is working on this row: no worker runs it and no caller is about to start one. */
  const orphaned = (record: WorkspaceTransitionRecord) =>
    transitionIsUnsettled(record) &&
    !workers.has(record.operationId) &&
    !owners.has(record.operationId);
  /**
   * Settling takes the folder's locks and reads Git. A new switch waits for it
   * however long it takes. A plain read waits only briefly: behind an unrelated
   * long worktree operation in the same repository it returns the row as it
   * is, the settling carries on, and everyone watching the thread is notified
   * once it is done.
   */
  const readTransition = (threadId: ThreadId, wait: "settled" | "briefly") =>
    Effect.gen(function* () {
      const record = yield* store.forThread(threadId);
      if (!record || !orphaned(record)) return record;
      if (wait === "settled") return yield* settleOrphan(record);
      const settling = yield* Effect.forkIn(Effect.exit(settleOrphan(record)), scope, {
        startImmediately: true,
      });
      const exit = yield* Fiber.join(settling).pipe(Effect.timeoutOption(ORPHAN_READ_WAIT));
      if (Option.isNone(exit)) return record;
      return Exit.isSuccess(exit.value)
        ? exit.value.value
        : yield* Effect.failCause(exit.value.cause);
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
  const claims = (path: string) =>
    withClaimServices(readWorktreeClaims(path).pipe(Effect.provideServices(services)));
  const validateClaims = (record: WorkspaceTransitionRecord, path: string, inPlace: boolean) =>
    Effect.gen(function* () {
      const usage = yield* claims(path);
      if (usage.unknown)
        return yield* Effect.fail(new Error("Workspace usage could not be verified."));
      const foreign = usage.threadIds.filter((id) => id !== record.threadId);
      if (inPlace) {
        const blockers = inPlaceSwitchBlockers(usage, { requester: record.threadId });
        if (blockers.length) {
          const model = yield* engine.getReadModel();
          return yield* Effect.fail(
            new WorkspaceRequiresNewWorktreeError(
              formatInPlaceSwitchBlockers(
                blockers,
                (id) => model.threads.find((thread) => thread.id === id)?.title ?? null,
              ),
            ),
          );
        }
      }
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
  const releaseRetainedMove = (
    initial: WorkspaceTransitionRecord,
    /** Why the move stopped, when the caller knows more than "it did not finish". */
    reason?: string,
  ) =>
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
            error:
              reason ??
              `The move did not finish. Kept ${folderName(record.target.path)}${record.target.branch ? ` on ${record.target.branch}` : ""}; the project folder is unchanged.`,
          });
        return yield* releaseMoveRef(record, repository);
      }),
    );
  // Only byte-for-byte copies are disposable. The shared gate still protects ignored files,
  // foreign claims, changed commits, registration and creation ownership.
  const rollbackMove = (
    initial: WorkspaceTransitionRecord,
    message: string,
    phase: "failed" | "cancelled" = "failed",
  ) =>
    locked(
      initial,
      Effect.gen(function* () {
        let record = yield* currentRecord(initial.operationId);
        const retained: string[] = [];
        // Someone else finished or ended the move while this waited for the locks.
        if (!transitionIsUnsettled(record)) return { record, kept: retained, changed: false };
        const move = record.moveData;
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
              checked.blockedReasons.push("another thread or process uses the new worktree");
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
            if (!removed) retained.push("the new branch changed and was kept");
          } else if (
            !retained.length &&
            record.target.branch &&
            (yield* git.branchExists(record.source.path, record.target.branch))
          ) {
            retained.push(
              `branch ${record.target.branch} was not created by this move and was kept`,
            );
          }
        }
        record = yield* releaseMoveRef(record);
        record = yield* store.update(record, {
          phase,
          // The reason is often a raw Git error with no full stop of its own.
          error:
            (retained.length && !/[.!?]$/.test(message) ? `${message}.` : message) +
            keptText(record, retained),
        });
        return { record, kept: retained, changed: true };
      }),
    );
  /** Ends a row that is still unsettled; one that someone else ended is returned as it is. */
  const end = (operationId: string, patch: Parameters<typeof store.update>[1]) =>
    currentRecord(operationId).pipe(
      Effect.flatMap((current) =>
        transitionIsUnsettled(current) ? store.update(current, patch) : Effect.succeed(current),
      ),
    );
  /**
   * Settles a switch that changes Git in the thread's folder or restores a
   * worktree: if Git shows the change happened, the thread record is committed
   * to it; otherwise the switch did not happen and the record is untouched.
   * Attaching and returning to the project folder never change Git, so without
   * an accepted metadata write they did not happen.
   */
  const settleInFolder = (initial: WorkspaceTransitionRecord, options: SettleOptions) =>
    locked(
      initial,
      Effect.gen(function* () {
        let record = yield* currentRecord(initial.operationId);
        // Someone else finished or ended the switch while this waited for the locks.
        if (!transitionIsUnsettled(record)) return { record, changed: false };
        const inPlace =
          record.intent === "checkout_branch" || record.intent === "create_branch_and_checkout";
        const restoring = record.intent === "recreate" || record.intent === "recreate_from_base";
        if (record.mutationAttempted && (inPlace || restoring)) {
          const { project } = yield* context(record.threadId);
          const checkout = yield* inspectAttachableWorkspace(
            git,
            config,
            project.workspaceRoot,
            record.target.path,
          ).pipe(Effect.option);
          // An in-place switch changed the thread's own folder, so the record
          // follows Git whatever else is true. A restore is recorded only for
          // the checkout it asked for: on its branch, prepared for this thread,
          // and free of the claims a finished switch checks before it commits.
          // Anything else at that path is left alone and the switch did not happen.
          const accepted =
            Option.isSome(checkout) &&
            checkout.value.branch === record.target.branch &&
            (inPlace ||
              ((yield* git
                .readWorktreePreparation(record.target.path)
                .pipe(Effect.orElseSucceed(() => null)))?.owner === `thread:${record.threadId}` &&
                Exit.isSuccess(
                  yield* validateClaims(record, record.target.path, false).pipe(Effect.exit),
                )));
          if (accepted && Option.isSome(checkout)) {
            // A row an older version parked is active again only for this commit.
            if (record.phase === "needs_recovery")
              record = yield* store.update(record, { phase: "applying" });
            // A commit that is refused, or that dies, leaves the thread where it was.
            const committed = yield* commit(record, checkout.value).pipe(Effect.exit);
            if (Exit.isSuccess(committed) && committed.value.phase === "completed")
              return { record: committed.value, changed: true };
          }
        }
        return {
          record: yield* end(record.operationId, {
            phase: options.phase,
            error: options.reason,
            ...options.patch,
          }),
          changed: true,
        };
      }),
    );
  /**
   * Brings an unfinished switch to "done" or "not done" and never leaves it in
   * between: the thread record is always the old workspace or the new one, so a
   * row that ended holds nothing. Nothing is asked; a switch nobody is waiting
   * on, and anything a move had to leave behind, is reported in the timeline.
   */
  const settle = (stale: WorkspaceTransitionRecord, options: SettleOptions) =>
    Effect.gen(function* () {
      // The caller may hold a copy read before someone else settled the row.
      const initial = yield* currentRecord(stale.operationId);
      if (!transitionIsUnsettled(initial)) return initial;
      let kept: ReadonlyArray<string> = [];
      const decided =
        initial.intent === "move_to_new_worktree"
          ? Effect.gen(function* () {
              // An archived or deleted thread keeps its copy; only the private ref is released.
              if (Option.isNone(yield* context(initial.threadId).pipe(Effect.option)))
                return { record: yield* releaseRetainedMove(initial), changed: true };
              const rolledBack = yield* rollbackMove(initial, options.reason, options.phase);
              kept = rolledBack.kept;
              return rolledBack;
            })
          : settleInFolder(initial, options);
      // Settling can fail too (Git, the locks, a thread that is gone). The row still
      // ends, because the thread record already names a workspace that exists.
      const { record: settled, changed } = yield* decided.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const failure = Cause.squash(cause);
          const detail = failure instanceof Error ? failure.message : String(failure);
          const ended = end(initial.operationId, {
            phase: "cancelled",
            error: `${options.reason} ${detail}`,
          }).pipe(Effect.map((record) => ({ record, changed: true })));
          if (initial.intent !== "move_to_new_worktree") return ended;
          if (initial.mutationAttempted) kept = [`it could not be cleaned up (${detail})`];
          // The copy stays for the user; only the private snapshot ref is released.
          // The row keeps why the move stopped and why it could not be cleaned
          // up; whether the copy is still there is not known at this point.
          const stopped = /[.!?]$/.test(options.reason) ? options.reason : `${options.reason}.`;
          const target = `${folderName(initial.target.path)}${initial.target.branch ? ` on ${initial.target.branch}` : ""}`;
          return releaseRetainedMove(
            initial,
            initial.mutationAttempted
              ? `${stopped} Cleaning up failed (${detail}), so ${target} may still be there. The project folder is unchanged.`
              : `${stopped} ${detail}`,
          ).pipe(
            Effect.map((record) => ({ record, changed: true })),
            Effect.catchCause(() => ended),
          );
        }),
      );
      // Someone else settled it first, and reported it: say nothing twice.
      if (!changed) return settled;
      if (settled.phase === "completed") {
        if (options.announce)
          yield* appendWorkspaceNote(engine, settled.threadId, {
            summary: finishedSummary(settled),
          });
        // The folder is on the new branch, or the worktree is back, and the
        // caller is told it worked: say what was refused or failed after that.
        else if (options.phase === "failed")
          yield* appendWorkspaceNote(engine, settled.threadId, {
            tone: "error",
            summary: `${finishedSummary(settled)}, but a later step failed: ${options.reason}`,
          });
      } else if (options.announce || kept.length)
        yield* appendWorkspaceNote(engine, settled.threadId, {
          tone: "error",
          summary: unfinishedSummary(settled) + keptText(settled, kept),
        });
      yield* resumeMissingPause(settled);
      yield* dispatcher.notify(settled.threadId).pipe(Effect.ignore);
      return settled;
    });
  /** Settles a row nobody is working on, holding it so a concurrent reader does not start too. */
  const settleOrphan = (record: WorkspaceTransitionRecord) =>
    withOwner(
      record.operationId,
      settle(record, { reason: INTERRUPTED, phase: "failed", announce: true }),
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
          if (
            inPlace &&
            (yield* git.readWorktreeGroup?.(record.source.path) ?? Effect.succeed(null))
          )
            return yield* Effect.fail(
              new WorkspaceRequiresNewWorktreeError(
                "The primary branch belongs to a worktree group. Create a new worktree to change it.",
              ),
            );
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
            // Restored from its remote copy, the branch tracks it again. The
            // worktree is usable without that, so a failure here is not one.
            const remoteCopy = remoteBranchOf(record.baseRef, record.target.branch);
            if (remoteCopy)
              yield* git
                .setBranchUpstream({
                  cwd: record.target.path,
                  branch: record.target.branch!,
                  remoteName: remoteCopy.remote,
                  remoteBranch: record.target.branch!,
                })
                .pipe(Effect.ignore);
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
              new Error("The checkout changed before the switch was recorded. Try again."),
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
      // Idle threads that share the worktree follow it now. Left to the next
      // status read, one of them could recreate a removed folder on the old branch.
      if (
        (completed.intent === "checkout_branch" ||
          completed.intent === "create_branch_and_checkout") &&
        completed.result?.worktreePath &&
        completed.result.branch
      )
        yield* syncObservedCheckout(
          {
            engine,
            git,
            ...(Option.isSome(settings)
              ? { readBranchNamePrefix: makeBranchNamePrefixReader(settings.value.getSettings) }
              : {}),
          },
          completed.result.worktreePath,
          completed.result.branch,
        ).pipe(Effect.ignore);
      return completed;
    });
  const resumeMissingPause = (record: WorkspaceTransitionSnapshot) =>
    Effect.gen(function* () {
      // Any switch that gives the thread a folder again answers the pause.
      if (
        record.phase !== "completed" ||
        !["recreate", "recreate_from_base", "use_project_checkout", "attach_existing"].includes(
          record.intent,
        )
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
            const failure = Cause.squash(cause);
            const conflict = Schema.is(GitCommandError)(failure)
              ? failure.checkoutConflict
              : undefined;
            // The caller is waiting and gets the reason; only leftovers reach the timeline.
            return yield* settle(live, {
              reason: failure instanceof Error ? failure.message : String(failure),
              phase: "failed",
              announce: false,
              patch: {
                ...(conflict ? { checkoutConflict: conflict } : {}),
                ...(failure instanceof WorkspaceRequiresNewWorktreeError
                  ? { errorCode: failure.code }
                  : {}),
              },
            });
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
            if (live && !transitionIsUnsettled(live)) yield* Deferred.succeed(result, live);
            // A cancelled worker's caller is answered by `cancel`, once it has settled the row.
            else if (!cancelling.has(record.operationId))
              yield* Deferred.fail(
                result,
                new Error("The workspace switch stopped before it finished. Try again."),
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
        if (worker) return yield* Deferred.await(worker.result);
        // The setup handoff keeps one operation ID for all its attempts. One that
        // ended unfinished without touching Git simply runs again.
        if (
          setupOwnerToken &&
          (existing.phase === "failed" || existing.phase === "cancelled") &&
          !existing.mutationAttempted
        )
          return yield* start(
            yield* locked(
              existing,
              Effect.gen(function* () {
                // The target is planned again, as the folder is now. The first
                // plan is checked against the folder before anything changes, so
                // a folder that moved on would fail every attempt the same way.
                const attaching =
                  existing.intent === "attach_existing" ||
                  existing.intent === "use_project_checkout";
                if (!attaching) return yield* store.reactivate(existing);
                const { project } = yield* context(existing.threadId);
                const target = identity(
                  yield* inspectAttachableWorkspace(
                    git,
                    config,
                    project.workspaceRoot,
                    existing.target.path,
                    existing.intent === "attach_existing" ? existing.request.branch : undefined,
                  ),
                );
                return yield* store.reactivate(existing, { target });
              }),
            ),
          );
        return existing;
      }
      // An earlier switch nobody is running any more is settled first, so it
      // never refuses this one. Only a switch that is running right now does.
      yield* readTransition(input.threadId, "settled");
      const { thread, project } = yield* context(input.threadId);
      // Branches and worktrees belong to a Git checkout; a thread without a project has neither.
      if (isScratchProject(project))
        return yield* Effect.fail(new Error("Threads without a project have no branch to switch."));
      if (
        thread.worktreePath &&
        (input.intent === "checkout_branch" || input.intent === "create_branch_and_checkout") &&
        (yield* git.readWorktreeGroup?.(thread.worktreePath) ?? Effect.succeed(null))
      )
        return yield* Effect.fail(
          new WorkspaceRequiresNewWorktreeError(
            "The primary branch belongs to a worktree group. Create a new worktree to change it.",
          ),
        );
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
      // Recovery starts from a folder that is gone, or that now holds something
      // else; every other inspection error remains blocking.
      const recovering =
        ["recreate", "recreate_from_base", "use_project_checkout", "attach_existing"].includes(
          input.intent,
        ) && thread.worktreePath !== null;
      const lost = { path: sourcePath, repository, branch: thread.branch, headSha: null };
      const inspected = yield* inspect(sourcePath).pipe(
        Effect.map(identity),
        Effect.catch((error) => (recovering ? Effect.succeed(null) : Effect.fail(error))),
      );
      const source =
        inspected === null || (recovering && inspected.repository !== repository)
          ? lost
          : inspected;
      if (source.repository !== repository)
        return yield* Effect.fail(new Error("The source belongs to another repository."));
      const sourceMissing = Effect.tryPromise({
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
      /** The usual folder for `branch`, or a sibling of it when that one is taken. */
      const freeWorktreePath = (branch: string) =>
        Effect.gen(function* () {
          const usual = yield* git.allocateWorktreePath({ cwd: project.workspaceRoot, branch });
          const taken = yield* Effect.tryPromise({
            try: () =>
              lstat(usual).then(
                () => true,
                () => false,
              ),
            catch: (error) => new WorkspaceTransitionError(String(error)),
          });
          return taken
            ? yield* git.allocateWorktreePath({
                cwd: project.workspaceRoot,
                branch: `${branch}-${crypto.randomUUID().slice(0, 8)}`,
              })
            : usual;
        });
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
          const branchPrefix = Option.isSome(settings)
            ? yield* readBranchNamePrefix(settings.value.getSettings, project)
            : "";
          if (isPlaceholderBranch(branch, branchPrefix))
            return yield* Effect.fail(new Error(PLACEHOLDER_BRANCH_RESERVED_MESSAGE));
          if (!(yield* git.isValidBranchName(branch)))
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
                buildFinalBranchName({
                  prefix: namingSettings?.sourceControlWriting.branchNamePrefix,
                  type: generated.value.type,
                  slug: generated.value.branch,
                }),
              )
            : buildPlaceholderBranchName({
                prefix: namingSettings?.sourceControlWriting.branchNamePrefix,
                sourceText: first?.text ?? thread.title,
              });
        }
        branch = yield* resolvePlaceholderBranch(git, project.workspaceRoot, branch);
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
      } else if (input.intent === "recreate" && source === lost && !(yield* sourceMissing)) {
        // The recorded folder now holds something else, which stays untouched:
        // the branch comes back in a folder of its own.
        if (!thread.branch)
          return yield* Effect.fail(new Error("The worktree branch is unavailable."));
        target = {
          ...lost,
          path: yield* canonicalWorkspace(yield* freeWorktreePath(thread.branch)),
        };
      } else if (input.intent === "recreate_from_base") {
        // The recorded branch is where the thread's work is: start from it when
        // it still exists (another checkout holds it, so the new worktree gets
        // a branch of its own), and from the default branch when it is gone.
        const recorded =
          thread.branch && (yield* git.branchExists(project.workspaceRoot, thread.branch))
            ? thread.branch
            : null;
        // A branch that is gone here but still on a remote starts again from
        // that copy: a branch of the same name cut from the default branch
        // would not have its commits, and pushing it would overwrite them.
        const remoteCopy =
          thread.branch && recorded === null
            ? yield* findRemoteBranch(git, project.workspaceRoot, thread.branch).pipe(
                Effect.orElseSucceed(() => null),
              )
            : null;
        const base =
          recorded ??
          remoteCopy ??
          (yield* git.readDefaultBranch(project.workspaceRoot)) ??
          (yield* git.inspectCheckoutIdentity(project.workspaceRoot)).branch;
        const sha = base ? yield* git.resolveCommit(project.workspaceRoot, base) : null;
        if (!sha) return yield* Effect.fail(new Error("No committed recovery base is available."));
        const branch =
          thread.branch && recorded === null
            ? thread.branch
            : yield* resolvePlaceholderBranch(
                git,
                project.workspaceRoot,
                buildPlaceholderBranchName({
                  prefix: Option.isSome(settings)
                    ? yield* readBranchNamePrefix(settings.value.getSettings, project)
                    : "",
                  sourceText: thread.title,
                }),
              );
        baseRef = base!;
        const managed = yield* readManagedWorktreesDirectories(config.worktreesDir);
        target = {
          path:
            (yield* sourceMissing) &&
            managed.some((root) => sourcePath !== root && pathContains(root, sourcePath))
              ? sourcePath
              : yield* freeWorktreePath(branch),
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
  const cancel: WorkspaceTransitionShape["cancel"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* store.forThread(threadId).pipe(Effect.orElseSucceed(() => null));
      // A row that no longer decodes is ended without reading it.
      if (!record) return yield* store.cancel(threadId);
      // Archiving and deleting end the row in their own transaction, before this
      // runs. The worker is still running then and has to be stopped all the same.
      const worker = workers.get(record.operationId);
      const holdsMoveRef = (entry: WorkspaceTransitionRecord) =>
        entry.intent === "move_to_new_worktree" &&
        entry.phase === "cancelled" &&
        Boolean(entry.moveData?.snapshotRef);
      if (!worker && !transitionIsUnsettled(record) && !holdsMoveRef(record)) return;
      cancelling.add(record.operationId);
      yield* Effect.gen(function* () {
        // Stop the worker first, so nothing changes Git while the row is settled.
        if (worker) yield* Fiber.interrupt(worker.fiber);
        const settled = yield* settle(yield* currentRecord(record.operationId), {
          reason: WORKSPACE_SWITCH_CANCELLED,
          phase: "cancelled",
          announce: false,
        });
        // A move that was ended elsewhere keeps its copy but not its private snapshot ref.
        return holdsMoveRef(settled) ? yield* releaseRetainedMove(settled) : settled;
      }).pipe(
        // The worker's caller is answered however this ends. The worker left that
        // to this cancel, so a cancel that fails, or is itself interrupted (the
        // client that asked for it went away), must not leave the caller waiting.
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            cancelling.delete(record.operationId);
            if (!worker) return;
            if (Exit.isSuccess(exit)) return yield* Deferred.succeed(worker.result, exit.value);
            const live = yield* store
              .get(record.operationId)
              .pipe(Effect.orElseSucceed(() => null));
            yield* live && !transitionIsUnsettled(live)
              ? Deferred.succeed(worker.result, live)
              : Deferred.fail(
                  worker.result,
                  new Error("The workspace switch stopped before it finished. Try again."),
                );
          }),
        ),
      );
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
        } else if (!transitionIsUnsettled(record)) yield* locked(record, releaseMoveRef(record));
      }),
    ).pipe(Effect.catch((error) => Effect.logWarning("Move recovery retained artifacts", error)));
  }
  // Whatever a restart interrupted is settled now, before anything can queue behind
  // it. That includes rows an older version parked for manual recovery.
  for (const record of yield* store.unsettled)
    yield* settleOrphan(record).pipe(
      Effect.catch((error) => Effect.logWarning("Workspace switch could not be settled", error)),
    );
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
          new Error(result.error ?? "The move did not finish; the project folder was kept."),
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
      readTransition(threadId, "briefly").pipe(
        Effect.map((record) => (record ? workspaceTransitionSnapshot(record) : null)),
      ),
    cancel,
  } satisfies WorkspaceTransitionShape;
});
export const WorkspaceTransitionLive = Layer.effect(WorkspaceTransition, makeWorkspaceTransition);
