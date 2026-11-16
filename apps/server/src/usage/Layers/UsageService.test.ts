import { assert, describe, it } from "vitest";

import type {
  BucketUsageSummaryRow,
  ScopeUsageSummaryRow,
  UsageAggregateRow,
} from "../../persistence/Services/UsageFacts.ts";
import { planUsageBuckets } from "../usageBuckets.ts";
import {
  aggregateUsageMetrics,
  aggregateUsageScope,
  applyModelAliases,
  buildUsageProjectScope,
  buildUsageSummary,
  previousUsageWindow,
  resolveModelAliases,
} from "../usageSummary.ts";
import { resolveUsageRangeWindow } from "./UsageService.ts";

function aggregate(input: Partial<UsageAggregateRow> = {}): UsageAggregateRow {
  const turnCount = input.turnCount ?? 1;
  return {
    provider: "codex",
    model: null,
    turnCount,
    reportedTokenTurnCount: turnCount,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    totalTokens: 120,
    providerReportedCostUsd: null,
    pricedTurnCount: 0,
    unpricedTurnCount: turnCount,
    recordedTurnCount: turnCount,
    legacyCostEventCount: 0,
    inputTokenTurnCount: turnCount,
    outputTokenTurnCount: turnCount,
    cacheReadTokenTurnCount: turnCount,
    cacheWriteTokenTurnCount: 0,
    totalTokenTurnCount: turnCount,
    ...input,
  };
}

function row(
  input: Partial<BucketUsageSummaryRow> & Pick<BucketUsageSummaryRow, "bucketKey">,
): BucketUsageSummaryRow {
  return { ...aggregate(input), bucketKey: input.bucketKey };
}

function legacy(bucketKey: string, cost: number): BucketUsageSummaryRow {
  return row({
    bucketKey,
    provider: "claudeAgent",
    reportedTokenTurnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    providerReportedCostUsd: cost,
    pricedTurnCount: 1,
    unpricedTurnCount: 0,
    recordedTurnCount: 0,
    legacyCostEventCount: 1,
    inputTokenTurnCount: 0,
    outputTokenTurnCount: 0,
    cacheReadTokenTurnCount: 0,
    totalTokenTurnCount: 0,
  });
}

const week = (now: string) =>
  planUsageBuckets({ range: "7d", timeZone: "UTC", now: new Date(now) });

describe("usage summary", () => {
  it("uses local calendar boundaries across daylight-saving changes", () => {
    const window = resolveUsageRangeWindow({
      range: "7d",
      timeZone: "Europe/Berlin",
      now: new Date("2026-03-31T12:00:00.000Z"),
    });

    assert.equal(window.startedAt, "2026-03-24T23:00:00.000Z");
    assert.equal(window.endedAt, "2026-03-31T12:00:00.001Z");
  });

  it("resolves zones whose daylight-saving transition skips local midnight", () => {
    const window = resolveUsageRangeWindow({
      range: "7d",
      timeZone: "America/Havana",
      now: new Date("2026-03-14T12:00:00.000Z"),
    });
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Havana",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    const parts = new Map(
      local
        .formatToParts(new Date(window.startedAt))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value] as const),
    );
    assert.deepStrictEqual(
      {
        year: parts.get("year"),
        month: parts.get("month"),
        day: parts.get("day"),
        hour: parts.get("hour"),
      },
      { year: "2026", month: "03", day: "08", hour: "01" },
    );
  });

  it("returns fixed buckets, provider breakdowns, and incomplete coverage diagnostics", () => {
    const summary = buildUsageSummary({
      request: { range: "7d", timeZone: "UTC" },
      now: new Date("2026-08-15T12:00:00.000Z"),
      coverageStartedAt: "2026-08-12T00:00:00.000Z",
      plan: week("2026-08-15T12:00:00.000Z"),
      rows: [
        row({ bucketKey: "2026-08-14" }),
        { ...legacy("2026-08-14", 0.4), model: "claude-opus" },
      ],
    });

    assert.equal(summary.buckets.length, 7);
    assert.equal(summary.buckets[6]!.endAt, "2026-08-15T12:00:00.001Z");
    assert.equal(summary.nextBucketAt, "2026-08-16T00:00:00.000Z");
    assert.equal(summary.metrics.turnCount, 2);
    assert.equal(summary.metrics.reporting?.recordedTurnCount, 1);
    assert.equal(summary.metrics.reporting?.legacyCostEventCount, 1);
    assert.equal(summary.metrics.totalTokens, 120);
    assert.equal(summary.metrics.providerReportedCostUsd, 0.4);
    assert.equal(summary.coverage.partialHistory, true);
    assert.equal(summary.coverage.historicalCostTurnCount, 1);
    assert.deepStrictEqual(summary.coverage.providersMissingTokens, ["claudeAgent"]);
    assert.deepStrictEqual(summary.coverage.providersMissingCost, ["codex"]);
    assert.equal(summary.byProvider.length, 2);
    assert.equal(summary.projectScope, null);
    assert.equal(summary.previousMetrics, null);
  });

  it("keeps summary totals equal to the visible bucket totals", () => {
    const plan = planUsageBuckets({
      range: "24h",
      timeZone: "UTC",
      now: new Date("2026-08-15T12:30:00.000Z"),
    });
    const summary = buildUsageSummary({
      request: { range: "24h", timeZone: "UTC" },
      now: new Date("2026-08-15T12:30:00.000Z"),
      coverageStartedAt: "2026-08-01T00:00:00.000Z",
      plan,
      rows: [
        row({ bucketKey: "2026-08-15T12:00:00.000Z" }),
        row({ bucketKey: "2026-08-01T12:00:00.000Z" }),
      ],
    });
    const bucketTurnCount = summary.buckets.reduce(
      (total, bucket) => total + bucket.metrics.turnCount,
      0,
    );
    assert.equal(summary.metrics.turnCount, bucketTurnCount);
    assert.equal(summary.metrics.turnCount, 1);
  });

  it("counts reported fields separately from reported zero and missing values", () => {
    const metrics = aggregateUsageMetrics([
      // Cache-only report.
      aggregate({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 40,
        totalTokens: 0,
        inputTokenTurnCount: 0,
        outputTokenTurnCount: 0,
        totalTokenTurnCount: 0,
      }),
      // Input-only report.
      aggregate({
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        outputTokenTurnCount: 0,
        cacheReadTokenTurnCount: 0,
        totalTokenTurnCount: 0,
      }),
      // Total-only report.
      aggregate({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 50,
        inputTokenTurnCount: 0,
        outputTokenTurnCount: 0,
        cacheReadTokenTurnCount: 0,
      }),
      // Reported zeros.
      aggregate({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }),
    ]);
    assert.deepStrictEqual(metrics.reporting, {
      recordedTurnCount: 4,
      legacyCostEventCount: 0,
      inputTokenTurnCount: 2,
      outputTokenTurnCount: 1,
      cacheReadTokenTurnCount: 2,
      cacheWriteTokenTurnCount: 0,
      totalTokenTurnCount: 2,
    });
    assert.equal(metrics.totalTokens, 50);
    assert.equal(metrics.cacheReadTokens, 40);
  });

  it("excludes unknown-total partitions from chart composition", () => {
    const summary = buildUsageSummary({
      request: { range: "7d", timeZone: "UTC" },
      now: new Date("2026-08-15T12:00:00Z"),
      coverageStartedAt: "2026-08-01T00:00:00Z",
      plan: week("2026-08-15T12:00:00Z"),
      rows: [
        row({ bucketKey: "2026-08-14", totalTokens: 0, totalTokenTurnCount: 0 }),
        row({ bucketKey: "2026-08-14", inputTokens: 0, cacheReadTokens: 0, totalTokens: 50 }),
      ],
    });
    const bucket = summary.buckets.find((entry) => entry.key === "2026-08-14")!;
    assert.deepStrictEqual(bucket.composition, {
      uncachedInputTokens: 0,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unattributedTokens: 30,
    });
    assert.equal(bucket.metrics.reporting?.totalTokenTurnCount, 1);
    assert.equal(bucket.metrics.reporting?.recordedTurnCount, 2);
  });
});

it("computes disjoint provider-aware composition before aggregating mixed buckets", () => {
  const summary = buildUsageSummary({
    request: { range: "7d", timeZone: "UTC" },
    now: new Date("2026-08-15T12:00:00Z"),
    coverageStartedAt: "2026-08-12T00:00:00Z",
    plan: week("2026-08-15T12:00:00Z"),
    rows: [
      row({
        bucketKey: "2026-08-14",
        provider: "codex",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        totalTokens: 120,
      }),
      row({
        bucketKey: "2026-08-14",
        provider: "claudeAgent",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        totalTokens: 160,
      }),
      row({
        bucketKey: "2026-08-14",
        provider: "cursor",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 50,
      }),
    ],
  });
  const bucket = summary.buckets.find((b) => b.key === "2026-08-14")!;
  assert.deepStrictEqual(bucket.composition, {
    uncachedInputTokens: 170,
    outputTokens: 40,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    unattributedTokens: 50,
  });
  assert.equal(
    Object.values(bucket.composition!).reduce((a, b) => a + b, 0),
    bucket.metrics.totalTokens,
  );
});

it("prices only unreported costs, honors zero, and inherits blank cache rates", () => {
  const plan = planUsageBuckets({
    range: "24h",
    timeZone: "UTC",
    now: new Date("2026-10-02T12:00:00Z"),
  });
  const summary = buildUsageSummary({
    request: { range: "24h", timeZone: "UTC" },
    now: new Date("2026-10-02T12:00:00Z"),
    coverageStartedAt: "2026-10-01T00:00:00Z",
    plan,
    priceOverrides: [
      {
        provider: "codex",
        model: "priced",
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 0,
        cacheReadUsdPerMillion: null,
        cacheWriteUsdPerMillion: null,
      },
    ],
    rows: [
      row({
        bucketKey: "2026-10-02T12:00:00.000Z",
        provider: "codex",
        model: "priced",
        inputTokens: 1_000_000,
        cacheReadTokens: 500_000,
      }),
      row({
        bucketKey: "2026-10-02T12:00:00.000Z",
        provider: "codex",
        model: "priced",
        providerReportedCostUsd: 0,
        pricedTurnCount: 1,
        unpricedTurnCount: 0,
      }),
      row({ bucketKey: "2026-10-02T12:00:00.000Z", provider: "grok" }),
    ],
  });
  assert.equal(summary.metrics.estimatedCostUsd, 2);
  assert.equal(summary.metrics.providerReportedCostUsd, 0);
  assert.equal(summary.metrics.pricedTurnCount, 2);
  assert.equal(summary.metrics.unpricedTurnCount, 1);
});

describe("model aliases", () => {
  it("follows chains to the final target and leaves loops and self-maps unmapped", () => {
    assert.deepEqual(
      [...resolveModelAliases({ a: "b", b: "c", loop1: "loop2", loop2: "loop1", self: "self" })],
      [
        ["a", "c"],
        ["b", "c"],
      ],
    );
  });

  it("reports and prices a mapped model as its target", () => {
    const plan = planUsageBuckets({
      range: "24h",
      timeZone: "UTC",
      now: new Date("2026-10-02T12:00:00Z"),
    });
    const bucketKey = "2026-10-02T12:00:00.000Z";
    const summary = buildUsageSummary({
      request: { range: "24h", timeZone: "UTC" },
      now: new Date("2026-10-02T12:00:00Z"),
      coverageStartedAt: "2026-10-01T00:00:00Z",
      plan,
      priceOverrides: [
        {
          provider: "codex",
          model: "gpt-5.6",
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 0,
          cacheReadUsdPerMillion: 0,
          cacheWriteUsdPerMillion: null,
        },
      ],
      rows: applyModelAliases(
        [
          row({ bucketKey, model: "gpt-5.6", inputTokens: 1_000_000, cacheReadTokens: 0 }),
          row({ bucketKey, model: "gpt-5.6-preview", inputTokens: 2_000_000, cacheReadTokens: 0 }),
          row({ bucketKey, model: null }),
        ],
        resolveModelAliases({ "gpt-5.6-preview": "gpt-5.6" }),
      ),
    });
    assert.deepEqual(
      summary.byProvider.map((entry) => [entry.model, entry.metrics.turnCount]),
      [
        ["gpt-5.6", 2],
        [null, 1],
      ],
    );
    assert.equal(summary.metrics.estimatedCostUsd, 3);
  });
});

describe("project and thread scope", () => {
  function scopeRow(
    threadId: string | null,
    projectId: string | null,
    input: Partial<UsageAggregateRow> = {},
  ): ScopeUsageSummaryRow {
    return { ...aggregate(input), threadId, projectId };
  }

  it("reconciles project totals, prices breakdowns, and caps threads with a full count", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, index) =>
        scopeRow(`thread-${index.toString().padStart(2, "0")}`, "project-a", {
          totalTokens: 100 + index,
          model: "priced",
        }),
      ),
      scopeRow("thread-b", "project-b", { totalTokens: 5_000 }),
      scopeRow(null, null, {
        ...legacy("x", 0.5),
      }),
    ];
    const overrides = [
      {
        provider: "codex" as const,
        model: "priced",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 0,
        cacheReadUsdPerMillion: 0,
        cacheWriteUsdPerMillion: null,
      },
    ];
    const all = aggregateUsageScope({ rows, projectId: null, priceOverrides: overrides });
    assert.deepStrictEqual(
      all.projects.map((project) => project.id),
      ["project-b", "project-a", null],
    );
    assert.equal(all.threadCount, 13);
    assert.isAtLeast(all.threads.length, 10);
    assert.isAtMost(all.threads.length, 30);
    assert.equal(all.threads[0]!.id, "thread-b");
    const total = aggregateUsageMetrics(rows, overrides);
    assert.equal(
      all.projects.reduce((sum, project) => sum + project.metrics.totalTokens, 0),
      total.totalTokens,
    );
    assert.equal(
      all.projects.reduce((sum, project) => sum + project.metrics.turnCount, 0),
      total.turnCount,
    );
    assert.isAbove(all.projects[1]!.metrics.estimatedCostUsd ?? 0, 0);

    const filtered = aggregateUsageScope({ rows, projectId: "project-a" });
    assert.equal(filtered.projects.length, 3);
    assert.equal(filtered.threadCount, 12);
    assert.isTrue(filtered.threads.every((thread) => thread.projectId === "project-a"));
    assert.equal(filtered.threads[0]!.id, "thread-11");

    const scope = buildUsageProjectScope({
      aggregation: filtered,
      selectedProjectId: "project-a",
      titles: {
        projects: [
          { id: "project-a", title: "Alpha", deleted: false },
          { id: "project-b", title: null, deleted: true },
        ],
        threads: [{ id: "thread-11", title: "Fix bug", deleted: false, projectId: "project-a" }],
      },
    });
    assert.equal(scope.selectedProjectId, "project-a");
    assert.deepStrictEqual(
      scope.byProject.map((project) => [project.projectId, project.title, project.deleted]),
      [
        ["project-b", null, true],
        ["project-a", "Alpha", false],
        [null, null, false],
      ],
    );
    assert.equal(scope.topThreads[0]!.title, "Fix bug");
    assert.equal(scope.topThreads[1]!.deleted, true);
  });

  it("keeps the top threads by cost and by turns, not only by tokens", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, index) =>
        scopeRow(`tokens-${index.toString().padStart(2, "0")}`, "project-a", {
          totalTokens: 1_000 + index,
          providerReportedCostUsd: 0,
        }),
      ),
      scopeRow("costly", "project-a", {
        totalTokens: 1,
        providerReportedCostUsd: 9,
        pricedTurnCount: 1,
        unpricedTurnCount: 0,
      }),
      scopeRow("busy", "project-a", { totalTokens: 2, providerReportedCostUsd: 0, turnCount: 50 }),
    ];
    const scope = aggregateUsageScope({ rows, projectId: null });
    const ids = scope.threads.map((thread) => thread.id);
    assert.equal(scope.threadCount, 14);
    assert.include(ids, "costly");
    assert.include(ids, "busy");
    assert.include(ids, "tokens-11");
    assert.deepStrictEqual(ids.slice(0, 2), ["tokens-11", "tokens-10"]);
    assert.isAtMost(ids.length, 30);
  });
});

describe("previous window", () => {
  it("spans an equal duration ending at the current start, across DST", () => {
    const plan = planUsageBuckets({
      range: "7d",
      timeZone: "Europe/Berlin",
      now: new Date("2026-03-31T12:00:00.000Z"),
    });
    const previous = previousUsageWindow({
      plan,
      coverageStartedAt: "2026-01-01T00:00:00.000Z",
      factCutoverAt: "2026-01-01T00:00:00.000Z",
    })!;
    assert.equal(previous.endedAt, plan.startedAt);
    assert.equal(
      Date.parse(previous.endedAt) - Date.parse(previous.startedAt),
      Date.parse(plan.endedAt) - Date.parse(plan.startedAt),
    );
  });

  it("is null before the fact cutover or coverage start", () => {
    const plan = week("2026-08-15T12:00:00.000Z");
    assert.isNull(
      previousUsageWindow({
        plan,
        coverageStartedAt: "2026-07-01T00:00:00.000Z",
        factCutoverAt: "2026-08-05T00:00:00.000Z",
      }),
    );
    assert.isNull(
      previousUsageWindow({
        plan,
        coverageStartedAt: "2026-08-05T00:00:00.000Z",
        factCutoverAt: "2026-07-01T00:00:00.000Z",
      }),
    );
  });
});
