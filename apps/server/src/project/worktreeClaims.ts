import type { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { pathContains } from "./Layers/WorktreeLifecycleCoordinator.ts";

/**
 * Everything that currently relies on a worktree path. Removal is only safe
 * when nothing outside the caller's own thread holds a claim.
 */
export interface WorktreeClaims {
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
  const target = yield* canonical(path);
  if (target === null) {
    return { threadIds: [], queuedThreadIds: [], terminals: [], sessions: [] } as WorktreeClaims;
  }
  const inside = (candidate: string | null) =>
    candidate !== null && pathContains(target, candidate);

  const readModel = yield* engine.getReadModel();
  const threadIds: ThreadId[] = [];
  for (const thread of readModel.threads) {
    if (thread.deletedAt !== null || thread.worktreePath === null) continue;
    if ((yield* canonical(thread.worktreePath)) === target) threadIds.push(thread.id);
  }

  const queuedThreadIds: ThreadId[] = [];
  for (const threadId of threadIds) {
    const data = yield* queue.listByThread(threadId).pipe(Effect.orElseSucceed(() => null));
    // A storage error is treated as a claim: removal must never guess.
    if (data === null || data.items.length > 0) queuedThreadIds.push(threadId);
  }

  const liveTerminals: Array<{ threadId: string; terminalId: string; cwd: string }> = [];
  for (const terminal of yield* terminals.listSessions) {
    if (terminal.status !== "starting" && terminal.status !== "running") continue;
    if (inside(yield* canonical(terminal.cwd))) {
      liveTerminals.push({
        threadId: terminal.threadId,
        terminalId: terminal.terminalId,
        cwd: terminal.cwd,
      });
    }
  }

  const liveSessions: Array<{ threadId: string; cwd: string }> = [];
  for (const session of yield* providers.listSessions()) {
    if (session.status === "closed" || session.cwd === undefined) continue;
    if (inside(yield* canonical(session.cwd))) {
      liveSessions.push({ threadId: session.threadId, cwd: session.cwd });
    }
  }

  return {
    threadIds,
    queuedThreadIds,
    terminals: liveTerminals,
    sessions: liveSessions,
  } satisfies WorktreeClaims;
});

/** Claims held by anything other than `ownThreadId` and the given owned terminals. */
export function foreignClaims(
  claims: WorktreeClaims,
  ownThreadId: ThreadId | null,
  ownedTerminalIds: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const reasons: string[] = [];
  const otherThreads = claims.threadIds.filter((threadId) => threadId !== ownThreadId);
  if (otherThreads.length > 0) reasons.push(`used by ${otherThreads.length} other thread(s)`);
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
