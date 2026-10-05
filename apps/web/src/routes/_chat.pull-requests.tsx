import { createFileRoute } from "@tanstack/react-router";

import { PullRequestsView } from "../components/prHub/PullRequestsView";
import { SidebarInset } from "../components/ui/sidebar";

function PullRequestsRouteView() {
  const search = Route.useSearch();

  // PullRequestsView renders its own title bar so the view toggle and
  // refresh actions sit in the same row as the breadcrumb.
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <PullRequestsView focusedPrKey={search.pr ?? null} />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (input): { pr?: string } => {
    const raw = (input as { pr?: unknown }).pr;
    return typeof raw === "string" && raw.trim().length > 0 ? { pr: raw } : {};
  },
  component: PullRequestsRouteView,
});
