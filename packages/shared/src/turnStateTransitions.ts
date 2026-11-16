import type { OrchestrationLatestTurn, OrchestrationSession, TurnId } from "@t3tools/contracts";

export function canRepairErroredTurnFromSuccessfulSettlement(
  previous: {
    readonly turnId: string;
    readonly state: string;
    readonly completedAt: string | null;
  },
  settledTurnId: string | undefined,
  settlementAt: string,
): boolean {
  return (
    previous.state === "error" &&
    previous.turnId === settledTurnId &&
    (previous.completedAt === null || settlementAt >= previous.completedAt)
  );
}

/** Keep live push settlement identical to the authoritative read model. */
export function projectLatestTurnSession(
  previous: OrchestrationLatestTurn | null,
  payload: { readonly session: OrchestrationSession; readonly settledTurnId?: TurnId | undefined },
): OrchestrationLatestTurn | null {
  const { session, settledTurnId } = payload;
  if (session.status === "running" && session.activeTurnId !== null) {
    const same = previous?.turnId === session.activeTurnId ? previous : null;
    return {
      turnId: session.activeTurnId,
      state: "running",
      requestedAt: same?.requestedAt ?? session.updatedAt,
      startedAt: same?.startedAt ?? session.updatedAt,
      completedAt: null,
      processingQuiescedAt: null,
      assistantMessageId: same?.assistantMessageId ?? null,
      ...(session.workflowExecutionProfile
        ? { workflowExecutionProfile: session.workflowExecutionProfile }
        : {}),
    };
  }
  if (!previous) return previous;
  const state =
    session.status === "ready"
      ? "completed"
      : session.status === "error"
        ? "error"
        : session.status === "stopped"
          ? "interrupted"
          : null;
  if (state === null) return previous;
  const settlesRunning =
    previous.state === "running" &&
    (settledTurnId === undefined || previous.turnId === settledTurnId);
  const repairsError =
    state === "completed" &&
    canRepairErroredTurnFromSuccessfulSettlement(previous, settledTurnId, session.updatedAt);
  if (!settlesRunning && !repairsError) return previous;
  return {
    ...previous,
    state,
    startedAt: settlesRunning ? (previous.startedAt ?? session.updatedAt) : previous.startedAt,
    completedAt: session.updatedAt,
  };
}
