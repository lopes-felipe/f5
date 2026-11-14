import { createHash } from "node:crypto";
import { prSearchPredicate } from "./prSearch.ts";
import {
  PrHubListFilter,
  type PrHubListInput,
  type PrHubListPage,
  type PrHubOverview,
  type PrHubSavedQuery,
  type PrHubSection,
  type PrHubSnapshot,
  type PrHubChanged,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import {
  matchesPrHubFilter,
  comparePrPriority,
  PR_HUB_SECTIONS,
  prHubSectionOf,
} from "@t3tools/shared/prHub";

export function excludePrHubRepositories(
  snapshot: PrHubSnapshot,
  excluded: ReadonlySet<string>,
): PrHubSnapshot {
  if (excluded.size === 0) return snapshot;
  return {
    ...snapshot,
    pullRequests: snapshot.pullRequests.filter(
      (pr) => !excluded.has(pr.repository.nameWithOwner.toLowerCase()),
    ),
    recentlyResolved: snapshot.recentlyResolved.filter(
      (pr) => !excluded.has(pr.repository.nameWithOwner.toLowerCase()),
    ),
  };
}

export function defaultPrHubCoverage(
  lastPolledAt: string | null,
  cappedBuckets?: readonly string[],
): PrHubOverview["coverage"] {
  return [
    {
      scope: "known_repositories",
      status: "not_scanned",
      description: "Repository affiliation traversal has not completed.",
    },
    {
      scope: "global_relationship_search",
      limits: cappedBuckets ?? [],
      status: lastPolledAt ? "partial" : "not_scanned",
      description: cappedBuckets?.length
        ? `Search limits reached: ${cappedBuckets.join(", ")}.`
        : "Search-based coverage; GitHub search cannot prove coverage of every accessible repository.",
    },
    {
      scope: "previously_tracked",
      status: lastPolledAt ? "partial" : "not_scanned",
      description:
        "Previously tracked PRs retain their last verified state until directly refreshed.",
    },
  ];
}

/** Enough for a filter's suggestions; anything rarer is still reachable by typing it. */
const FACET_LIMIT = 200;
const tally = (counts: Map<string, number>, value: string) =>
  counts.set(value, (counts.get(value) ?? 0) + 1);
const mostCommon = (counts: ReadonlyMap<string, number>) =>
  [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, FACET_LIMIT)
    .map(([value]) => value);

type QueueFilters = Pick<PrHubListInput, "query" | "repository" | "ci" | "review" | "draft">;

/** The search and filters of the queue, shared by lists and saved-view counts. */
function queueFilterPredicate(filters: QueueFilters, viewerLogin: string | null) {
  const matchesSearch = prSearchPredicate(filters.query ?? "", viewerLogin);
  return (pr: TrackedPullRequest) =>
    (!filters.repository || pr.repository.nameWithOwner === filters.repository) &&
    (!filters.ci || pr.checkRollup === filters.ci) &&
    (!filters.draft || pr.isDraft === (filters.draft === "only")) &&
    (!filters.review || pr.reviewDecision === filters.review) &&
    matchesSearch(pr);
}

const isUnread = (pr: TrackedPullRequest) => (pr.changesSinceSeen?.length ?? 0) > 0;
const NEEDS_VIEWER: ReadonlySet<PrHubSection> = new Set(["review", "action", "ready"]);

export function prHubOverview(
  snapshot: PrHubSnapshot,
  revision: string,
  stalledBefore?: string,
  now = Date.now(),
  savedQueries: readonly PrHubSavedQuery[] = [],
): PrHubOverview {
  const { pullRequests, recentlyResolved, cappedBuckets, ...metadata } = snapshot;
  const saved = savedQueries.map((query) => ({
    id: query.id,
    matches: queueFilterPredicate(query, snapshot.viewerLogin),
  }));
  const savedCounts: Record<string, number> = Object.fromEntries(
    saved.map((query) => [query.id, 0]),
  );
  let unreadCount = 0;
  const counts = Object.fromEntries(
    PrHubListFilter.literals.map((filter) => [filter, 0]),
  ) as Record<PrHubListFilter, number>;
  const sectionCounts = Object.fromEntries(
    PR_HUB_SECTIONS.map((section) => [section, 0]),
  ) as Record<PrHubSection, number>;
  const repositories = new Map<string, number>();
  const authors = new Map<string, number>();
  const labels = new Map<string, number>();
  for (const pr of [...pullRequests, ...recentlyResolved]) {
    for (const filter of PrHubListFilter.literals) {
      if (matchesPrHubFilter(pr, filter, stalledBefore, now)) counts[filter]++;
    }
    // Sections describe the active queue: snoozed, ignored and closed rows are elsewhere.
    if (matchesPrHubFilter(pr, "all", undefined, now, "active")) {
      const section = prHubSectionOf(pr, now);
      sectionCounts[section]++;
      if (isUnread(pr)) unreadCount++;
      if (NEEDS_VIEWER.has(section))
        for (const query of saved) if (query.matches(pr)) savedCounts[query.id]!++;
      tally(repositories, pr.repository.nameWithOwner);
      if (pr.author) tally(authors, pr.author);
      for (const label of pr.labels) tally(labels, label);
    }
  }
  return {
    ...metadata,
    revision,
    counts,
    sectionCounts,
    unreadCount,
    ...(saved.length > 0 ? { savedCounts } : {}),
    facets: {
      repositories: mostCommon(repositories),
      authors: mostCommon(authors),
      labels: mostCommon(labels),
    },
    coverage: snapshot.coverage?.length
      ? snapshot.coverage
      : defaultPrHubCoverage(snapshot.lastPolledAt, cappedBuckets),
  };
}

export function listPrHubPullRequests(
  snapshot: PrHubSnapshot,
  revision: string,
  input: PrHubListInput,
): PrHubListPage {
  const { cursor, limit = 50, accountGeneration, ...filters } = input;
  const signature = createHash("sha256")
    .update(JSON.stringify({ ...filters, account: snapshot.account?.generation, limit }))
    .digest("hex");
  const empty = {
    accountGeneration: snapshot.account?.generation,
    revision,
    status: "cursor_stale" as const,
    pullRequests: [],
    nextCursor: null,
  };
  if (accountGeneration !== undefined && accountGeneration !== snapshot.account?.generation)
    return empty;
  let offset = 0;
  if (cursor) {
    // Cursors are navigation hints, not capabilities: all reads are independently
    // scoped to the verified account and validated filter/revision below.
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        parsed.revision !== revision ||
        parsed.signature !== signature ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      )
        return empty;
      offset = parsed.offset;
    } catch {
      return empty;
    }
  }
  const matchesFilters = queueFilterPredicate(input, snapshot.viewerLogin);
  const now = Date.now();
  // A section is a slice of the active queue unless the caller asks for another status.
  const visibility = input.visibility ?? (input.section ? "active" : undefined);
  const rows = [...snapshot.pullRequests, ...snapshot.recentlyResolved].filter((pr) => {
    if (input.key) return pr.key === input.key;
    return (
      matchesPrHubFilter(pr, input.filter ?? "all", input.stalledBefore, now, visibility) &&
      (!input.section || prHubSectionOf(pr, now) === input.section) &&
      (!input.unread || isUnread(pr)) &&
      (!input.relationship || pr.roles.includes(input.relationship)) &&
      (!input.lifecycle || pr.state === input.lifecycle) &&
      matchesFilters(pr)
    );
  });
  rows.sort(
    (a, b) =>
      (input.sort === "updated"
        ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        : comparePrPriority(a, b, now)) || a.key.localeCompare(b.key),
  );
  if (!cursor && input.anchorKey) {
    const anchor = rows.findIndex((pr) => pr.key === input.anchorKey);
    if (anchor >= 0) offset = Math.max(0, anchor - 10);
  }
  const pageSize = Math.max(1, Math.min(100, limit));
  const next = offset + pageSize;
  return {
    accountGeneration: snapshot.account?.generation,
    revision,
    status: "ok",
    pullRequests: rows
      .slice(offset, next)
      .map((pr) => (pr.section ? pr : { ...pr, section: prHubSectionOf(pr, now) })),
    nextCursor:
      next < rows.length
        ? Buffer.from(JSON.stringify({ revision, signature, offset: next })).toString("base64url")
        : null,
  };
}

export function prHubInvalidation(
  previous: PrHubSnapshot | null,
  snapshot: PrHubSnapshot,
  revision: string,
): PrHubChanged {
  const old = new Map(
    [...(previous?.pullRequests ?? []), ...(previous?.recentlyResolved ?? [])].map((pr) => [
      pr.key,
      pr,
    ]),
  );
  const changedKeys: PrHubChanged["changedKeys"][number][] = [];
  for (const pr of [...snapshot.pullRequests, ...snapshot.recentlyResolved]) {
    if (JSON.stringify(old.get(pr.key)) !== JSON.stringify(pr)) changedKeys.push(pr.key);
    old.delete(pr.key);
  }
  const event: PrHubChanged = {
    accountGeneration: snapshot.account?.generation,
    revision,
    changedKeys,
    removedKeys: [...old.keys()],
    counts: prHubOverview(snapshot, revision).counts,
    resyncRequired: previous?.account?.generation !== snapshot.account?.generation,
  };
  if (changedKeys.length + old.size > 500 || Buffer.byteLength(JSON.stringify(event)) > 60 * 1024)
    return { ...event, changedKeys: [], removedKeys: [], resyncRequired: true };
  return event;
}
