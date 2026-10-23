import { useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ScheduledTaskId } from "@t3tools/contracts";
import { AppTitlebar } from "../components/AppTitlebar";
import { SidebarInset } from "../components/ui/sidebar";
import { ScheduledPage } from "../components/scheduled/ScheduledPage";
import { RouteErrorView } from "../components/RouteErrorView";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
function ScheduledRoute() {
  useDocumentTitle("Scheduled tasks");
  const { taskId, edit } = Route.useSearch();
  const navigate = Route.useNavigate();
  const clearEditRequest = useCallback(() => {
    void navigate({ search: taskId ? { taskId } : {}, replace: true });
  }, [navigate, taskId]);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Scheduled" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ScheduledPage
          {...(taskId ? { selectedTaskId: taskId } : {})}
          {...(taskId && edit ? { editTaskId: taskId } : {})}
          onEditRequestHandled={clearEditRequest}
        />
      </div>
    </SidebarInset>
  );
}
export const Route = createFileRoute("/_chat/scheduled")({
  validateSearch: (search: Record<string, unknown>): { taskId?: ScheduledTaskId; edit?: true } =>
    typeof search.taskId === "string" && search.taskId
      ? {
          taskId: ScheduledTaskId.makeUnsafe(search.taskId),
          ...(search.edit === true || search.edit === "true" ? { edit: true as const } : {}),
        }
      : {},
  component: ScheduledRoute,
  errorComponent: RouteErrorView,
});
