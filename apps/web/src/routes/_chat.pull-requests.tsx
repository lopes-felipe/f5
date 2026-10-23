import { lazy, Suspense } from "react";
import { parsePullRequestReference } from "../lib/pullRequestReference";
import { createFileRoute } from "@tanstack/react-router";

import { RouteErrorView } from "../components/RouteErrorView";

import { PullRequestsView } from "../components/prHub/PullRequestsView";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SidebarInset } from "../components/ui/sidebar";

const PrLinkedPanel = lazy(() => import("../components/prHub/PrLinkedPanel"));

function PullRequestsRouteView() {
  const search = Route.useSearch();
  useDocumentTitle("Pull Requests");

  // PullRequestsView renders its own title bar so the view toggle and
  // refresh actions sit in the same row as the breadcrumb.
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        {search.url ? (
          <Suspense fallback={<p>Loading pull request…</p>}>
            <PrLinkedPanel url={search.url} />
          </Suspense>
        ) : (
          <PullRequestsView focusedPrKey={search.pr ?? null} />
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (input): { pr?: string; url?: string } => {
    const url = (input as { url?: unknown }).url;
    if (typeof url === "string" && url.length <= 4096 && parsePullRequestReference(url))
      return { url };
    const raw = (input as { pr?: unknown }).pr;
    return typeof raw === "string" && raw.trim().length > 0 ? { pr: raw } : {};
  },
  component: PullRequestsRouteView,
  errorComponent: RouteErrorView,
});
