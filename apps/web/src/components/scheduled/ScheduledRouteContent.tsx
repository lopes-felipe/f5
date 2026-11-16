import { useCallback, useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ProjectId } from "@t3tools/contracts";
import { ScheduledPage } from "./ScheduledPage";
import type { ScheduledSearch } from "./scheduledSearch";

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
