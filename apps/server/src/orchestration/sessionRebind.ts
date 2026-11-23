/**
 * Turn carry-over for a re-bound provider session.
 *
 * A refresh (worktree, model or MCP change) re-binds the session a thread
 * already runs. The adapter's record knows nothing about the turn the
 * projection tracks, so the bind writes no turn. The decider resolves the
 * carry-over against current state, at write time, so a turn that settled
 * while the refresh ran is never brought back.
 *
 * @module orchestration/sessionRebind
 */
import type { OrchestrationReadModel, OrchestrationSession } from "@t3tools/contracts";

type ThreadTurnState = Pick<OrchestrationReadModel["threads"][number], "session" | "latestTurn">;

/**
 * Keeps the running turn only when the bound session is the same live session
 * (provider and instance), both sides report `running`, and the thread's latest
 * turn is that turn and still running. `updatedAt` then never moves back to the
 * adapter's older record. Anything else writes the session as given.
 */
export function resolveRebindSessionTurn(
  current: ThreadTurnState,
  incoming: OrchestrationSession,
): OrchestrationSession {
  const previous = current.session;
  const turnId = previous?.activeTurnId ?? null;
  if (
    incoming.status !== "running" ||
    previous == null ||
    previous.status !== "running" ||
    turnId === null ||
    previous.providerName !== incoming.providerName ||
    (previous.providerInstanceId ?? null) !== (incoming.providerInstanceId ?? null) ||
    current.latestTurn?.turnId !== turnId ||
    current.latestTurn.state !== "running"
  ) {
    return incoming;
  }
  return {
    ...incoming,
    activeTurnId: turnId,
    updatedAt: previous.updatedAt > incoming.updatedAt ? previous.updatedAt : incoming.updatedAt,
  };
}
