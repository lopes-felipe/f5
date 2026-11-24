import type { OrchestrationEvent } from "@t3tools/contracts";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

export interface CostedWorkflow {
  readonly totalCostUsd?: number | undefined;
  readonly maxCostUsd?: number | null | undefined;
  readonly updatedAt: string;
}

function addUsd(left: number, right: number): number {
  return Number((left + right).toFixed(6));
}

export function workflowSessionTurnCost(
  event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
) {
  // Capability snapshots can carry the last turn's cost even when no new turn ended.
  if (
    event.commandId?.endsWith(":thread-session-capabilities-set") ||
    event.commandId?.endsWith(":thread-session-capabilities-turn")
  )
    return undefined;
  return event.payload.session.turnCostUsd;
}

export function applyWorkflowTurnCost<T extends CostedWorkflow>(
  workflow: T,
  turnCostUsd: number | undefined,
  updatedAt: string,
): T {
  if (turnCostUsd === undefined || !Number.isFinite(turnCostUsd) || turnCostUsd <= 0) {
    return workflow;
  }
  return {
    ...workflow,
    totalCostUsd: addUsd(workflow.totalCostUsd ?? 0, turnCostUsd),
    updatedAt,
  };
}

export function workflowBudgetError(
  workflow: CostedWorkflow,
): OrchestrationCommandInvariantError | null {
  const maximum = workflow.maxCostUsd;
  if (maximum === null || maximum === undefined) return null;
  const total = workflow.totalCostUsd ?? 0;
  if (total < maximum) return null;
  return new OrchestrationCommandInvariantError({
    commandType: "thread.turn.start",
    detail: `Workflow cost limit reached ($${total.toFixed(4)} of $${maximum.toFixed(4)}). Increase the limit before launching another node.`,
  });
}
