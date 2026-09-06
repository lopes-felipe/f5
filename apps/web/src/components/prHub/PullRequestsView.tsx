import { PrTrackForm } from "./PrTrackForm";
import { matchesPrHubFilter } from "@t3tools/shared/prHub";
import { useAppSettings } from "../../appSettings";
import { isPrSnoozed as isSnoozed } from "./prHubPresentation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GitPullRequestIcon,
  InboxIcon,
  RefreshCwIcon,
  SparklesIcon,
  TargetIcon,
} from "lucide-react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  PrHubListInput,
  PullRequestKey,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { formatRelativeTimeLabel, formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import {
  prHubAdvisoriesQueryOptions,
  prHubOverviewQueryOptions,
  prHubListQueryOptions,
} from "../../lib/prHubReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { onPrHubAdvisoriesUpdated } from "../../wsNativeApi";
import { Button } from "../ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { TooltipProvider } from "../ui/tooltip";
import { PrInboxView } from "./PrInboxView";
import { PrFocusView } from "./PrFocusView";
import { PR_HUB_VIEW_MODE_STORAGE_KEY, type PrHubViewMode } from "./prHubPresentation";

type PrHubFilter =
  | "needs_you"
  | "authored"
  | "reviews"
  | "all"
  | "ignored"
  | "unresolved_comments"
  | "stalled"
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
  needs_you: "Needs you",
  authored: "Authored",
  reviews: "Reviews",
  all: "All tracked",
  ignored: "Ignored",
  unresolved_comments: "Comments",
  stalled: "Stalled",
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

function isIgnored(pr: TrackedPullRequest): boolean {
  return pr.ignoredAt !== null;
}

function preferredFilterForPr(pr: TrackedPullRequest): PrHubFilter {
  if (isIgnored(pr)) return "ignored";
  if (pr.state !== "open") return "recently_resolved";
  if (isSnoozed(pr)) return "snoozed";

  const filters: readonly PrHubFilter[] = [
    "needs_my_review",
    "unresolved_comments",
    "my_prs_need_action",
    "waiting",
    "ready_to_merge",
    "ci_failing",
    "draft",
    "mentioned",
  ];
  return filters.find((candidate) => matchesPrHubFilter(pr, candidate)) ?? "mentioned";
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
  const { settings } = useAppSettings();
  const stalledHours = settings.prHubStalledAfterHours;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const stalledBefore = useMemo(
    () => (stalledHours > 0 ? new Date(now - stalledHours * 3_600_000).toISOString() : undefined),
    [stalledHours, now],
  );
  const snapshotQuery = useQuery(prHubOverviewQueryOptions(stalledBefore));
  const [filter, setFilter] = useState<PrHubFilter>("needs_you");
  useEffect(() => {
    if (stalledHours === 0) setFilter((current) => (current === "stalled" ? "waiting" : current));
  }, [stalledHours]);
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
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState("");
  const [relationship, setRelationship] = useState<PrHubListInput["relationship"]>();
  const [ci, setCi] = useState<PrHubListInput["ci"]>();
  const [lifecycle, setLifecycle] = useState<PrHubListInput["lifecycle"]>();
  const [visibility, setVisibility] = useState<PrHubListInput["visibility"]>("active");
  const [selectedKey, setSelectedKey] = useState<PullRequestKey | null>(
    focusedPrKey as PullRequestKey | null,
  );
  const selectedKeyRef = useRef<PullRequestKey | null>(focusedPrKey as PullRequestKey | null);
  const rememberSelection = useCallback((key: PullRequestKey) => {
    selectedKeyRef.current = key;
    setSelectedKey(key);
  }, []);
  const anchorKey = useMemo(
    () => selectedKeyRef.current ?? undefined,
    [snapshot?.revision, filter, search, repository, relationship, ci, lifecycle, visibility],
  );
  const listOptions = prHubListQueryOptions(
    {
      filter,
      anchorKey,
      query: search,
      relationship,
      ci,
      lifecycle,
      visibility,
      ...(repository ? { repository } : {}),
      ...(filter === "stalled" ? { stalledBefore } : {}),
    },
    snapshot?.revision,
  );
  const listQuery = useInfiniteQuery(listOptions);
  const focusedQuery = useInfiniteQuery(
    prHubListQueryOptions(
      { ...(focusedPrKey ? { key: focusedPrKey as PullRequestKey } : {}), limit: 1 },
      focusedPrKey ? snapshot?.revision : undefined,
    ),
  );
  useEffect(() => {
    if (listQuery.error?.message === "cursor_stale") {
      void queryClient.invalidateQueries({ queryKey: ["prHub", "overview"] });
      void queryClient.resetQueries({ queryKey: listOptions.queryKey, exact: true });
    }
  }, [listQuery.error, queryClient, listOptions.queryKey]);
  const visiblePullRequests = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.pullRequests) ?? [],
    [listQuery.data],
  );
  const advisoryKeys = useMemo(
    () =>
      selectedKey ? [selectedKey] : visiblePullRequests[0] ? [visiblePullRequests[0].key] : [],
    [selectedKey, visiblePullRequests],
  );
  const advisoriesQuery = useQuery({
    ...prHubAdvisoriesQueryOptions(advisoryKeys),
    enabled: advisoryKeys.length > 0,
  });
  useEffect(
    () =>
      onPrHubAdvisoriesUpdated(() => {
        void queryClient.invalidateQueries({ queryKey: ["prHub", "advisories"] });
      }),
    [queryClient],
  );
  const counts = snapshot?.counts;
  const advisoriesByKey = useMemo(
    () =>
      new Map((advisoriesQuery.data?.advisories ?? []).map((advisory) => [advisory.key, advisory])),
    [advisoriesQuery.data],
  );

  const focusedPr = focusedQuery.data?.pages[0]?.pullRequests[0] ?? null;

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
        keys: keys?.length ? [...keys] : visiblePullRequests.slice(0, 100).map((pr) => pr.key),
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

      {banner || snapshot?.coverage.length ? (
        <div className="shrink-0 space-y-1 border-b border-warning/30 bg-warning/8 px-5 py-2 text-xs text-warning-foreground">
          {banner ? (
            <p>
              {banner}
              {bannerDetail ? ` ${bannerDetail}` : ""}
            </p>
          ) : null}
          {snapshot?.coverage.map((scope) => (
            <p key={scope.scope}>{scope.description}</p>
          ))}
        </div>
      ) : null}
      {snapshot?.scheduler ? (
        <details className="shrink-0 border-b border-border px-5 py-2 text-xs">
          <summary>Monitoring budgets and retry status</summary>
          {snapshot.scheduler.retryAt ? (
            <p>
              GitHub requests resume after {formatAbsoluteTimeLabel(snapshot.scheduler.retryAt)}.
            </p>
          ) : null}
          <p>{snapshot.scheduler.activeOrQueuedRequests} active or queued requests</p>
          <table className="mt-2 w-full text-left">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Background window used</th>
                <th>GitHub quota remaining</th>
                <th>Background retry</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.scheduler.resources.map((resource) => (
                <tr key={resource.resource}>
                  <td>{resource.resource.toUpperCase()}</td>
                  <td>
                    {resource.used} / {resource.windowLimit}
                  </td>
                  <td>{resource.remaining ?? "Unknown"}</td>
                  <td>
                    {resource.resumeAt ? formatAbsoluteTimeLabel(resource.resumeAt) : "Available"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      <PrTrackForm
        onTracked={(pr) => {
          setVisibility("any");
          setFilter("all");
          setSearch("");
          setRepository("");
          setRelationship(undefined);
          setCi(undefined);
          setLifecycle(undefined);
          rememberSelection(pr.key);
          void queryClient.invalidateQueries({ queryKey: ["prHub", "overview"] });
        }}
      />
      <div className="flex shrink-0 gap-2 border-b border-border px-5 py-2">
        <input
          aria-label="Search pull requests"
          placeholder="Search title, repository, number, author"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 rounded border px-2 py-1 text-sm"
        />
        <input
          aria-label="Filter by repository"
          placeholder="owner/repository"
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          className="w-44 rounded border px-2 py-1 text-sm"
        />
      </div>

      <div className="flex flex-wrap shrink-0 gap-2 border-b border-border px-5 py-2 text-xs">
        <label>
          Relationship{" "}
          <select
            aria-label="Filter by relationship"
            value={relationship ?? ""}
            onChange={(event) =>
              setRelationship((event.target.value || undefined) as PrHubListInput["relationship"])
            }
          >
            <option value="">Any relationship</option>
            <option value="author">Author</option>
            <option value="review_requested">Review requested</option>
            <option value="team_review_requested">Team review</option>
            <option value="assignee">Assigned</option>
            <option value="mentioned">Mentioned</option>
            <option value="involved">Involved</option>
          </select>
        </label>
        <label>
          CI{" "}
          <select
            aria-label="Filter by CI"
            value={ci ?? ""}
            onChange={(event) => setCi((event.target.value || undefined) as PrHubListInput["ci"])}
          >
            <option value="">Any CI state</option>
            <option value="success">Passing</option>
            <option value="failure">Failing</option>
            <option value="error">Error</option>
            <option value="pending">Pending</option>
            <option value="none">No checks</option>
          </select>
        </label>
        <label>
          Lifecycle{" "}
          <select
            aria-label="Filter by lifecycle"
            value={lifecycle ?? ""}
            onChange={(event) => {
              setLifecycle((event.target.value || undefined) as PrHubListInput["lifecycle"]);
              if (event.target.value && event.target.value !== "open") {
                setVisibility("any");
                setFilter("all");
              }
            }}
          >
            <option value="">Any lifecycle</option>
            <option value="open">Open</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label>
          Status{" "}
          <select
            aria-label="Filter by tracking status"
            value={
              filter === "snoozed" || filter === "ignored"
                ? filter
                : filter === "recently_resolved"
                  ? "resolved"
                  : visibility
            }
            onChange={(event) => {
              setVisibility(event.target.value as PrHubListInput["visibility"]);
              if (
                ["snoozed", "ignored", "recently_resolved"].includes(filter) ||
                event.target.value === "resolved"
              )
                setFilter("all");
            }}
          >
            <option value="active">Active</option>
            <option value="snoozed">Snoozed</option>
            <option value="ignored">Ignored</option>
            <option value="resolved">Recently resolved</option>
            <option value="any">Any status</option>
          </select>
        </label>
      </div>
      <div
        aria-label="PR views"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-2"
      >
        {(["needs_you", "authored", "reviews", "waiting", "all"] as PrHubFilter[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? "default" : "outline"}
            onClick={() => setFilter(key)}
          >
            {FILTER_LABELS[key]}
          </Button>
        ))}
      </div>
      <div
        aria-label="Attention filters"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-2"
      >
        {(Object.keys(FILTER_LABELS) as PrHubFilter[])
          .filter(
            (key) =>
              ![
                "needs_you",
                "authored",
                "reviews",
                "waiting",
                "all",
                "snoozed",
                "ignored",
                "recently_resolved",
              ].includes(key),
          )
          .filter((key) => key !== "stalled" || stalledHours > 0)
          .map((key) => {
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
                {(counts?.[key] ?? 0) > 0 ? (
                  <span
                    className={`tabular-nums ${isActive ? "text-secondary-foreground" : "text-muted-foreground/72"}`}
                  >
                    {counts?.[key]}
                  </span>
                ) : null}
              </button>
            );
          })}
      </div>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {snapshotQuery.isLoading || listQuery.isLoading ? (
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
                onSelectionChange={rememberSelection}
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
                onSelectionChange={rememberSelection}
                focusedPrKey={focusedPrKey}
              />
            )}
          </TooltipProvider>
        )}
        {snapshotQuery.isError || listQuery.isError ? (
          <p role="alert" className="px-5 py-3 text-sm text-destructive">
            Could not load pull requests. Refresh to retry.
          </p>
        ) : null}
        {listQuery.hasNextPage ? (
          <Button
            variant="outline"
            disabled={listQuery.isFetchingNextPage || listQuery.isPlaceholderData}
            onClick={() => void listQuery.fetchNextPage()}
          >
            {listQuery.isFetchingNextPage ? "Loading..." : "Load more pull requests"}
          </Button>
        ) : null}
      </main>
    </div>
  );
}
