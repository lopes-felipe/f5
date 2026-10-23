import { ProjectId, type UsageRange } from "@t3tools/contracts";

export type UsageTab = "activity" | "limits";
export type UsageMetric = "tokens" | "cost" | "turns";

export interface UsageSearch {
  readonly tab?: UsageTab;
  readonly range?: UsageRange;
  readonly projectId?: ProjectId;
  readonly metric?: UsageMetric;
}

/** A search update; `undefined` clears a param. */
export type UsageSearchPatch = {
  readonly [Key in keyof UsageSearch]?: UsageSearch[Key] | undefined;
};

const RANGES: ReadonlySet<string> = new Set(["24h", "7d", "30d", "90d"]);
// "tokens" is the default metric and is omitted from canonical URLs.
const NON_DEFAULT_METRICS: ReadonlySet<string> = new Set(["cost", "turns"]);

/** Drops invalid values and the default metric so URLs stay canonical. */
export function validateUsageSearch(search: Record<string, unknown>): UsageSearch {
  return {
    ...(search.tab === "activity" || search.tab === "limits" ? { tab: search.tab } : {}),
    ...(typeof search.range === "string" && RANGES.has(search.range)
      ? { range: search.range as UsageRange }
      : {}),
    ...(typeof search.projectId === "string" && search.projectId.trim()
      ? { projectId: ProjectId.makeUnsafe(search.projectId.trim()) }
      : {}),
    ...(typeof search.metric === "string" && NON_DEFAULT_METRICS.has(search.metric)
      ? { metric: search.metric as UsageMetric }
      : {}),
  };
}

/**
 * Fills the tab and range that fell back to saved defaults, so the current
 * history entry keeps its effective view after the defaults change. Returns
 * null when nothing needs to be materialized.
 */
export function materializeUsageSearch(
  search: UsageSearch,
  defaults: { readonly tab: UsageTab; readonly range: UsageRange },
): UsageSearch | null {
  if (search.tab !== undefined && search.range !== undefined) return null;
  return { ...search, tab: search.tab ?? defaults.tab, range: search.range ?? defaults.range };
}

/** True when the raw URL search differs from its canonical form. */
export function needsSearchNormalization(
  raw: Record<string, unknown>,
  canonical: UsageSearch,
): boolean {
  const values = canonical as Record<string, unknown>;
  return (
    Object.keys(raw).some((key) => raw[key] !== values[key]) ||
    Object.keys(values).some((key) => raw[key] !== values[key])
  );
}
