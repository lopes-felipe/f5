import { ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";

/**
 * Search parameters of the Scheduled page. Kept apart from the page: the route's
 * `validateSearch` is not code-split, so anything it imports loads at startup.
 */
export interface ScheduledSearch {
  projectId?: ProjectId;
  taskId?: ScheduledTaskId;
  edit?: true;
  threadId?: ThreadId;
}
/** Each parameter parses independently; `edit` only applies to a task. */
export function parseScheduledSearch(search: Record<string, unknown>): ScheduledSearch {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const projectId = text(search.projectId),
    taskId = text(search.taskId),
    threadId = text(search.threadId);
  return {
    ...(projectId ? { projectId: ProjectId.makeUnsafe(projectId) } : {}),
    ...(taskId ? { taskId: ScheduledTaskId.makeUnsafe(taskId) } : {}),
    ...(taskId && (search.edit === true || search.edit === "true") ? { edit: true as const } : {}),
    ...(threadId ? { threadId: ThreadId.makeUnsafe(threadId) } : {}),
  };
}
