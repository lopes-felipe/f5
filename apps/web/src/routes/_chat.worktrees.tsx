import { createFileRoute } from "@tanstack/react-router";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { AppTitlebar } from "../components/AppTitlebar";
import { RouteErrorView } from "../components/RouteErrorView";
import { SidebarInset } from "../components/ui/sidebar";
import { WorktreesPage } from "../components/worktrees/WorktreesPage";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function WorktreesRouteView() {
  useDocumentTitle("Worktrees");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Worktrees" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorktreesPage
          search={search}
          onProjectChange={(projectId) =>
            void navigate({
              search: {
                ...(search.threadId ? { threadId: search.threadId } : {}),
                ...(projectId ? { projectId } : {}),
              },
            })
          }
        />
      </div>
    </SidebarInset>
  );
}

export interface WorktreesSearch {
  projectId?: ProjectId;
  threadId?: ThreadId;
}
export const Route = createFileRoute("/_chat/worktrees")({
  validateSearch: (search: Record<string, unknown>): WorktreesSearch => ({
    ...(typeof search.projectId === "string" && search.projectId
      ? { projectId: ProjectId.makeUnsafe(search.projectId) }
      : {}),
    ...(typeof search.threadId === "string" && search.threadId
      ? { threadId: ThreadId.makeUnsafe(search.threadId) }
      : {}),
  }),
  component: WorktreesRouteView,
  errorComponent: RouteErrorView,
});
