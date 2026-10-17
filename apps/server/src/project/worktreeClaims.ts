import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { legacyT3BaseDir } from "@t3tools/shared/appStatePaths";
import { ServerConfig } from "../config.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { WorktreeSetupGate } from "./Services/WorktreeSetupGate.ts";
import { type ThreadId, WorktreeSetupSnapshot, worktreeSetupGatesTurn } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";

import { GitCore, type GitCoreShape, type RegisteredWorktree } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
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
  for (const thread of readModel.threads) {
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    const workspace = thread.worktreePath ?? project?.workspaceRoot;
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
  const providerSessions = yield* providers.listSessions().pipe(
    Effect.orElseSucceed(() => {
      unknown = true;
      return [];
    }),
  );
  for (const session of providerSessions) {
    if (session.status === "closed") continue;
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
    deletedThreadIds,
    queuedThreadIds,
    terminals: liveTerminals,
    sessions: liveSessions,
  } satisfies WorktreeClaims;
});

/** `node_modules/` (at any depth) is reproducible; every other ignored entry is not. */
export function blockingIgnoredEntries(entries: ReadonlyArray<string>): ReadonlyArray<string> {
  return entries.filter((entry) => !/(^|\/)node_modules\/?$/.test(entry));
}

/**
 * Why ignored files make removing `worktreePath` unsafe, or null when they do
 * not. `git worktree remove` refuses on tracked changes and untracked files but
 * silently deletes ignored ones (a `.env`, a local database), so every removal
 * path checks this as well as `git status`.
 */
export const ignoredFilesBlockRemoval = (
  git: GitCoreShape,
  worktreePath: string,
  inspected?: { readonly entries: ReadonlyArray<string>; readonly truncated: boolean },
) =>
  (inspected ? Effect.succeed(inspected) : git.listIgnoredEntries(worktreePath)).pipe(
    Effect.map(({ entries, truncated }) => {
      if (truncated) return "too many ignored files to check";
      const blocking = blockingIgnoredEntries(entries);
      return blocking.length > 0
        ? `ignored files other than node_modules/ (${blocking.slice(0, 3).join(", ")})`
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
  if (otherSessions.length > 0) reasons.push("another agent session is running in it");
  return reasons;
}

export interface WorktreeRemovalPolicy {
  readonly kind:
    | "manual"
    | "autoCleanup"
    | "storageMaintenance"
    | "legacyCleanup"
    | "ownedRollback";
  readonly ownThreadId: ThreadId | null;
  readonly ownedCreation?: {
    readonly path: string;
    readonly commonDir: string;
    readonly baseSha: string;
    readonly created: boolean;
  };
}

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
  const target = yield* canonical(input.path);
  const root = yield* canonical(
    input.policy.kind === "legacyCleanup"
      ? Path.join(legacyT3BaseDir(), "worktrees")
      : config.worktreesDir,
  );
  if (!target || !root) blockedReasons.push("workspace identity could not be verified");
  else if (target === root || !pathContains(root, target))
    blockedReasons.push("outside the allowed worktrees root");
  const exists = yield* Effect.tryPromise(() => FS.lstat(input.path)).pipe(
    Effect.map(() => true),
    Effect.catch((error) => {
      if ((error.cause as NodeJS.ErrnoException)?.code !== "ENOENT")
        blockedReasons.push("worktree directory could not be inspected");
      return Effect.succeed(false);
    }),
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
  if (registration?.detached) blockedReasons.push("HEAD is detached");
  for (const project of (yield* engine.getReadModel()).projects) {
    if (project.deletedAt !== null) continue;
    const projectRoot = yield* canonical(project.workspaceRoot);
    if (!projectRoot) blockedReasons.push("a project root could not be verified");
    else if (target && pathContains(target, projectRoot))
      blockedReasons.push("it contains a project checkout");
  }
  const claims = yield* readWorktreeClaims(input.path);
  blockedReasons.push(
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
  if (exists) {
    const inspected = yield* git.inspectCheckout(input.path).pipe(Effect.orElseSucceed(() => null));
    if (!inspected) blockedReasons.push("checkout status could not be read");
    else {
      const common = yield* git.resolveCommonDir(input.projectCwd).pipe(
        Effect.flatMap(canonical),
        Effect.orElseSucceed(() => null),
      );
      if (inspected.canonicalRoot !== target || !common || common !== inspected.commonDir)
        blockedReasons.push("checkout identity does not match the expected repository");
      if (inspected.branch === null) blockedReasons.push("HEAD is detached");
      if (inspected.operation) blockedReasons.push(`a ${inspected.operation} is in progress`);
      if (inspected.hasTrackedChanges || inspected.hasUntrackedChanges)
        blockedReasons.push("it has uncommitted changes (including untracked files)");
      const ignoredReason = yield* ignoredFilesBlockRemoval(git, input.path, {
        entries: inspected.ignoredEntries,
        truncated: inspected.ignoredTruncated,
      });
      if (ignoredReason) blockedReasons.push(ignoredReason);
      if (
        input.policy.kind === "storageMaintenance" &&
        (inspected.aheadCount === null || inspected.aheadCount > 0)
      )
        blockedReasons.push("unpushed commits could not be ruled out");
      if (input.policy.kind === "ownedRollback") {
        const proof = input.policy.ownedCreation;
        if (
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
    blockedReasons: [...new Set(blockedReasons)],
    linkedThreads: claims.threadIds,
    deletedThreadClaims: claims.deletedThreadIds,
  };
});

/** Every caller uses the same preview and locked re-evaluation, including rollback. */
export const removeWorktreeSafely = Effect.fn("removeWorktreeSafely")(function* (input: {
  readonly projectCwd: string;
  readonly path: string;
  readonly policy: WorktreeRemovalPolicy;
}) {
  const git = yield* GitCore;
  const config = yield* ServerConfig;
  const preview = yield* evaluateWorktreeRemoval(input);
  if (preview.blockedReasons.length) return preview;
  const common = yield* git.resolveCommonDir(input.projectCwd);
  return yield* withWorktreeLifecycleLock(
    input.path,
    withRepositoryLifecycleLock(
      config.baseDir,
      common,
      Effect.gen(function* () {
        const checked = yield* evaluateWorktreeRemoval(input);
        const claims = yield* readWorktreeClaims(input.path);
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
        if (checked.blockedReasons.length === 0)
          yield* git.removeWorktree({ cwd: input.projectCwd, path: input.path });
        return checked;
      }),
    ),
  );
});

/** Stop deleted-thread processes before taking any lifecycle lock. */
export const stopDeletedWorktreeClaims = Effect.fn("stopDeletedWorktreeClaims")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const providers = yield* ProviderService;
  const terminals = yield* TerminalManager;
  for (const threadId of threadIds) {
    if (
      (yield* providers.listSessions()).some(
        (session) => session.threadId === threadId && session.status !== "closed",
      )
    ) {
      yield* providers.stopSession({ threadId });
      yield* Effect.gen(function* () {
        while (
          (yield* providers.listSessions()).some(
            (session) => session.threadId === threadId && session.status !== "closed",
          )
        )
          yield* Effect.sleep("50 millis");
      }).pipe(Effect.timeout("10 seconds"));
    }
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
