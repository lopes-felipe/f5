import { useCallback, useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { ScheduledPage } from "./ScheduledPage";

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

/** The Scheduled page driven by its URL: the filter, task deep links and conversation requests. */
export function ScheduledRouteContent() {
  const { projectId, taskId, edit, threadId } = useSearch({ strict: false }) as ScheduledSearch;
  const navigate = useNavigate();
  const replace = useCallback(
    (search: ScheduledSearch) => void navigate({ to: ".", search, replace: true }),
    [navigate],
  );
  // A task link wins over a conversation, which wins over a project filter.
  useEffect(() => {
    if (taskId && (projectId || threadId)) replace({ taskId, ...(edit ? { edit } : {}) });
  }, [replace, taskId, edit, projectId, threadId]);
  const clearEditRequest = useCallback(() => {
    replace({
      ...(projectId ? { projectId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(threadId ? { threadId } : {}),
    });
  }, [replace, projectId, taskId, threadId]);
  const clearThreadRequest = useCallback(() => {
    replace({
      ...(projectId ? { projectId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(edit ? { edit } : {}),
    });
  }, [replace, projectId, taskId, edit]);
  // Choosing a filter is a new history entry and leaves any selected task.
  const changeProjectFilter = useCallback(
    (next: ProjectId | undefined) =>
      void navigate({ to: ".", search: next ? { projectId: next } : {} }),
    [navigate],
  );
  return (
    <ScheduledPage
      {...(!taskId && projectId ? { projectFilter: projectId } : {})}
      {...(taskId ? { selectedTaskId: taskId } : {})}
      {...(taskId && edit ? { editTaskId: taskId } : {})}
      {...(!taskId && threadId ? { newTaskThreadId: threadId } : {})}
      onProjectFilterChange={changeProjectFilter}
      onEditRequestHandled={clearEditRequest}
      onThreadRequestHandled={clearThreadRequest}
    />
  );
}
