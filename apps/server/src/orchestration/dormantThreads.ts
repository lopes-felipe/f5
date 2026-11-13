import type { OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

/**
 * Dormant threads: archived threads whose activities a bootstrap snapshot left
 * in SQLite (`dormantThreadIdsSql`). The engine loads one thread's activities
 * the first time a command or replayed event names it, and readers that look
 * at a thread without dispatching to it ask through `loadThreadActivities`.
 */

/** Thread ids are short. Longer strings are message text or attachments, not worth hashing. */
const MAX_THREAD_ID_LENGTH = 128;

/**
 * Archived threads with nothing loaded. Wider than the snapshot's own rule on
 * purpose, so the two can never disagree in the unsafe direction: a thread
 * listed here that had no activities to skip costs one empty read.
 */
export function unloadedDormantThreadIds(model: Pick<OrchestrationReadModel, "threads">) {
  const ids = new Set<string>();
  for (const thread of model.threads)
    if (thread.archivedAt !== null && thread.deletedAt === null && thread.activities.length === 0)
      ids.add(thread.id);
  return ids;
}

/** The members of `candidates` that appear anywhere in `value`, as a value or a key. */
export function referencedThreadIds(
  value: unknown,
  candidates: ReadonlySet<string>,
): ReadonlyArray<string> {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      if (current.length <= MAX_THREAD_ID_LENGTH && candidates.has(current)) found.add(current);
    } else if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
    } else if (current !== null && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) {
        if (candidates.has(key)) found.add(key);
        visit(entry);
      }
    }
  };
  visit(value);
  return [...found];
}

/** For readers of `thread.activities` that did not just dispatch to that thread. */
export const loadThreadActivities = (
  engine: {
    readonly loadThreadActivities?: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  },
  threadIds: ReadonlyArray<ThreadId>,
): Effect.Effect<void, ProjectionRepositoryError> =>
  engine.loadThreadActivities?.(threadIds) ?? Effect.void;
