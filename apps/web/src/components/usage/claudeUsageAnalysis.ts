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

/** Which scans recommended an action. */
export type UsageFactorPeriod = "24h" | "7d" | "both";

export interface UsageFactorAction {
  readonly title: string;
  readonly detail: string | null;
  readonly period: UsageFactorPeriod;
}

export interface UsageFactorRow {
  /** Stable row identity: the behavior key, or key + title for a named source. */
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly dayPct: number | null;
  readonly weekPct: number | null;
  /** Every distinct recommendation for this factor, 7-day ones first. */
  readonly actions: ReadonlyArray<UsageFactorAction>;
}

interface Accumulator {
  key: string;
  label: string | null;
  behaviorPct: [number | null, number | null];
  recommendations: [Array<ClaudeUsageRecommendation>, Array<ClaudeUsageRecommendation>];
}

function unique(values: ReadonlyArray<string | undefined>): Array<string> {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

/**
 * One action per distinct title. A title both scans recommend keeps the 7-day
 * details and appends differing 24-hour ones with a "(24h)" suffix.
 */
function factorActions(
  day: ReadonlyArray<ClaudeUsageRecommendation>,
  week: ReadonlyArray<ClaudeUsageRecommendation>,
): Array<UsageFactorAction> {
  const titles = unique([...week, ...day].map((recommendation) => recommendation.title));
  return titles.map((title) => {
    const weekDetails = unique(week.filter((r) => r.title === title).map((r) => r.detail));
    const dayRecs = day.filter((r) => r.title === title);
    const inWeek = week.some((r) => r.title === title);
    const period: UsageFactorPeriod = inWeek && dayRecs.length > 0 ? "both" : inWeek ? "7d" : "24h";
    const dayDetails = unique(dayRecs.map((r) => r.detail))
      .filter((detail) => !weekDetails.includes(detail))
      .map((detail) => (period === "both" ? `${detail} (24h)` : detail));
    const details = [...weekDetails, ...dayDetails];
    return { title, detail: details.length > 0 ? details.join(" · ") : null, period };
  });
}

/**
 * Joins the 24-hour and 7-day scans into one row per factor, pairing each behavior
 * share with every recommendation for the same key. Sorted by 7-day share (24-hour
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
      entry = { key, label: null, behaviorPct: [null, null], recommendations: [[], []] };
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
      row(id, recommendation.key).recommendations[index as 0 | 1].push(recommendation);
    }
  });
  const result = [...rows].map(([id, entry]): UsageFactorRow => {
    const share = (index: 0 | 1) => {
      const recommended = entry.recommendations[index];
      return (
        entry.behaviorPct[index] ??
        (recommended.length > 0 ? Math.max(...recommended.map((r) => r.pct)) : null)
      );
    };
    const actions = factorActions(entry.recommendations[0], entry.recommendations[1]);
    return {
      id,
      key: entry.key,
      label: entry.label ?? actions[0]!.title,
      dayPct: share(0),
      weekPct: share(1),
      actions,
    };
  });
  return result.sort(
    (a, b) =>
      (b.weekPct ?? b.dayPct ?? 0) - (a.weekPct ?? a.dayPct ?? 0) || a.label.localeCompare(b.label),
  );
}
