import { createHash } from "node:crypto";
import {
  PrHubListFilter,
  type PrHubListInput,
  type PrHubListPage,
  type PrHubOverview,
  type PrHubSnapshot,
  type PrHubChanged,
} from "@t3tools/contracts";
import { matchesPrHubFilter, comparePrPriority } from "@t3tools/shared/prHub";

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

export function prHubOverview(
  snapshot: PrHubSnapshot,
  revision: string,
  stalledBefore?: string,
  now = Date.now(),
): PrHubOverview {
  const { pullRequests, recentlyResolved, cappedBuckets, ...metadata } = snapshot;
  const counts = Object.fromEntries(
    PrHubListFilter.literals.map((filter) => [filter, 0]),
  ) as Record<PrHubListFilter, number>;
  for (const pr of [...pullRequests, ...recentlyResolved]) {
    for (const filter of PrHubListFilter.literals) {
      if (matchesPrHubFilter(pr, filter, stalledBefore, now)) counts[filter]++;
    }
  }
  return {
    ...metadata,
    revision,
    counts,
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
  const query = input.query?.trim().toLowerCase();
  const rows = [...snapshot.pullRequests, ...snapshot.recentlyResolved].filter((pr) => {
    if (input.key) return pr.key === input.key;
    return (
      matchesPrHubFilter(
        pr,
        input.filter ?? "all",
        input.stalledBefore,
        Date.now(),
        input.visibility,
      ) &&
      (!input.repository || pr.repository.nameWithOwner === input.repository) &&
      (!input.relationship || pr.roles.includes(input.relationship)) &&
      (!input.ci || pr.checkRollup === input.ci) &&
      (!input.lifecycle || pr.state === input.lifecycle) &&
      (!query ||
        `${pr.title} ${pr.repository.nameWithOwner} #${pr.number} ${pr.author ?? ""}`
          .toLowerCase()
          .includes(query))
    );
  });
  rows.sort(
    (a, b) =>
      (input.sort === "updated"
        ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        : comparePrPriority(a, b)) || a.key.localeCompare(b.key),
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
    pullRequests: rows.slice(offset, next),
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
