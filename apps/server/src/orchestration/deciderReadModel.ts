import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export type RetainedThreadDetails = Pick<
  OrchestrationThread,
  "messages" | "proposedPlans" | "activities"
>;

/** Deleted history stays in SQLite; command decisions retain their existing semantics. */
export const hydrateDeciderReadModel = (
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
  read: (id: ThreadId) => Effect.Effect<RetainedThreadDetails, ProjectionRepositoryError>,
) =>
  Effect.gen(function* () {
    const ids = new Set<ThreadId>();
    if ("threadId" in command) ids.add(command.threadId);
    if (command.type === "thread.turn.start" && command.sourceProposedPlan)
      ids.add(command.sourceProposedPlan.threadId);
    let threads = model.threads;
    for (const id of ids) {
      const thread = threads.find((thread) => thread.id === id);
      if (!thread || thread.deletedAt === null) continue;
      const details = yield* read(id);
      threads = threads.map((current) =>
        current.id === id ? { ...current, ...details } : current,
      );
    }
    return threads === model.threads ? model : { ...model, threads };
  });

export function withoutDeletedThreadDetails(model: OrchestrationReadModel): OrchestrationReadModel {
  let changed = false;
  const threads = model.threads.map((thread) => {
    if (
      thread.deletedAt === null ||
      (!thread.messages.length && !thread.proposedPlans.length && !thread.activities.length)
    )
      return thread;
    changed = true;
    return { ...thread, messages: [], proposedPlans: [], activities: [] };
  });
  return changed ? { ...model, threads } : model;
}
