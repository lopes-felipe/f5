/**
 * Cold threads: threads that were already archived when the server started.
 *
 * Their activity history stays in SQLite instead of the in-memory read model;
 * on a large profile it is most of the startup time and heap. A cold thread
 * keeps its worktree-setup activity only, because worktree claims are read
 * across every thread without a command to announce them. It carries
 * `activitiesOmitted`, so a reader can tell it from a thread with no history.
 *
 * A thread stops being cold the first time an event reaches it or a reader
 * asks for its activities: the engine loads its retained activities and keeps
 * them for the rest of the run. Threads archived during a run are never made
 * cold, so work that is still finishing on them sees the same read model as
 * before.
 */
import {
  WORKTREE_SETUP_ACTIVITY_KIND,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";

type ThreadActivities = OrchestrationThread["activities"];

/** The activities a cold thread keeps in memory. */
export const isColdRetainedActivity = (activity: Pick<ThreadActivities[number], "kind">) =>
  activity.kind === WORKTREE_SETUP_ACTIVITY_KIND;

/** Threads a bootstrap snapshot loaded without their activity history. */
export function coldThreadIdsOf(model: OrchestrationReadModel): Set<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const thread of model.threads) if (thread.activitiesOmitted === true) ids.add(thread.id);
  return ids;
}

/** The thread an event belongs to, when it belongs to one. */
export const eventThreadId = (event: Pick<OrchestrationEvent, "aggregateKind" | "aggregateId">) =>
  event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;

/**
 * Gives the named threads their loaded activities and clears
 * `activitiesOmitted`; other threads keep their identity.
 */
export function withThreadActivities(
  model: OrchestrationReadModel,
  activitiesByThread: ReadonlyMap<ThreadId, ThreadActivities>,
): OrchestrationReadModel {
  if (activitiesByThread.size === 0) return model;
  let changed = false;
  const threads = model.threads.map((thread) => {
    const activities = activitiesByThread.get(thread.id);
    if (activities === undefined) return thread;
    changed = true;
    const { activitiesOmitted: _omitted, ...loaded } = thread;
    return { ...loaded, activities };
  });
  return changed ? { ...model, threads } : model;
}
