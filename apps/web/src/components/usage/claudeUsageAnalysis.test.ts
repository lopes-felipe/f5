import type { ClaudeUsageAnalysisWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mergeUsageAnalysis } from "./claudeUsageAnalysis";

// The 24h and 7d scans from the usage screenshot.
const day: ClaudeUsageAnalysisWindow = {
  requestCount: 1_742,
  sessionCount: 50,
  behaviors: [
    { key: "long_context", pct: 69, count: 1 },
    { key: "high_parallel", pct: 39, count: 1 },
    { key: "always_on_context", pct: 22, count: 1 },
  ],
  recommendations: [
    {
      key: "long_context",
      pct: 69,
      title: "Start fresh when you switch tasks",
      detail: "run /clear",
    },
    {
      key: "high_parallel",
      pct: 39,
      title: "Run fewer sessions at once",
      detail: "up to 12 at once",
    },
    {
      key: "always_on_context",
      pct: 22,
      title: "Trim ~/dev/wolt/CLAUDE.md",
      detail: "12k tokens per request",
    },
  ],
};
const week: ClaudeUsageAnalysisWindow = {
  requestCount: 17_471,
  sessionCount: 395,
  behaviors: [
    { key: "long_context", pct: 69, count: 1 },
    { key: "high_parallel", pct: 54, count: 1 },
    { key: "cron", pct: 43, count: 1 },
    { key: "always_on_context", pct: 12, count: 1 },
  ],
  recommendations: [
    {
      key: "long_context",
      pct: 69,
      title: "Start fresh when you switch tasks",
      detail: "run /clear",
    },
    {
      key: "high_parallel",
      pct: 54,
      title: "Run fewer sessions at once",
      detail: "up to 14 at once",
    },
    {
      key: "cron",
      pct: 43,
      title: "Stop sessions you no longer need",
      detail: "some ran 8 hours or more",
    },
    {
      key: "always_on_context",
      pct: 12,
      title: "Trim ~/dev/wolt/CLAUDE.md",
      detail: "12k tokens per request",
    },
  ],
};

describe("mergeUsageAnalysis", () => {
  it("joins both windows into one row per factor, ordered by 7-day share", () => {
    const rows = mergeUsageAnalysis(day, week);
    expect(rows.map((row) => [row.label, row.dayPct, row.weekPct])).toEqual([
      ["Long context", 69, 69],
      ["High parallelism", 39, 54],
      ["Scheduled runs", null, 43],
      ["Always-on context", 22, 12],
    ]);
    expect(rows[0]!.action).toEqual({
      title: "Start fresh when you switch tasks",
      detail: "run /clear",
    });
  });

  it("appends a differing 24-hour detail after the 7-day one", () => {
    const parallel = mergeUsageAnalysis(day, week).find((row) => row.key === "high_parallel")!;
    expect(parallel.action).toEqual({
      title: "Run fewer sessions at once",
      detail: "up to 14 at once · up to 12 at once (24h)",
    });
  });

  it("gives each named source its own row, labelled by title", () => {
    const rows = mergeUsageAnalysis(null, {
      requestCount: 10,
      sessionCount: 1,
      behaviors: [],
      recommendations: [
        { key: "agent", pct: 30, title: "Review the reviewer agent" },
        { key: "agent", pct: 20, title: "Review the planner agent", detail: "long prompts" },
      ],
    });
    expect(rows.map((row) => [row.id, row.label, row.weekPct, row.action?.detail])).toEqual([
      ["agent\u0000Review the reviewer agent", "Review the reviewer agent", 30, null],
      ["agent\u0000Review the planner agent", "Review the planner agent", 20, "long prompts"],
    ]);
  });

  it("handles a missing 24-hour window and factors without a recommendation", () => {
    const rows = mergeUsageAnalysis(null, {
      ...week,
      behaviors: [...week.behaviors, { key: "cache_miss", pct: 5, count: 2 }],
    });
    expect(rows.every((row) => row.dayPct === null)).toBe(true);
    expect(rows.at(-1)).toMatchObject({ label: "Cache misses", weekPct: 5, action: null });
  });

  it("sorts by the 24-hour share when the 7-day window is missing", () => {
    expect(mergeUsageAnalysis(day, null).map((row) => row.key)).toEqual([
      "long_context",
      "high_parallel",
      "always_on_context",
    ]);
  });
});
