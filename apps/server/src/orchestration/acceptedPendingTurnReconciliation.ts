import type { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";

/** Cleanup must not suppress durable delivery outcomes or make queue snapshots unavailable. */
export const reconcileAcceptedPendingTurnStartsBestEffort = (
  turns: Pick<ProjectionTurnRepositoryShape, "reconcileAcceptedPendingTurnStarts">,
  threadId: ThreadId,
) =>
  turns.reconcileAcceptedPendingTurnStarts({ threadId }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("accepted pending turn reconciliation failed; retaining pending barrier", {
        threadId,
        error,
      }),
    ),
  );
