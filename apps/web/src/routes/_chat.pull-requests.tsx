import { lazy, Suspense } from "react";
import { parsePullRequestReference } from "../lib/pullRequestReference";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { RouteErrorView } from "../components/RouteErrorView";

import { PrQueueView } from "../components/prHub/PrQueueView";
import { parsePrQueueSearch, type PrQueueSearch } from "../components/prHub/prQueueSearch";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SidebarInset } from "../components/ui/sidebar";

const PrLinkedPanel = lazy(() => import("../components/prHub/PrLinkedPanel"));

const SETTINGS_TARGETS = {
  accounts: { category: "accounts", item: "accounts.forges" },
  github: { category: "accounts", item: "accounts.github" },
  prHub: { category: "git", item: "git.pr-stale" },
} as const;

function PullRequestsRouteView() {
  const { url, ...search } = Route.useSearch();
  const navigate = useNavigate();
  useDocumentTitle("Pull Requests");

  // The queue renders its own title bar so its status and menu share the breadcrumb row.
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        {url ? (
          <Suspense fallback={<p>Loading pull request…</p>}>
            <PrLinkedPanel url={url} />
          </Suspense>
        ) : (
          <PrQueueView
            search={search}
            onSearchChange={(next, options) =>
              void navigate({
                to: "/pull-requests",
                search: next,
                replace: options?.replace ?? false,
              })
            }
            onOpenThread={(threadId) => void navigate({ to: "/$threadId", params: { threadId } })}
            onOpenSettings={(target) =>
              void navigate({ to: "/settings", search: SETTINGS_TARGETS[target] })
            }
          />
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (input): PrQueueSearch & { url?: string } => {
    const url = (input as { url?: unknown }).url;
    if (typeof url === "string" && url.length <= 4096 && parsePullRequestReference(url))
      return { url };
    return parsePrQueueSearch(input);
  },
  component: PullRequestsRouteView,
  errorComponent: RouteErrorView,
});
