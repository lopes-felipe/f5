import type { TaskItem, ThreadTaskTracking, TurnId } from "@t3tools/contracts";
import { revertTaskToolState } from "./claudeTaskToolProjection";

interface NativeTurnRow {
  readonly turnId?: string | null;
}

/** Unknown/unlocated turns belong to their existing owner; absence is not evidence. */
export function retainNativeTurnRows<T extends NativeTurnRow>(
  rows: readonly T[],
  removed: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => row.turnId == null || !removed.has(row.turnId));
}

/** Shared by persisted-server and browser projections; native rewinds never restore files. */
export function reconcileNativeHistoryProjection<
  M extends NativeTurnRow & { readonly id?: string },
  P extends NativeTurnRow,
  A extends NativeTurnRow,
  L extends { readonly turnId: string },
>(
  thread: {
    readonly messages: readonly M[];
    readonly proposedPlans: readonly P[];
    readonly activities: readonly A[];
    readonly latestTurn: L | null;
    readonly tasks: readonly TaskItem[];
    readonly tasksTurnId: TurnId | null;
    readonly tasksUpdatedAt: string | null;
    readonly tasksTracking?: ThreadTaskTracking | null | undefined;
  },
  removed: ReadonlySet<string>,
  removedMessageIds: ReadonlySet<string> = new Set(),
) {
  const tracking = thread.tasksTracking;
  const tasks = tracking
    ? revertTaskToolState({ tasks: thread.tasks, tracking }, undefined, { removedTurnIds: removed })
    : {
        tasks: thread.tasksTurnId !== null && removed.has(thread.tasksTurnId) ? [] : thread.tasks,
        tracking: null,
      };
  const removedTasks = thread.tasksTurnId !== null && removed.has(thread.tasksTurnId);
  return {
    messages: retainNativeTurnRows(thread.messages, removed).filter(
      (message) => message.id === undefined || !removedMessageIds.has(message.id),
    ),
    proposedPlans: retainNativeTurnRows(thread.proposedPlans, removed),
    activities: retainNativeTurnRows(thread.activities, removed),
    latestTurn:
      thread.latestTurn && removed.has(thread.latestTurn.turnId) ? null : thread.latestTurn,
    tasks: [...tasks.tasks],
    tasksTracking: tasks.tracking,
    tasksTurnId: removedTasks ? null : thread.tasksTurnId,
    tasksUpdatedAt: removedTasks ? null : thread.tasksUpdatedAt,
    compaction: null,
    estimatedContextTokens: null,
  };
}
