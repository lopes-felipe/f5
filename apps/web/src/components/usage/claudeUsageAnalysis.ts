import type { ClaudeUsageAnalysisWindow, ClaudeUsageRecommendation } from "@t3tools/contracts";

const BEHAVIOR_LABELS: Record<string, string> = {
  cache_miss: "Cache misses",
  long_context: "Long context",
  subagent_heavy: "Sub-agent heavy",
  high_parallel: "High parallelism",
  cron: "Scheduled runs",
  max_effort: "Max effort",
  workflow: "Workflows",
  always_on_context: "Always-on context",
  large_tool_results: "Large tool results",
};

export function claudeUsageBehaviorLabel(key: string): string {
  return BEHAVIOR_LABELS[key] ?? key.replaceAll("_", " ");
}

/** Recommendation keys that name a specific source; each title is its own factor. */
const NAMED_SOURCE_KEYS = new Set(["agent", "skill", "plugin", "mcp_server"]);

export interface UsageFactorRow {
  /** Stable row identity: the behavior key, or key + title for a named source. */
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly dayPct: number | null;
  readonly weekPct: number | null;
  readonly action: { readonly title: string; readonly detail: string | null } | null;
}

interface Accumulator {
  key: string;
  label: string | null;
  behaviorPct: [number | null, number | null];
  recommendation: [ClaudeUsageRecommendation | null, ClaudeUsageRecommendation | null];
}

/**
 * Joins the 24-hour and 7-day scans into one row per factor, pairing each behavior
 * share with the recommendation for the same key. Sorted by 7-day share (24-hour
 * when the factor is absent from the week), largest first.
 */
export function mergeUsageAnalysis(
  day: ClaudeUsageAnalysisWindow | null,
  week: ClaudeUsageAnalysisWindow | null,
): Array<UsageFactorRow> {
  const rows = new Map<string, Accumulator>();
  const row = (id: string, key: string) => {
    let entry = rows.get(id);
    if (!entry) {
      entry = { key, label: null, behaviorPct: [null, null], recommendation: [null, null] };
      rows.set(id, entry);
    }
    return entry;
  };
  ([day, week] as const).forEach((window, index) => {
    if (!window) return;
    for (const behavior of window.behaviors) {
      const entry = row(behavior.key, behavior.key);
      entry.label = claudeUsageBehaviorLabel(behavior.key);
      entry.behaviorPct[index] = behavior.pct;
    }
    for (const recommendation of window.recommendations) {
      const id = NAMED_SOURCE_KEYS.has(recommendation.key)
        ? `${recommendation.key}\u0000${recommendation.title}`
        : recommendation.key;
      row(id, recommendation.key).recommendation[index] ??= recommendation;
    }
  });
  const result = [...rows].map(([id, entry]): UsageFactorRow => {
    const [dayRec, weekRec] = entry.recommendation;
    const share = (index: 0 | 1) =>
      entry.behaviorPct[index] ?? entry.recommendation[index]?.pct ?? null;
    const lead = weekRec ?? dayRec;
    let action: UsageFactorRow["action"] = null;
    if (lead) {
      const weekDetail = weekRec?.detail ?? null;
      const dayDetail = dayRec?.detail ?? null;
      const details = [
        weekDetail,
        dayDetail && dayDetail !== weekDetail ? `${dayDetail} (24h)` : null,
      ].filter((detail): detail is string => detail !== null);
      action = { title: lead.title, detail: details.length > 0 ? details.join(" · ") : null };
    }
    return {
      id,
      key: entry.key,
      label: entry.label ?? lead!.title,
      dayPct: share(0),
      weekPct: share(1),
      action,
    };
  });
  return result.sort(
    (a, b) =>
      (b.weekPct ?? b.dayPct ?? 0) - (a.weekPct ?? a.dayPct ?? 0) || a.label.localeCompare(b.label),
  );
}
