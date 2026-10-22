import { createFileRoute } from "@tanstack/react-router";

import { AppTitlebar } from "../components/AppTitlebar";
import { RouteErrorView } from "../components/RouteErrorView";
import { SidebarInset } from "../components/ui/sidebar";
import { UpstreamPage } from "../components/upstream/UpstreamPage";
// Keep the eagerly loaded route definition free of page helpers.
import { validateUpstreamSearch } from "../components/upstream/upstreamSearch";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function UpstreamRouteView() {
  useDocumentTitle("Upstream");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Upstream" }]} />
      <div className="min-h-0 flex-1">
        <UpstreamPage
          search={search}
          onSearchChange={(next) =>
            void navigate({
              replace: true,
              search: {
                ...(next.project ? { project: next.project } : {}),
                ...(next.list && next.list !== "inbox" ? { list: next.list } : {}),
                ...(next.topic ? { topic: next.topic } : {}),
              },
            })
          }
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/upstream")({
  validateSearch: validateUpstreamSearch,
  component: UpstreamRouteView,
  errorComponent: RouteErrorView,
});
