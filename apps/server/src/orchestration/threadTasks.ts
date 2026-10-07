import {
  MAX_TASK_TOOL_HANDLED_CALL_IDS,
  MAX_TASK_TOOL_PENDING_CALLS,
  MAX_THREAD_TASKS,
  type TaskItem,
  type ThreadTaskTracking,
} from "@t3tools/contracts";

/**
 * Invariants shared by every task producer (TodoWrite, native Task tools) and
 * the decider. Native Task tools allow zero or several tasks in progress, so
 * the former "exactly one in_progress" rule no longer applies.
 */
export function validateThreadTasks(
  tasks: ReadonlyArray<Pick<TaskItem, "id" | "status">>,
): string | null {
  if (tasks.length > MAX_THREAD_TASKS) {
    return `A thread may track at most ${MAX_THREAD_TASKS} tasks.`;
  }
  const seenIds = new Set<string>();
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      return `Task ids must be unique; duplicate id '${task.id}' detected.`;
    }
    seenIds.add(task.id);
    if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "completed") {
      return `Task '${task.id}' has an invalid status.`;
    }
  }
  return null;
}

export function validateThreadTaskTracking(tracking: ThreadTaskTracking): string | null {
  if (tracking.pendingCalls.length > MAX_TASK_TOOL_PENDING_CALLS) {
    return `At most ${MAX_TASK_TOOL_PENDING_CALLS} task tool calls may be unresolved.`;
  }
  if (tracking.invalidatedCallIds.length > MAX_TASK_TOOL_PENDING_CALLS) {
    return `At most ${MAX_TASK_TOOL_PENDING_CALLS} invalidated task tool calls may be tracked.`;
  }
  if (tracking.handledCallIds.length > MAX_TASK_TOOL_HANDLED_CALL_IDS) {
    return `At most ${MAX_TASK_TOOL_HANDLED_CALL_IDS} handled task tool calls may be tracked.`;
  }
  if (
    tracking.provenance.length > MAX_THREAD_TASKS ||
    tracking.suppressedTaskIds.length > MAX_THREAD_TASKS
  ) {
    return `Task tracking may reference at most ${MAX_THREAD_TASKS} tasks.`;
  }
  return null;
}
