import { createFileRoute } from "@tanstack/react-router";

import { PullRequestsView } from "../components/prHub/PullRequestsView";
import { SidebarInset } from "../components/ui/sidebar";

function PullRequestsRouteView() {
  const search = Route.useSearch();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <PullRequestsView focusedPrKey={search.pr ?? null} />
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
