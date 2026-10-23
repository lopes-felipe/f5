import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { WorkspaceTransitions } from "../persistence/Services/WorkspaceTransitions.ts";
import { sameMoveSnapshot, isMoveCopySnapshot, type MoveSnapshot } from "../git/moveSnapshot.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkspaceTransitionError } from "../persistence/Services/WorkspaceTransitions.ts";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { legacyT3BaseDir } from "@t3tools/shared/appStatePaths";
import { ServerConfig } from "../config.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { WorktreeSetupGate } from "./Services/WorktreeSetupGate.ts";
import {
  ThreadId,
  WorktreeSetupSnapshot,
  worktreeSetupGatesTurn,
  WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { Effect, Exit, Option, Schema, Scope } from "effect";

import { GitCore, type GitCoreShape, type RegisteredWorktree } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { nonDisposablePaths } from "../git/worktreeDisposablePaths.ts";
import { readOtherProfileManagedRoots } from "../profiles/RepositorySharing.ts";
import { resolveHeadInDefaultBranch } from "./worktreeMerge.ts";
import {
  blockingIgnoredEntries,
  type IgnoredFilesRemovalPolicy,
} from "../git/worktreeIgnoredFiles.ts";
export { blockingIgnoredEntries } from "../git/worktreeIgnoredFiles.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import {
  pathContains,
  withWorktreeLifecycleLock,
  withRepositoryLifecycleLock,
} from "./Layers/WorktreeLifecycleCoordinator.ts";

/**
 * Everything that currently relies on a worktree path. Removal is only safe
 * when nothing outside the caller's own thread holds a claim.
 */
export interface WorktreeClaims {
  readonly unknown: boolean;
  readonly activeThreadIds: ReadonlyArray<ThreadId>;
  readonly setupThreadIds: ReadonlyArray<ThreadId>;
  readonly transitionThreadIds: ReadonlyArray<ThreadId>;
  readonly deletedThreadIds: ReadonlyArray<ThreadId>;
  /** Non-deleted threads (active or archived) whose worktree is this path. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Referencing threads that still have queued, dispatching or failed queue work. */
  readonly queuedThreadIds: ReadonlyArray<ThreadId>;
  /** Starting or running terminals whose cwd is inside the path. */
  readonly terminals: ReadonlyArray<{
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd: string;
  }>;
  /** Provider sessions that are not closed and whose cwd is inside the path. */
  readonly sessions: ReadonlyArray<{ readonly threadId: string; readonly cwd: string }>;
}

const canonical = (value: string) =>
  Effect.tryPromise(() => canonicalWorktreePath(value)).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );

/** Reads every claim on `path`. Callers hold the worktree lifecycle lock. */
export const readWorktreeClaims = Effect.fn("readWorktreeClaims")(function* (path: string) {
  const engine = yield* OrchestrationEngineService;
  const terminals = yield* TerminalManager;
  const providers = yield* ProviderService;
  const queue = yield* NextTurnQueueStore;
  const turns = yield* Effect.serviceOption(ProjectionTurnRepository);
  const setup = yield* Effect.serviceOption(WorktreeSetupGate);
  const cache = new Map<string, string | null>();
  let unknown = false;
  const resolve = (value: string) =>
    Effect.gen(function* () {
      if (cache.has(value)) return cache.get(value)!;
      const result = yield* canonical(value);
      if (result === null) unknown = true;
      cache.set(value, result);
      return result;
    });
  const target = yield* resolve(path);
  const inside = (candidate: string | null) =>
    target !== null && candidate !== null && pathContains(target, candidate);
  const readModel = yield* engine.getReadModel();
  const threadIds: ThreadId[] = [];
  const deletedThreadIds: ThreadId[] = [];
  const activeThreadIds: ThreadId[] = [];
  const setupThreadIds: ThreadId[] = [];
  const transitionThreadIds: ThreadId[] = [];
  for (const thread of readModel.threads) {
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    const workspace = threadWorkspaceCwd(thread, project);
    if (!workspace) {
      unknown = true;
      continue;
    }
    const preparation = thread.activities
      ?.map((activity) => activity.payload)
      .find(
        (payload) => Schema.is(WorktreeSetupSnapshot)(payload) && worktreeSetupGatesTurn(payload),
      );
    const preparingPath =
      preparation && Schema.is(WorktreeSetupSnapshot)(preparation)
        ? preparation.worktreePath
        : null;
    const preparingHere = preparingPath !== null && inside(yield* resolve(preparingPath));
    if (!inside(yield* resolve(workspace)) && !preparingHere) continue;
    if (preparingHere) setupThreadIds.push(thread.id);
    if (thread.deletedAt !== null) {
      deletedThreadIds.push(thread.id);
      continue;
    }
    threadIds.push(thread.id);
    const session = thread.session;
    if (
      session &&
      (session.activeTurnId !== null ||
        session.status === "starting" ||
        session.status === "running")
    )
      activeThreadIds.push(thread.id);
    if (Option.isSome(turns)) {
      const pending = yield* turns.value
        .getPendingTurnStartByThreadId({ threadId: thread.id })
        .pipe(
          Effect.orElseSucceed(() => {
            unknown = true;
            return Option.none();
          }),
        );
      if (Option.isSome(pending)) activeThreadIds.push(thread.id);
    }
  }
  const queuedThreadIds: ThreadId[] = [];
  const queues = yield* queue.readWorkspaceClaims(threadIds).pipe(
    Effect.orElseSucceed(() => {
      unknown = true;
      return threadIds.map((threadId) => ({
        threadId,
        hasQueuedWork: true,
        worktreeBlockToken: null,
      }));
    }),
  );
  for (const data of queues) {
    if (data.hasQueuedWork) queuedThreadIds.push(data.threadId);
    if (
      data.worktreeBlockToken ||
      (Option.isSome(setup) &&
        (yield* setup.value.check(data.threadId, data.worktreeBlockToken)) !== "none")
    )
      setupThreadIds.push(data.threadId);
  }
  const transitionSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isSome(transitionSql)) {
    const hooks = yield* transitionSql.value<{
      threadId: string;
      path: string;
    }>`SELECT thread_id AS "threadId",worktree_path AS path FROM thread_settlement_hooks WHERE state IN ('pending','running','orphaned') LIMIT 1001`.pipe(
      Effect.orElseSucceed(() => {
        unknown = true;
        return [];
      }),
    );
    if (hooks.length > 1000) unknown = true;
    for (const hook of hooks)
      if (inside(yield* resolve(hook.path)))
        setupThreadIds.push(ThreadId.makeUnsafe(hook.threadId));
    const transitions = yield* transitionSql.value<{
      record: string;
    }>`SELECT record_json AS record FROM workspace_transitions
      WHERE phase IN ('reserved','stopping','applying','applied','needs_recovery')`.pipe(
      Effect.orElseSucceed(() => {
        unknown = true;
        return [];
      }),
    );
    for (const row of transitions) {
      const record = yield* Effect.try({
        try: () => {
          const value: unknown = JSON.parse(row.record);
          if (!Schema.is(WorkspaceTransitionSnapshot)(value))
            throw new Error("Unreadable workspace transition claim.");
          return value;
        },
        catch: (error) => new WorkspaceTransitionError(String(error)),
      }).pipe(
        Effect.orElseSucceed(() => {
          unknown = true;
          return null;
        }),
      );
      if (!record) continue;
      if (
        inside(yield* resolve(record.source.path)) ||
        inside(yield* resolve(record.target.path))
      ) {
        setupThreadIds.push(record.threadId);
        transitionThreadIds.push(record.threadId);
      }
    }
  }
  const markDeletedOwner = (id: string) => {
    const thread = readModel.threads.find(
      (thread) => thread.id === id && thread.deletedAt !== null,
    );
    if (thread && !deletedThreadIds.includes(thread.id)) deletedThreadIds.push(thread.id);
  };
  const liveTerminals: Array<{ threadId: string; terminalId: string; cwd: string }> = [];
  const terminalSessions = yield* terminals.listSessions.pipe(
    Effect.orElseSucceed(() => {
      unknown = true;
      return [];
    }),
  );
  for (const terminal of terminalSessions) {
    if (terminal.status !== "starting" && terminal.status !== "running") continue;
    if (inside(yield* resolve(terminal.cwd))) {
      markDeletedOwner(terminal.threadId);
      liveTerminals.push({
        threadId: terminal.threadId,
        terminalId: terminal.terminalId,
        cwd: terminal.cwd,
      });
    }
  }
  const liveSessions: Array<{ threadId: string; cwd: string }> = [];
  const startingBefore = yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([]);
  const providerSessions = yield* providers.listSessions().pipe(
    Effect.orElseSucceed(() => {
      unknown = true;
      return [];
    }),
  );
  const startingAfter = yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([]);
  for (const session of [
    ...startingBefore,
    ...providerSessions.filter((session) => session.status !== "closed"),
    ...startingAfter,
  ]) {
    if (session.cwd === undefined) {
      unknown = true;
      continue;
    }
    if (inside(yield* resolve(session.cwd))) {
      markDeletedOwner(session.threadId);
      liveSessions.push({ threadId: session.threadId, cwd: session.cwd });
    }
  }
  return {
    unknown,
    threadIds,
    activeThreadIds,
    setupThreadIds,
    transitionThreadIds,
    deletedThreadIds,
    queuedThreadIds,
    terminals: liveTerminals,
    sessions: liveSessions,
  } satisfies WorktreeClaims;
});

/**
 * Why ignored files make removing `worktreePath` unsafe, or null when they do
 * not. `git worktree remove` refuses on tracked changes and untracked files but
 * silently deletes ignored ones. Manual removal requires explicit approval of
 * every ignored entry. Automatic cleanup and storage maintenance may delete
 * only well-known build and cache output.
 */
export const ignoredFilesBlockRemoval = (
  git: GitCoreShape,
  worktreePath: string,
  inspected?: { readonly entries: ReadonlyArray<string>; readonly truncated: boolean },
  policy: IgnoredFilesRemovalPolicy = { kind: "protect" },
) =>
  (inspected
    ? Effect.succeed(inspected)
    : git.cleanupSafetyProbe(worktreePath).pipe(
        Effect.map((probe) => ({
          entries: probe.ignoredEntries,
          truncated: probe.ignoredTruncated,
        })),
      )
  ).pipe(
    Effect.map(({ entries, truncated }) => {
      if (truncated) return "too many ignored files to check";
      const blocking = blockingIgnoredEntries(entries, policy);
      return blocking.length > 0
        ? policy.kind === "manual"
          ? policy.approvedEntries === undefined
            ? "Ignored files and folders require explicit deletion confirmation."
            : "Ignored files changed since review. Inspect this checkout again."
          : policy.kind === "rebuildable"
            ? `ignored files that are not build output (${blocking.slice(0, 3).join(", ")})`
            : `ignored files other than node_modules/ (${blocking.slice(0, 3).join(", ")})`
        : null;
    }),
    Effect.orElseSucceed(() => "ignored files could not be listed"),
  );

/** Claims held by anything other than `ownThreadId` and the given owned terminals. */
export function foreignClaims(
  claims: WorktreeClaims,
  ownThreadId: ThreadId | null,
  ownedTerminalIds: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (claims.unknown) reasons.push("workspace usage could not be verified");
  if (claims.transitionThreadIds.length) reasons.push("a workspace transition owns this checkout");
  if (claims.activeThreadIds.some((id) => id !== ownThreadId))
    reasons.push("another thread has an active or pending turn");
  if (claims.setupThreadIds.some((id) => id !== ownThreadId))
    reasons.push("another thread is preparing this workspace");
  const otherQueued = claims.queuedThreadIds.filter((threadId) => threadId !== ownThreadId);
  if (otherQueued.length > 0) reasons.push("another thread has queued work");
  const userTerminals = claims.terminals.filter(
    (terminal) =>
      terminal.threadId !== ownThreadId || !ownedTerminalIds.includes(terminal.terminalId),
  );
  if (userTerminals.length > 0) reasons.push("a terminal is open in it");
  const otherSessions = claims.sessions.filter((session) => session.threadId !== ownThreadId);
  if (otherSessions.length > 0)
    reasons.push(
      "an open or starting agent session uses it; stop that session before removing the worktree",
    );
  return reasons;
}

interface WorktreeRemovalContext {
  readonly ownThreadId: ThreadId | null;
  readonly ownedCreation?: {
    readonly path: string;
    readonly commonDir: string;
    readonly baseSha: string;
    readonly created: boolean;
    readonly copiedSnapshot?: MoveSnapshot | undefined;
    readonly transitionOperationId?: string;
  };
}

export type WorktreeRemovalPolicy = WorktreeRemovalContext &
  (
    | {
        readonly kind: "manual";
        readonly approvedIgnoredEntries?: ReadonlyArray<string> | undefined;
      }
    | { readonly kind: "autoCleanup" | "legacyCleanup" | "ownedRollback" }
    | {
        /**
         * Storage cleanup of inactive worktrees: managed ones under the F5
         * worktrees root, or `externalCleanup` for linked worktrees of a project
         * repository that live elsewhere.
         */
        readonly kind: "storageMaintenance" | "externalCleanup";
        /** Project globs whose uncommitted changes may be discarded. */
        readonly disposablePaths?: ReadonlyArray<string> | undefined;
      }
  );

const isStorageCleanupPolicy = (
  policy: WorktreeRemovalPolicy,
): policy is Extract<WorktreeRemovalPolicy, { kind: "storageMaintenance" | "externalCleanup" }> =>
  policy.kind === "storageMaintenance" || policy.kind === "externalCleanup";

const ignoredRemovalPolicy = (policy: WorktreeRemovalPolicy): IgnoredFilesRemovalPolicy =>
  policy.kind === "manual"
    ? { kind: "manual", approvedEntries: policy.approvedIgnoredEntries }
    : // Automatic cleanup may run unattended on rules users enabled long ago, so
      // it gets no wider an ignored-file exception than storage maintenance.
      policy.kind === "autoCleanup" || isStorageCleanupPolicy(policy)
      ? { kind: "rebuildable" }
      : { kind: "protect" };

/** Reviewed uncommitted changes Storage cleanup may discard. */
export interface DiscardableChanges {
  readonly paths: ReadonlyArray<string>;
  readonly fingerprint: string;
}

const sameDiscardableChanges = (
  left: DiscardableChanges | undefined,
  right: DiscardableChanges | undefined,
) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.fingerprint === right.fingerprint &&
    left.paths.length === right.paths.length &&
    left.paths.every((path, index) => path === right.paths[index]));

/** Local-only, fail-closed evaluation. Call again under path then repository locks before mutation. */
export const evaluateWorktreeRemoval = Effect.fn("evaluateWorktreeRemoval")(function* (input: {
  readonly projectCwd: string;
  readonly path: string;
  readonly policy: WorktreeRemovalPolicy;
}) {
  const git = yield* GitCore;
  const engine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const blockedReasons: string[] = [];
  let ignoredEntries: ReadonlyArray<string> = [];
  let ignoredFiles:
    | {
        entries: ReadonlyArray<string>;
        truncated: boolean;
        requiresApproval: boolean;
      }
    | undefined;
  let ignoredReason: string | null = null;
  let branch: string | null = null;
  let headSha: string | null = null;
  /** Storage cleanup: HEAD is reachable from the default branch. */
  let headMerged = false;
  /**
   * Storage cleanup: the branch may be deleted with the worktree. It must be
   * merged, not the default branch, and without a live upstream other than
   * `origin/<default>` (so release or develop branches on the remote are kept).
   */
  let branchDeletable = false;
  let discardChanges: DiscardableChanges | undefined;
  const target = yield* canonical(input.path);
  const root = yield* canonical(
    input.policy.kind === "legacyCleanup"
      ? Path.join(legacyT3BaseDir(), "worktrees")
      : config.worktreesDir,
  );
  if (!target || !root) blockedReasons.push("workspace identity could not be verified");
  else if (input.policy.kind === "externalCleanup") {
    // External checkouts are only ever linked worktrees of a project's own repository.
    const legacyRoot = yield* canonical(Path.join(legacyT3BaseDir(), "worktrees"));
    if (pathContains(root, target)) blockedReasons.push("inside the F5 worktrees folder");
    else if (legacyRoot && pathContains(legacyRoot, target))
      blockedReasons.push("inside the legacy T3 worktrees folder");
    const otherRoots = yield* Effect.tryPromise(() => readOtherProfileManagedRoots(config)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (otherRoots === null)
      blockedReasons.push("other profiles' worktree folders could not be verified");
    else if (otherRoots.some((other) => pathContains(other, target)))
      blockedReasons.push("another F5 profile owns this checkout");
    const projectCwd = yield* canonical(input.projectCwd);
    const projectRoots = yield* Effect.forEach(
      (yield* engine.getReadModel()).projects.filter((project) => project.deletedAt === null),
      (project) => canonical(project.workspaceRoot),
    );
    if (!projectCwd || !projectRoots.includes(projectCwd))
      blockedReasons.push("not a worktree of an F5 project");
  } else if (target === root || !pathContains(root, target))
    blockedReasons.push("outside the allowed worktrees root");
  // Never execute Git in an arbitrary client-supplied checkout.
  if (blockedReasons.length)
    return {
      exists: false,
      registration: null,
      blockedReasons,
      linkedThreads: [] as ThreadId[],
      deletedThreadClaims: [] as ThreadId[],
      ignoredEntries,
      branch,
      headSha,
      headMerged,
      branchDeletable,
    };
  const exists = yield* Effect.tryPromise(() => FS.lstat(input.path)).pipe(
    Effect.map(() => true),
    Effect.catch((error) => {
      if ((error.cause as NodeJS.ErrnoException)?.code !== "ENOENT")
        blockedReasons.push("worktree directory could not be inspected");
      return Effect.succeed(false);
    }),
  );
  const preparation = yield* git.readWorktreePreparation(input.path).pipe(
    Effect.catch(() => {
      blockedReasons.push("preparation ownership could not be read");
      return Effect.succeed(null);
    }),
  );
  if (
    preparation &&
    ["allocated", "setup_running", "setup_indeterminate"].includes(preparation.phase) &&
    !(
      input.policy.kind === "ownedRollback" &&
      preparation.owner === `thread:${input.policy.ownThreadId}`
    )
  )
    blockedReasons.push(
      "a preparation operation owns this checkout; finish or explicitly recover it first",
    );
  const entries = yield* git.listWorktrees(input.projectCwd).pipe(
    Effect.orElseSucceed(() => {
      blockedReasons.push("worktree registrations could not be read");
      return [];
    }),
  );
  const registration: RegisteredWorktree | null =
    entries.find((entry) => entry.canonicalPath === target) ?? null;
  if (!registration && exists) blockedReasons.push("not registered in the expected repository");
  if (registration?.isMain) blockedReasons.push("the main checkout cannot be removed");
  if (registration?.locked !== null && registration?.locked !== undefined)
    blockedReasons.push("the worktree is locked");
  // Storage cleanup allows a detached HEAD once it is known to be merged (checked below).
  if (registration?.detached && !isStorageCleanupPolicy(input.policy))
    blockedReasons.push("HEAD is detached");
  for (const project of (yield* engine.getReadModel()).projects) {
    if (project.deletedAt !== null) continue;
    const projectRoot = yield* canonical(project.workspaceRoot);
    if (!projectRoot) blockedReasons.push("a project root could not be verified");
    else if (target && pathContains(target, projectRoot))
      blockedReasons.push("it contains a project checkout");
  }
  const claims = yield* readWorktreeClaims(input.path);
  if (input.policy.kind === "storageMaintenance") {
    const model = yield* engine.getReadModel();
    if (
      model.threads.some(
        (thread) =>
          claims.threadIds.includes(thread.id) &&
          thread.deletedAt === null &&
          thread.archivedAt === null,
      )
    )
      blockedReasons.push("Referenced by an active thread.");
  }
  let ownedTransition = false;
  let originalMoveSnapshot: MoveSnapshot | undefined;
  const transitionStore = yield* Effect.serviceOption(WorkspaceTransitions);
  if (
    input.policy.kind === "ownedRollback" &&
    input.policy.ownedCreation?.transitionOperationId &&
    Option.isSome(transitionStore)
  ) {
    const operation = yield* transitionStore.value
      .get(input.policy.ownedCreation.transitionOperationId)
      .pipe(Effect.orElseSucceed(() => null));
    ownedTransition =
      operation?.threadId === input.policy.ownThreadId &&
      operation?.intent === "move_to_new_worktree" &&
      operation.target.path === target &&
      ["applying", "applied", "needs_recovery"].includes(operation.phase);
    if (ownedTransition) originalMoveSnapshot = operation?.moveData?.snapshot;
  }
  if (isStorageCleanupPolicy(input.policy)) {
    const model = yield* engine.getReadModel();
    if (
      model.threads.some(
        (thread) =>
          claims.threadIds.includes(thread.id) &&
          thread.deletedAt === null &&
          thread.archivedAt === null,
      )
    )
      blockedReasons.push("Referenced by an active thread.");
  }
  blockedReasons.push(
    ...foreignClaims(
      {
        ...claims,
        transitionThreadIds: claims.transitionThreadIds.filter(
          (id) => !ownedTransition || id !== input.policy.ownThreadId,
        ),
        sessions: claims.sessions.filter(
          (session) => !claims.deletedThreadIds.some((id) => id === session.threadId),
        ),
        terminals: claims.terminals.filter(
          (terminal) => !claims.deletedThreadIds.some((id) => id === terminal.threadId),
        ),
      },
      input.policy.ownThreadId,
    ),
  );
  if (input.policy.kind !== "ownedRollback" && claims.setupThreadIds.length > 0)
    blockedReasons.push("workspace preparation is in progress");
  if (input.policy.kind === "autoCleanup" && input.policy.ownThreadId) {
    if (claims.activeThreadIds.includes(input.policy.ownThreadId))
      blockedReasons.push("the thread is working");
    if (claims.queuedThreadIds.includes(input.policy.ownThreadId))
      blockedReasons.push("the thread has queued turns");
    if (
      claims.sessions.some((session) => session.threadId === input.policy.ownThreadId) &&
      !claims.deletedThreadIds.includes(input.policy.ownThreadId)
    )
      blockedReasons.push("an agent session is open in it");
  }
  if (exists && registration) {
    const common = yield* git.resolveCommonDir(input.projectCwd).pipe(
      Effect.flatMap(canonical),
      Effect.orElseSucceed(() => null),
    );
    const identity = yield* git
      .inspectCheckoutIdentity(input.path)
      .pipe(Effect.orElseSucceed(() => null));
    const matches =
      identity !== null &&
      identity.canonicalRoot === target &&
      common !== null &&
      identity.commonDir === common;
    if (!matches) blockedReasons.push("checkout identity does not match the expected repository");
    // Status can invoke repository-configured helpers. Only run it after identity matches.
    const disposablePaths = isStorageCleanupPolicy(input.policy)
      ? (input.policy.disposablePaths ?? [])
      : [];
    const inspected = matches
      ? yield* git
          .inspectCheckout(
            input.path,
            disposablePaths.length > 0 ? { changesFingerprint: true } : undefined,
          )
          .pipe(Effect.orElseSucceed(() => null))
      : null;
    if (!inspected && matches) blockedReasons.push("checkout status could not be read");
    if (inspected) {
      ignoredEntries = inspected.ignoredEntries;
      branch = inspected.branch;
      headSha = inspected.headSha;
      if (isStorageCleanupPolicy(input.policy)) {
        // Merged into the default branch, or fully pushed to a live upstream.
        const containment = inspected.headSha
          ? yield* resolveHeadInDefaultBranch(git, input.projectCwd, inspected.headSha)
          : { defaultBranch: null, merged: null };
        headMerged = containment.merged === true;
        branchDeletable =
          headMerged &&
          inspected.branch !== null &&
          containment.defaultBranch !== null &&
          inspected.branch !== containment.defaultBranch &&
          (inspected.upstreamRef === null ||
            inspected.upstreamRef === `refs/remotes/origin/${containment.defaultBranch}`);
        const pushed = inspected.upstreamRef !== null && inspected.aheadCount === 0;
        if (!headMerged && !pushed)
          blockedReasons.push(
            `it has commits that are not in ${
              containment.defaultBranch
                ? `origin/${containment.defaultBranch}`
                : "the default branch"
            } and not pushed`,
          );
      }
      if (inspected.hasInitializedSubmodules)
        blockedReasons.push(
          "initialized submodules prevent safe removal; preserve their local work and deinitialize them before retrying",
        );
      if (inspected.branch === null && !(isStorageCleanupPolicy(input.policy) && headMerged))
        blockedReasons.push("HEAD is detached");
      if (inspected.operation) blockedReasons.push(`a ${inspected.operation} is in progress`);
      const changedPaths = inspected.changedPaths;
      const discardable =
        (inspected.hasTrackedChanges || inspected.hasUntrackedChanges) &&
        disposablePaths.length > 0 &&
        changedPaths !== undefined &&
        changedPaths.length > 0 &&
        inspected.changesFingerprint !== undefined &&
        nonDisposablePaths(changedPaths, disposablePaths).length === 0;
      if (discardable)
        discardChanges = {
          paths: [...changedPaths].toSorted(),
          fingerprint: inspected.changesFingerprint!,
        };
      else if (inspected.hasTrackedChanges || inspected.hasUntrackedChanges) {
        const copies =
          input.policy.kind === "ownedRollback"
            ? input.policy.ownedCreation?.copiedSnapshot
            : undefined;
        const verifiedCopies =
          copies && originalMoveSnapshot && isMoveCopySnapshot(copies, originalMoveSnapshot)
            ? yield* git.readMoveSnapshot(input.path).pipe(
                Effect.map((actual) => sameMoveSnapshot(actual, copies)),
                Effect.orElseSucceed(() => false),
              )
            : false;
        if (!verifiedCopies)
          blockedReasons.push("it has uncommitted changes (including untracked files)");
      }
      ignoredReason = yield* ignoredFilesBlockRemoval(
        git,
        input.path,
        { entries: inspected.ignoredEntries, truncated: inspected.ignoredTruncated },
        ignoredRemovalPolicy(input.policy),
      );
      ignoredFiles = {
        entries: inspected.ignoredEntries,
        truncated: inspected.ignoredTruncated,
        requiresApproval:
          input.policy.kind === "manual" && !inspected.ignoredTruncated && ignoredReason !== null,
      };
      if (input.policy.kind === "ownedRollback") {
        const proof = input.policy.ownedCreation;
        const receipt = yield* git
          .readWorktreePreparation(input.path)
          .pipe(Effect.orElseSucceed(() => null));
        if (
          !receipt?.createdCheckout ||
          (input.policy.ownedCreation?.copiedSnapshot !== undefined &&
            receipt.operationId !== `move:${input.policy.ownedCreation.transitionOperationId}`) ||
          (input.policy.ownThreadId !== null &&
            receipt.owner !== `thread:${input.policy.ownThreadId}`) ||
          receipt.repositoryIdentity !== common ||
          receipt.baseOid !== inspected.headSha ||
          !proof?.created ||
          (yield* canonical(proof.path)) !== target ||
          (yield* canonical(proof.commonDir)) !== common ||
          proof.baseSha !== inspected.headSha
        )
          blockedReasons.push("creation ownership or unchanged base commit could not be verified");
      }
    }
  }
  return {
    exists,
    registration,
    blockedReasons: [...new Set([...blockedReasons, ...(ignoredReason ? [ignoredReason] : [])])],
    linkedThreads: claims.threadIds,
    deletedThreadClaims: claims.deletedThreadIds,
    ignoredEntries,
    branch,
    headSha,
    headMerged,
    branchDeletable,
    ...(discardChanges ? { discardChanges } : {}),
    ...(ignoredFiles
      ? {
          ignoredFiles: {
            ...ignoredFiles,
            canRemoveAfterApproval: ignoredFiles.requiresApproval && blockedReasons.length === 0,
          },
        }
      : {}),
  };
});

/** Every caller uses the same preview and locked re-evaluation, including rollback. */
export const removeWorktreeSafely = Effect.fn("removeWorktreeSafely")(function* (input: {
  readonly projectCwd: string;
  readonly path: string;
  readonly policy: WorktreeRemovalPolicy;
  readonly expectedHead?: string | null;
  readonly expectedRootIdentity?: { readonly dev: number; readonly ino: number } | null | undefined;
  /**
   * Storage cleanup: the uncommitted changes the user reviewed for discarding.
   * Removal is refused when the current discardable changes differ.
   */
  readonly expectedDiscardChanges?: DiscardableChanges | undefined;
  /** Checked again under both locks, immediately before Git mutates the checkout. */
  readonly isCancelled?: () => boolean;
  /** Runs under the same repository lock after the verified checkout is removed. */
  readonly afterRemoval?: (registration: RegisteredWorktree | null) => Effect.Effect<void>;
}) {
  const git = yield* GitCore;
  const engine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  if (input.isCancelled?.())
    return {
      exists: false,
      registration: null,
      linkedThreads: [] as ThreadId[],
      deletedThreadClaims: [] as ThreadId[],
      blockedReasons: ["Cleanup was cancelled."],
      ignoredEntries: [] as string[],
    };
  const preview = yield* evaluateWorktreeRemoval(input);
  if (preview.blockedReasons.length) return preview;
  const common = yield* git.resolveCommonDir(input.projectCwd);
  return yield* withWorktreeLifecycleLock(
    input.path,
    withRepositoryLifecycleLock(
      config.baseDir,
      common,
      Effect.scoped(
        Effect.gen(function* () {
          if (input.isCancelled?.())
            return { ...preview, blockedReasons: ["Cleanup was cancelled."] };
          const inspectedProjectRoots = new Set(
            (yield* engine.getReadModel()).projects
              .filter((project) => project.deletedAt === null)
              .map((project) => project.workspaceRoot),
          );
          const checked = yield* evaluateWorktreeRemoval(input);
          // Git inspection can be slow. Only freeze orchestration writes for the
          // final state/claim check and removal, inside the lifecycle locks.
          const maintenanceGate = isStorageCleanupPolicy(input.policy)
            ? yield* engine.acquireMaintenanceLock()
            : null;
          if (maintenanceGate)
            yield* Effect.addFinalizer(() => Scope.close(maintenanceGate, Exit.void));
          const finalModel = yield* engine.getReadModel();
          const claims = yield* readWorktreeClaims(input.path);
          if (isStorageCleanupPolicy(input.policy)) {
            if (
              finalModel.threads.some(
                (thread) =>
                  claims.threadIds.includes(thread.id) &&
                  thread.deletedAt === null &&
                  thread.archivedAt === null,
              )
            )
              checked.blockedReasons.push("Referenced by an active thread.");
            const finalProjectRoots = new Set(
              finalModel.projects
                .filter((project) => project.deletedAt === null)
                .map((project) => project.workspaceRoot),
            );
            if (
              finalProjectRoots.size !== inspectedProjectRoots.size ||
              [...finalProjectRoots].some((root) => !inspectedProjectRoots.has(root))
            )
              checked.blockedReasons.push(
                "Project roots changed during inspection. Rescan before removal.",
              );
            checked.blockedReasons.push(
              ...foreignClaims(
                {
                  ...claims,
                  sessions: claims.sessions.filter(
                    (session) => !claims.deletedThreadIds.some((id) => id === session.threadId),
                  ),
                  terminals: claims.terminals.filter(
                    (terminal) => !claims.deletedThreadIds.some((id) => id === terminal.threadId),
                  ),
                },
                null,
              ),
            );
          }
          if (
            input.expectedHead !== undefined &&
            (checked.registration?.headSha ?? null) !== input.expectedHead
          )
            checked.blockedReasons.push(
              "HEAD changed since inspection. Review the checkout again.",
            );
          if (claims.unknown) checked.blockedReasons.push("workspace usage could not be verified");
          if (
            isStorageCleanupPolicy(input.policy) &&
            !sameDiscardableChanges(checked.discardChanges, input.expectedDiscardChanges)
          )
            checked.blockedReasons.push(
              "Local changes differ from the reviewed ones. Rescan before removal.",
            );
          // The caller must stop all processes belonging to deleted/owned threads before locking.
          const owned = new Set<string>([
            ...checked.deletedThreadClaims,
            ...(input.policy.kind === "ownedRollback" && input.policy.ownThreadId
              ? [input.policy.ownThreadId]
              : []),
          ]);
          if (
            claims.sessions.some((session) => owned.has(session.threadId)) ||
            claims.terminals.some((terminal) => owned.has(terminal.threadId))
          )
            checked.blockedReasons.push(
              "owned or deleted conversation processes still use the checkout",
            );
          if (checked.blockedReasons.length === 0) {
            if (input.expectedRootIdentity !== undefined) {
              const stat = yield* Effect.tryPromise(() => FS.lstat(input.path)).pipe(
                Effect.orElseSucceed(() => null),
              );
              if (
                !input.expectedRootIdentity ||
                !stat?.isDirectory() ||
                stat.isSymbolicLink() ||
                stat.dev !== input.expectedRootIdentity.dev ||
                stat.ino !== input.expectedRootIdentity.ino
              ) {
                checked.blockedReasons.push(
                  "Worktree directory was replaced since inspection. Rescan before removal.",
                );
                return checked;
              }
            }
            if (input.isCancelled?.()) {
              checked.blockedReasons.push("Cleanup was cancelled.");
              return checked;
            }
            yield* git.removeWorktree({
              cwd: input.projectCwd,
              path: input.path,
              ignoredFiles: ignoredRemovalPolicy(input.policy),
              ...(isStorageCleanupPolicy(input.policy)
                ? {
                    allowDetachedHead: checked.headMerged,
                    ...(checked.discardChanges ? { discardChanges: checked.discardChanges } : {}),
                  }
                : {}),
            });
            if (maintenanceGate) yield* Scope.close(maintenanceGate, Exit.void);
            if (input.afterRemoval) yield* input.afterRemoval(checked.registration);
          }
          return checked;
        }),
      ),
    ),
  );
});

/** Stop deleted-thread processes before taking any lifecycle lock. */
export const stopDeletedWorktreeClaims = Effect.fn("stopDeletedWorktreeClaims")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const terminals = yield* TerminalManager;
  for (const threadId of threadIds) {
    yield* stopWorktreeSession(threadId);
    if (
      (yield* terminals.listSessions).some(
        (terminal) =>
          terminal.threadId === threadId &&
          (terminal.status === "starting" || terminal.status === "running"),
      )
    )
      yield* terminals.close({ threadId });
  }
});

/** Wait for an idle or deleted owner's provider session before taking lifecycle locks. */
export const stopWorktreeSession = Effect.fn("stopWorktreeSession")(function* (threadId: ThreadId) {
  const providers = yield* ProviderService;
  const isLive = Effect.gen(function* () {
    return (
      (yield* providers.listSessions()).some(
        (session) => session.threadId === threadId && session.status !== "closed",
      ) ||
      (yield* providers.listStartingWorkspaces?.() ?? Effect.succeed([])).some(
        (session) => session.threadId === threadId,
      )
    );
  });
  if (yield* isLive) {
    yield* providers.stopSession({ threadId });
    yield* Effect.gen(function* () {
      while (yield* isLive) yield* Effect.sleep("50 millis");
    }).pipe(Effect.timeout("10 seconds"));
  }
});
