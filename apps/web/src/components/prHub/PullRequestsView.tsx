import { useEffect, useMemo, useState } from "react";
import {
  GitPullRequestIcon,
  InboxIcon,
  RefreshCwIcon,
  SparklesIcon,
  TargetIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { PullRequestKey, ThreadId, TrackedPullRequest } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { prHubAdvisoriesQueryOptions, prHubSnapshotQueryOptions } from "../../lib/prHubReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { onPrHubAdvisoriesUpdated, onPrHubUpdated } from "../../wsNativeApi";
import { Button } from "../ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { TooltipProvider } from "../ui/tooltip";
import { PrInboxView } from "./PrInboxView";
import { PrFocusView } from "./PrFocusView";
import { PR_HUB_VIEW_MODE_STORAGE_KEY, type PrHubViewMode } from "./prHubPresentation";

type PrHubFilter =
  | "needs_my_review"
  | "my_prs_need_action"
  | "waiting"
  | "ready_to_merge"
  | "ci_failing"
  | "draft"
  | "mentioned"
  | "snoozed"
  | "recently_resolved";

const FILTER_LABELS: Record<PrHubFilter, string> = {
  needs_my_review: "Needs my review",
  my_prs_need_action: "My PRs",
  waiting: "Waiting",
  ready_to_merge: "Ready",
  ci_failing: "CI failing",
  draft: "Draft",
  mentioned: "Mentioned",
  snoozed: "Snoozed",
  recently_resolved: "Resolved",
};

function isSnoozed(pr: TrackedPullRequest): boolean {
  if (!pr.snoozedUntil) return false;
  const timestamp = new Date(pr.snoozedUntil).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function isIgnored(pr: TrackedPullRequest): boolean {
  return pr.ignoredAt !== null;
}

function matchesFilter(pr: TrackedPullRequest, filter: PrHubFilter): boolean {
  if (filter !== "recently_resolved" && isIgnored(pr)) {
    return false;
  }
  if (filter !== "recently_resolved" && filter !== "snoozed" && isSnoozed(pr)) {
    return false;
  }

  switch (filter) {
    case "needs_my_review":
      return (
        !pr.roles.includes("author") &&
        (pr.attentionState === "review_requested" || pr.attentionState === "re_review_requested")
      );
    case "my_prs_need_action":
      return pr.roles.includes("author") && pr.attentionBucket === "needs_you";
    case "waiting":
      return pr.attentionBucket === "waiting_on_others";
    case "ready_to_merge":
      return pr.attentionState === "ready_to_merge";
    case "ci_failing":
      return pr.attentionState === "ci_failing";
    case "draft":
      return pr.attentionState === "draft";
    case "mentioned":
      return pr.attentionState === "mentioned";
    case "snoozed":
      return isSnoozed(pr);
    case "recently_resolved":
      return pr.state !== "open" || isIgnored(pr);
  }
}

function preferredFilterForPr(pr: TrackedPullRequest): PrHubFilter {
  if (pr.state !== "open" || isIgnored(pr)) return "recently_resolved";
  if (isSnoozed(pr)) return "snoozed";

  const filters: readonly PrHubFilter[] = [
    "needs_my_review",
    "my_prs_need_action",
    "waiting",
    "ready_to_merge",
    "ci_failing",
    "draft",
    "mentioned",
  ];
  return filters.find((candidate) => matchesFilter(pr, candidate)) ?? "mentioned";
}

function statusMessage(status: string): string | null {
  switch (status) {
    case "auth_required":
      return "GitHub authentication required. Run `gh auth login`.";
    case "gh_missing":
      return "GitHub CLI is missing. Install `gh` and restart F5.";
    case "degraded":
      return "PR Hub is using degraded GitHub search data.";
    case "error":
      return "PR Hub refresh failed.";
    default:
      return null;
  }
}

function compactStatusDetail(message: string | undefined): string | null {
  if (!message) return null;
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const httpStatus = normalized.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  if (httpStatus) {
    return `GitHub API returned HTTP ${httpStatus}. Fallback results may be incomplete.`;
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("secondary rate")) {
    return "GitHub API rate limit reached. Fallback results may be incomplete.";
  }
  if (lower.includes("gh auth login") || lower.includes("not authenticated")) {
    return "GitHub authentication is required.";
  }
  if (lower.includes("command not found") || lower.includes("not available on path")) {
    return "GitHub CLI is not available on PATH.";
  }

  const firstSentence = normalized.match(/^[^.!?]+[.!?]/)?.[0] ?? normalized;
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177)}...` : firstSentence;
}

export function PullRequestsView({ focusedPrKey }: { focusedPrKey: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const snapshotQuery = useQuery(prHubSnapshotQueryOptions());
  const [filter, setFilter] = useState<PrHubFilter>("needs_my_review");
  const [viewMode, setViewMode] = useState<PrHubViewMode>(() => {
    if (typeof window === "undefined") return "inbox";
    const stored = window.localStorage.getItem(PR_HUB_VIEW_MODE_STORAGE_KEY);
    return stored === "focus" || stored === "inbox" ? stored : "inbox";
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzingKeys, setAnalyzingKeys] = useState<ReadonlySet<PullRequestKey>>(
    new Set<PullRequestKey>(),
  );
  const snapshot = snapshotQuery.data;
  const advisoryKeys = useMemo(
    () =>
      snapshot ? [...snapshot.pullRequests, ...snapshot.recentlyResolved].map((pr) => pr.key) : [],
    [snapshot],
  );
  const advisoriesQuery = useQuery({
    ...prHubAdvisoriesQueryOptions(advisoryKeys),
    enabled: advisoryKeys.length > 0,
  });

  useEffect(() => {
    const unsubscribe = onPrHubUpdated((nextSnapshot) => {
      queryClient.setQueryData(prHubSnapshotQueryOptions().queryKey, nextSnapshot);
    });
    return unsubscribe;
  }, [queryClient]);

  useEffect(() => {
    const unsubscribe = onPrHubAdvisoriesUpdated((nextSnapshot) => {
      queryClient.setQueryData(prHubAdvisoriesQueryOptions(advisoryKeys).queryKey, nextSnapshot);
    });
    return unsubscribe;
  }, [advisoryKeys, queryClient]);

  useEffect(() => {
    if (!snapshot) return;
    for (const pr of snapshot.pullRequests) {
      if (!pr.notificationPending) continue;
      void ensureNativeApi().prHub.markSeen({
        key: pr.key,
        attentionFingerprint: pr.attentionFingerprint,
      });
    }
  }, [snapshot]);

  const counts = useMemo(() => {
    const pullRequests = snapshot?.pullRequests ?? [];
    return {
      needs_my_review: pullRequests.filter((pr) => matchesFilter(pr, "needs_my_review")).length,
      my_prs_need_action: pullRequests.filter((pr) => matchesFilter(pr, "my_prs_need_action"))
        .length,
      waiting: pullRequests.filter((pr) => matchesFilter(pr, "waiting")).length,
      ready_to_merge: pullRequests.filter((pr) => matchesFilter(pr, "ready_to_merge")).length,
      ci_failing: pullRequests.filter((pr) => matchesFilter(pr, "ci_failing")).length,
      draft: pullRequests.filter((pr) => matchesFilter(pr, "draft")).length,
      mentioned: pullRequests.filter((pr) => matchesFilter(pr, "mentioned")).length,
      snoozed: pullRequests.filter((pr) => matchesFilter(pr, "snoozed")).length,
      recently_resolved: snapshot?.recentlyResolved.length ?? 0,
    } satisfies Record<PrHubFilter, number>;
  }, [snapshot]);

  const visiblePullRequests = useMemo(() => {
    if (!snapshot) return [];
    if (filter === "recently_resolved") return snapshot.recentlyResolved;
    return snapshot.pullRequests.filter((pr) => matchesFilter(pr, filter));
  }, [filter, snapshot]);
  const advisoriesByKey = useMemo(
    () =>
      new Map((advisoriesQuery.data?.advisories ?? []).map((advisory) => [advisory.key, advisory])),
    [advisoriesQuery.data],
  );

  const focusedPr = useMemo(() => {
    if (!snapshot || !focusedPrKey) return null;
    return (
      snapshot.pullRequests.find((pr) => pr.key === focusedPrKey) ??
      snapshot.recentlyResolved.find((pr) => pr.key === focusedPrKey) ??
      null
    );
  }, [focusedPrKey, snapshot]);

  useEffect(() => {
    if (!focusedPr) return;
    const nextFilter = preferredFilterForPr(focusedPr);
    setFilter((current) => (current === nextFilter ? current : nextFilter));
  }, [focusedPr]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PR_HUB_VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  const banner = snapshot ? statusMessage(snapshot.status) : null;
  const bannerDetail = compactStatusDetail(snapshot?.errorMessage);
  const analyzeKeys = async (keys?: readonly PullRequestKey[]) => {
    if (keys?.length) setAnalyzingKeys(new Set(keys));
    else setIsAnalyzing(true);
    try {
      const result = await ensureNativeApi().prHub.analyzeAdvisories({
        ...(keys?.length ? { keys: [...keys] } : {}),
        mode: keys?.length ? "force" : "stale_only",
      });
      queryClient.setQueryData(prHubAdvisoriesQueryOptions(advisoryKeys).queryKey, result);
    } finally {
      if (keys?.length) setAnalyzingKeys(new Set<PullRequestKey>());
      else setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitPullRequestIcon className="size-5 text-muted-foreground" />
            <h1 className="font-heading text-lg font-semibold">Pull Requests</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {snapshot?.lastPolledAt
              ? `Updated ${formatRelativeTimeLabel(snapshot.lastPolledAt)}`
              : "Not refreshed yet"}
            {snapshot?.viewerLogin ? ` · ${snapshot.viewerLogin}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleGroup
            variant="outline"
            size="sm"
            value={[viewMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "inbox" || next === "focus") setViewMode(next);
            }}
          >
            <Toggle value="inbox" aria-label="Inbox view">
              <InboxIcon /> Inbox
            </Toggle>
            <Toggle value="focus" aria-label="Focus view">
              <TargetIcon /> Focus
            </Toggle>
          </ToggleGroup>
          <Button
            size="sm"
            variant="outline"
            disabled={!snapshot || isAnalyzing}
            onClick={() => {
              void analyzeKeys();
            }}
          >
            <SparklesIcon className={isAnalyzing ? "animate-pulse" : ""} />
            {isAnalyzing ? "Suggesting..." : "Suggest actions"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isRefreshing}
            onClick={() => {
              setIsRefreshing(true);
              void ensureNativeApi()
                .prHub.refresh({ mode: "force" })
                .finally(() => setIsRefreshing(false));
            }}
          >
            <RefreshCwIcon className={isRefreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </header>

      {banner || snapshot?.cappedBuckets?.length ? (
        <div className="shrink-0 space-y-0.5 border-b border-warning/30 bg-warning/8 px-5 py-2 text-xs text-warning-foreground">
          {banner ? (
            <p>
              {banner}
              {bannerDetail ? ` ${bannerDetail}` : ""}
            </p>
          ) : null}
          {snapshot?.cappedBuckets?.length ? (
            <p className="text-muted-foreground">
              GitHub capped results for: {snapshot.cappedBuckets.join(", ")}.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-2">
        {(Object.keys(FILTER_LABELS) as PrHubFilter[]).map((key) => {
          const isActive = filter === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isActive}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
              onClick={() => setFilter(key)}
            >
              {FILTER_LABELS[key]}
              {counts[key] > 0 ? (
                <span
                  className={`tabular-nums ${isActive ? "text-secondary-foreground" : "text-muted-foreground/72"}`}
                >
                  {counts[key]}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {snapshotQuery.isLoading ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitPullRequestIcon />
              </EmptyMedia>
              <EmptyTitle>Loading pull requests</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          // Tooltip provider for any base-ui tooltips rendered by the views;
          // there is no global TooltipProvider in the app.
          <TooltipProvider delay={0}>
            {viewMode === "inbox" ? (
              <PrInboxView
                prs={visiblePullRequests}
                advisoriesByKey={advisoriesByKey}
                analyzingKeys={analyzingKeys}
                onAnalyzeAdvisory={(key) => void analyzeKeys([key])}
                onThreadCreated={(threadId: ThreadId) =>
                  navigate({ to: "/$threadId", params: { threadId } })
                }
                focusedPrKey={focusedPrKey}
              />
            ) : (
              <PrFocusView
                prs={visiblePullRequests}
                advisoriesByKey={advisoriesByKey}
                analyzingKeys={analyzingKeys}
                onAnalyzeAdvisory={(key) => void analyzeKeys([key])}
                onThreadCreated={(threadId: ThreadId) =>
                  navigate({ to: "/$threadId", params: { threadId } })
                }
                focusedPrKey={focusedPrKey}
              />
            )}
          </TooltipProvider>
        )}
      </main>
    </div>
  );
}
