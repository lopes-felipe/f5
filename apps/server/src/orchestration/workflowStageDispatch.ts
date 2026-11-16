import type { CommandId, TurnId } from "@t3tools/contracts";
import { Cause, Effect } from "effect";

import { ProviderTurnDeliveryRepository } from "./Services/ProviderTurnDeliveryRepository.ts";

/**
 * Which provider turn may complete a running workflow stage.
 *
 * - `any`: the stage has no recorded dispatch (a legacy stage) or the server
 *   runs without a delivery outbox, so any finished turn on the stage thread
 *   counts, as before.
 * - `pending`: the stage's turn has not been accepted by the provider yet, its
 *   delivery failed, or its delivery row does not exist yet. Stages save their
 *   dispatch id before dispatching, and the row is written with the
 *   turn-start event, so in that window no finished turn belongs to the stage.
 * - `turn`: only the provider turn accepted for the stage's dispatch counts.
 */
export type WorkflowStageDispatchTurn =
  | { readonly kind: "any" }
  | { readonly kind: "pending" }
  | { readonly kind: "turn"; readonly turnId: TurnId };

/**
 * Upper bound for the startup recheck of a finished stage's delivery. It runs
 * before the workflow services subscribe to domain events and can call the
 * provider, so it must not stretch that window.
 */
export const STARTUP_DISPATCH_RECHECK_TIMEOUT = "5 seconds";

const ANY: WorkflowStageDispatchTurn = { kind: "any" };
const PENDING: WorkflowStageDispatchTurn = { kind: "pending" };

export function stageDispatchAllowsTurn(
  dispatch: WorkflowStageDispatchTurn,
  turnId: string,
): boolean {
  switch (dispatch.kind) {
    case "any":
      return true;
    case "pending":
      return false;
    case "turn":
      return dispatch.turnId === turnId;
  }
}

/**
 * Resolves a stage's dispatch command to the provider turn it started, using
 * the durable delivery row written with the turn-start event. Read failures
 * are treated as `pending` so a transient error never completes a stage with
 * the wrong turn; the next thread event or delivery outcome retries.
 */
export const makeWorkflowStageDispatchResolver = Effect.gen(function* () {
  const repository = yield* Effect.serviceOption(ProviderTurnDeliveryRepository);
  return (
    dispatchCommandId: CommandId | null | undefined,
  ): Effect.Effect<WorkflowStageDispatchTurn> => {
    if (!dispatchCommandId || repository._tag === "None") {
      return Effect.succeed(ANY);
    }
    return repository.value.getByCommandId(dispatchCommandId).pipe(
      Effect.map((delivery): WorkflowStageDispatchTurn => {
        if (delivery?.state === "accepted" && delivery.providerTurnId !== null) {
          return { kind: "turn", turnId: delivery.providerTurnId };
        }
        return PENDING;
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow stage dispatch lookup failed", {
          dispatchCommandId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(PENDING)),
      ),
    );
  };
});
