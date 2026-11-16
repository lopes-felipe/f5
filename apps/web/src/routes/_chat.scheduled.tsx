import { createFileRoute } from "@tanstack/react-router";
import { AppTitlebar } from "../components/AppTitlebar";
import { SidebarInset } from "../components/ui/sidebar";
import { ScheduledRouteContent } from "../components/scheduled/ScheduledRouteContent";
import { parseScheduledSearch } from "../components/scheduled/scheduledSearch";
import { RouteErrorView } from "../components/RouteErrorView";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function ScheduledRoute() {
  useDocumentTitle("Scheduled tasks");
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Scheduled" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ScheduledRouteContent />
      </div>
    </SidebarInset>
  );
}
export const Route = createFileRoute("/_chat/scheduled")({
  validateSearch: parseScheduledSearch,
  component: ScheduledRoute,
  errorComponent: RouteErrorView,
});
