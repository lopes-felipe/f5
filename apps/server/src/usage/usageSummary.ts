import {
  ProjectId,
  ThreadId,
  type IsoDateTime,
  type ProviderKind,
  type UsageGetSummaryInput,
  type UsageMetrics,
  type UsagePriceOverride,
  type UsageProjectBreakdown,
  type UsageProjectScope,
  type UsageProviderBreakdown,
  type UsageSummary,
  type UsageThreadBreakdown,
  type UsageTokenComposition,
} from "@t3tools/contracts";

import type {
  BucketUsageSummaryRow,
  ScopeUsageSummaryRow,
  UsageAggregateRow,
  UsageScopeTitles,
} from "../persistence/Services/UsageFacts.ts";
import type { UsageBucketPlan } from "./usageBuckets.ts";

export const TOP_THREAD_LIMIT = 10;

interface MutableMetrics {
  turnCount: number;
  reportedTokenTurnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  providerReportedCostUsd: number;
  estimatedCostUsd: number;
  estimatedTurnCount: number;
  reportedCostTurnCount: number;
  pricedTurnCount: number;
  unpricedTurnCount: number;
  recordedTurnCount: number;
  legacyCostEventCount: number;
  inputTokenTurnCount: number;
  outputTokenTurnCount: number;
  cacheReadTokenTurnCount: number;
  cacheWriteTokenTurnCount: number;
  totalTokenTurnCount: number;
}

type MutableComposition = { -readonly [Key in keyof UsageTokenComposition]: number };

function emptyComposition(): MutableComposition {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unattributedTokens: 0,
  };
}

function emptyMetrics(): MutableMetrics {
  return {
    turnCount: 0,
    reportedTokenTurnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerReportedCostUsd: 0,
    estimatedCostUsd: 0,
    estimatedTurnCount: 0,
    reportedCostTurnCount: 0,
    pricedTurnCount: 0,
    unpricedTurnCount: 0,
    recordedTurnCount: 0,
    legacyCostEventCount: 0,
    inputTokenTurnCount: 0,
    outputTokenTurnCount: 0,
    cacheReadTokenTurnCount: 0,
    cacheWriteTokenTurnCount: 0,
    totalTokenTurnCount: 0,
  };
}

function addMetrics(target: MutableMetrics, row: UsageAggregateRow): void {
  target.reportedCostTurnCount += row.providerReportedCostUsd === null ? 0 : row.pricedTurnCount;
  target.estimatedTurnCount += row.estimatedCostUsd !== undefined ? row.turnCount : 0;
  target.estimatedCostUsd += row.estimatedCostUsd ?? 0;
  target.turnCount += row.turnCount;
  target.reportedTokenTurnCount += row.reportedTokenTurnCount;
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.cacheWriteTokens += row.cacheWriteTokens;
  target.totalTokens += row.totalTokens;
  target.providerReportedCostUsd += row.providerReportedCostUsd ?? 0;
  target.pricedTurnCount += row.pricedTurnCount;
  target.unpricedTurnCount += row.unpricedTurnCount;
  target.recordedTurnCount += row.recordedTurnCount;
  target.legacyCostEventCount += row.legacyCostEventCount;
  target.inputTokenTurnCount += row.inputTokenTurnCount;
  target.outputTokenTurnCount += row.outputTokenTurnCount;
  target.cacheReadTokenTurnCount += row.cacheReadTokenTurnCount;
  target.cacheWriteTokenTurnCount += row.cacheWriteTokenTurnCount;
  target.totalTokenTurnCount += row.totalTokenTurnCount;
}

function freezeMetrics(metrics: MutableMetrics): UsageMetrics {
  return {
    turnCount: metrics.turnCount,
    reportedTokenTurnCount: metrics.reportedTokenTurnCount,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    totalTokens: metrics.totalTokens,
    pricedTurnCount: metrics.pricedTurnCount,
    unpricedTurnCount: metrics.unpricedTurnCount,
    ...(metrics.estimatedTurnCount > 0 ? { estimatedCostUsd: metrics.estimatedCostUsd } : {}),
    providerReportedCostUsd:
      metrics.reportedCostTurnCount > 0 ? metrics.providerReportedCostUsd : null,
    reporting: {
      recordedTurnCount: metrics.recordedTurnCount,
      legacyCostEventCount: metrics.legacyCostEventCount,
      inputTokenTurnCount: metrics.inputTokenTurnCount,
      outputTokenTurnCount: metrics.outputTokenTurnCount,
      cacheReadTokenTurnCount: metrics.cacheReadTokenTurnCount,
      cacheWriteTokenTurnCount: metrics.cacheWriteTokenTurnCount,
      totalTokenTurnCount: metrics.totalTokenTurnCount,
    },
  };
}

function metricsCost(metrics: UsageMetrics): number {
  return (metrics.providerReportedCostUsd ?? 0) + (metrics.estimatedCostUsd ?? 0);
}

/**
 * Resolves user model mappings to their final target, so `a -> b` and
 * `b -> c` both land on `c`. A model whose chain enters a loop is left
 * unmapped.
 */
export function resolveModelAliases(
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  for (const model of Object.keys(aliases)) {
    const seen = new Set([model]);
    let target = aliases[model]!;
    while (Object.hasOwn(aliases, target) && !seen.has(target)) {
      seen.add(target);
      target = aliases[target]!;
    }
    // Stopping on a mapped model means the chain entered a loop.
    if (!Object.hasOwn(aliases, target) && target !== model) resolved.set(model, target);
  }
  return resolved;
}

/**
 * Renames mapped models before aggregation, so their rows merge into the
 * target model and take the target's price.
 */
export function applyModelAliases<Row extends UsageAggregateRow>(
  rows: ReadonlyArray<Row>,
  aliases: ReadonlyMap<string, string>,
): ReadonlyArray<Row> {
  if (aliases.size === 0) return rows;
  return rows.map((row) => {
    const model = row.model === null ? undefined : aliases.get(row.model);
    return model === undefined ? row : { ...row, model };
  });
}

/**
 * Applies the user's price for the row's provider/model when the provider
 * omitted cost and every turn in the row reported input and output tokens.
 */
export function applyPriceOverride<Row extends UsageAggregateRow>(
  row: Row,
  overrides: ReadonlyArray<UsagePriceOverride> | undefined,
): Row {
  const override = overrides?.find(
    (price) => price.provider === row.provider && price.model === row.model,
  );
  const canEstimate =
    override &&
    row.providerReportedCostUsd === null &&
    (row.estimationEligibleTurnCount ?? row.reportedTokenTurnCount) === row.turnCount &&
    row.turnCount > 0;
  if (!canEstimate) return row;
  const claude = row.provider === "claudeAgent";
  return {
    ...row,
    estimatedCostUsd:
      ((claude ? row.inputTokens : Math.max(0, row.inputTokens - row.cacheReadTokens)) *
        override.inputUsdPerMillion +
        row.outputTokens * override.outputUsdPerMillion +
        row.cacheReadTokens * (override.cacheReadUsdPerMillion ?? override.inputUsdPerMillion) +
        (claude ? row.cacheWriteTokens : 0) *
          (override.cacheWriteUsdPerMillion ?? override.inputUsdPerMillion)) /
      1_000_000,
    pricedTurnCount: row.turnCount,
    unpricedTurnCount: 0,
  };
}

/** Aggregates rows (prices applied) into one metrics value. */
export function aggregateUsageMetrics(
  rows: ReadonlyArray<UsageAggregateRow>,
  priceOverrides?: ReadonlyArray<UsagePriceOverride>,
): UsageMetrics {
  const metrics = emptyMetrics();
  for (const row of rows) addMetrics(metrics, applyPriceOverride(row, priceOverrides));
  return freezeMetrics(metrics);
}

function addComposition(target: MutableComposition, row: UsageAggregateRow): void {
  // Only partitions with a known total contribute, so unknown-total rows
  // cannot inflate the stacked composition.
  if (row.totalTokenTurnCount === 0) return;
  const claude = row.provider === "claudeAgent";
  const segments: UsageTokenComposition = {
    uncachedInputTokens: claude
      ? row.inputTokens
      : Math.max(0, row.inputTokens - row.cacheReadTokens),
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: claude ? row.cacheWriteTokens : 0,
    unattributedTokens: 0,
  };
  const attributed = Object.values(segments).reduce((sum, value) => sum + value, 0);
  for (const key of Object.keys(segments) as Array<keyof UsageTokenComposition>)
    target[key] += segments[key];
  target.unattributedTokens += Math.max(0, row.totalTokens - attributed);
}

export function buildUsageSummary(input: {
  readonly request: UsageGetSummaryInput;
  readonly now: Date;
  readonly coverageStartedAt: IsoDateTime;
  readonly plan: UsageBucketPlan;
  readonly rows: ReadonlyArray<BucketUsageSummaryRow>;
  readonly priceOverrides?: ReadonlyArray<UsagePriceOverride>;
  readonly projectScope?: UsageProjectScope | null;
  readonly previousMetrics?: UsageMetrics | null;
}): UsageSummary {
  const bucketMetrics = new Map(input.plan.buckets.map((bucket) => [bucket.key, emptyMetrics()]));
  const compositions = new Map(
    input.plan.buckets.map((bucket) => [bucket.key, emptyComposition()]),
  );
  const totalMetrics = emptyMetrics();
  const providerMetrics = new Map<string, MutableMetrics>();
  const providerIdentity = new Map<string, { provider: ProviderKind; model: string | null }>();
  const providerAggregate = new Map<ProviderKind, MutableMetrics>();

  for (const originalRow of input.rows) {
    const bucket = bucketMetrics.get(originalRow.bucketKey);
    if (!bucket) continue;
    const row = applyPriceOverride(originalRow, input.priceOverrides);
    addComposition(compositions.get(row.bucketKey)!, row);
    addMetrics(bucket, row);
    addMetrics(totalMetrics, row);

    const identityKey = `${row.provider}\u0000${row.model ?? ""}`;
    const metrics = providerMetrics.get(identityKey) ?? emptyMetrics();
    addMetrics(metrics, row);
    providerMetrics.set(identityKey, metrics);
    providerIdentity.set(identityKey, { provider: row.provider as ProviderKind, model: row.model });

    const aggregate = providerAggregate.get(row.provider as ProviderKind) ?? emptyMetrics();
    addMetrics(aggregate, row);
    providerAggregate.set(row.provider as ProviderKind, aggregate);
  }

  const buckets = input.plan.buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    startAt: bucket.startAt,
    endAt: bucket.endAt,
    metrics: freezeMetrics(bucketMetrics.get(bucket.key) ?? emptyMetrics()),
    composition: compositions.get(bucket.key) ?? emptyComposition(),
  }));
  const byProvider: Array<UsageProviderBreakdown> = Array.from(providerMetrics.entries())
    .map(([key, metrics]) => ({
      ...providerIdentity.get(key)!,
      metrics: freezeMetrics(metrics),
    }))
    .sort(
      (left, right) =>
        right.metrics.totalTokens - left.metrics.totalTokens ||
        (right.metrics.providerReportedCostUsd ?? 0) -
          (left.metrics.providerReportedCostUsd ?? 0) ||
        left.provider.localeCompare(right.provider) ||
        (left.model ?? "").localeCompare(right.model ?? ""),
    );
  const providersMissingTokens = Array.from(providerAggregate.entries())
    .filter(([, metrics]) => metrics.reportedTokenTurnCount < metrics.turnCount)
    .map(([provider]) => provider)
    .sort();
  const providersMissingCost = Array.from(providerAggregate.entries())
    .filter(([, metrics]) => metrics.unpricedTurnCount > 0)
    .map(([provider]) => provider)
    .sort();

  return {
    range: input.request.range,
    timeZone: input.request.timeZone,
    generatedAt: input.now.toISOString(),
    metrics: freezeMetrics(totalMetrics),
    buckets,
    byProvider,
    coverage: {
      coverageStartedAt: input.coverageStartedAt,
      rangeStartedAt: input.plan.startedAt,
      partialHistory: input.plan.startedAt < input.coverageStartedAt,
      historicalCostTurnCount: totalMetrics.legacyCostEventCount,
      tokenUnreportedTurnCount: totalMetrics.turnCount - totalMetrics.reportedTokenTurnCount,
      costUnreportedTurnCount: totalMetrics.unpricedTurnCount,
      providersMissingTokens,
      providersMissingCost,
    },
    nextBucketAt: input.plan.nextBucketAt,
    projectScope: input.projectScope ?? null,
    previousMetrics: input.previousMetrics ?? null,
  };
}

function compareBreakdown(
  left: { readonly id: string | null; readonly metrics: UsageMetrics },
  right: { readonly id: string | null; readonly metrics: UsageMetrics },
): number {
  return (
    right.metrics.totalTokens - left.metrics.totalTokens ||
    metricsCost(right.metrics) - metricsCost(left.metrics) ||
    (left.id === null ? 1 : 0) - (right.id === null ? 1 : 0) ||
    (left.id ?? "").localeCompare(right.id ?? "")
  );
}

const THREAD_RANKINGS: ReadonlyArray<(metrics: UsageMetrics) => number> = [
  (metrics) => metrics.totalTokens,
  metricsCost,
  (metrics) => metrics.reporting?.recordedTurnCount ?? metrics.turnCount,
];

/**
 * The union of the top threads by each chart metric (tokens, cost, recorded
 * turns), so the client can rank by any metric without missing threads.
 */
function topThreadsByEveryMetric<
  Entry extends { readonly id: string; readonly metrics: UsageMetrics },
>(threads: ReadonlyArray<Entry>): Array<Entry> {
  const selected = new Set<Entry>();
  for (const rank of THREAD_RANKINGS) {
    const ranked = [...threads].sort(
      (left, right) => rank(right.metrics) - rank(left.metrics) || compareBreakdown(left, right),
    );
    for (const thread of ranked.slice(0, TOP_THREAD_LIMIT)) selected.add(thread);
  }
  return [...selected].sort(compareBreakdown);
}

export interface UsageScopeAggregation {
  readonly projects: ReadonlyArray<{ readonly id: string | null; readonly metrics: UsageMetrics }>;
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string | null;
    readonly metrics: UsageMetrics;
  }>;
  readonly threadCount: number;
}

/**
 * Aggregates per-thread rows into all projects (ignoring the project filter)
 * and the top threads of the selected project.
 */
export function aggregateUsageScope(input: {
  readonly rows: ReadonlyArray<ScopeUsageSummaryRow>;
  readonly projectId: string | null;
  readonly priceOverrides?: ReadonlyArray<UsagePriceOverride>;
}): UsageScopeAggregation {
  const projects = new Map<string | null, MutableMetrics>();
  const threads = new Map<string, { projectId: string | null; metrics: MutableMetrics }>();
  for (const originalRow of input.rows) {
    const row = applyPriceOverride(originalRow, input.priceOverrides);
    const project = projects.get(row.projectId) ?? emptyMetrics();
    addMetrics(project, row);
    projects.set(row.projectId, project);
    if (row.threadId === null) continue;
    if (input.projectId !== null && row.projectId !== input.projectId) continue;
    const thread = threads.get(row.threadId) ?? {
      projectId: row.projectId,
      metrics: emptyMetrics(),
    };
    addMetrics(thread.metrics, row);
    threads.set(row.threadId, thread);
  }
  return {
    projects: Array.from(projects.entries())
      .map(([id, metrics]) => ({ id, metrics: freezeMetrics(metrics) }))
      .sort(compareBreakdown),
    threads: topThreadsByEveryMetric(
      Array.from(threads.entries()).map(([id, thread]) => ({
        id,
        projectId: thread.projectId,
        metrics: freezeMetrics(thread.metrics),
      })),
    ),
    threadCount: threads.size,
  };
}

export function buildUsageProjectScope(input: {
  readonly aggregation: UsageScopeAggregation;
  readonly selectedProjectId: string | null;
  readonly titles: UsageScopeTitles;
}): UsageProjectScope {
  const projectTitles = new Map(input.titles.projects.map((entry) => [entry.id, entry]));
  const threadTitles = new Map(input.titles.threads.map((entry) => [entry.id, entry]));
  const byProject: Array<UsageProjectBreakdown> = input.aggregation.projects.map((project) => {
    const title = project.id === null ? undefined : projectTitles.get(project.id);
    return {
      projectId: project.id === null ? null : ProjectId.makeUnsafe(project.id),
      title: title?.title ?? null,
      deleted: project.id === null ? false : (title?.deleted ?? true),
      metrics: project.metrics,
    };
  });
  const topThreads: Array<UsageThreadBreakdown> = input.aggregation.threads.map((thread) => {
    const title = threadTitles.get(thread.id);
    const projectId = thread.projectId ?? title?.projectId ?? null;
    return {
      threadId: ThreadId.makeUnsafe(thread.id),
      projectId: projectId === null ? null : ProjectId.makeUnsafe(projectId),
      title: title?.title ?? null,
      deleted: title?.deleted ?? true,
      metrics: thread.metrics,
    };
  });
  return {
    selectedProjectId:
      input.selectedProjectId === null ? null : ProjectId.makeUnsafe(input.selectedProjectId),
    byProject,
    topThreads,
    threadCount: input.aggregation.threadCount,
  };
}

/**
 * The equal-duration window ending at the current start, or null when it
 * predates complete fact recording (pre-cutover rows carry cost but no tokens).
 */
export function previousUsageWindow(input: {
  readonly plan: UsageBucketPlan;
  readonly coverageStartedAt: IsoDateTime;
  readonly factCutoverAt: IsoDateTime;
}): { readonly startedAt: IsoDateTime; readonly endedAt: IsoDateTime } | null {
  const start = Date.parse(input.plan.startedAt);
  const end = Date.parse(input.plan.endedAt);
  const startedAt = new Date(start - (end - start)).toISOString();
  const completeFrom =
    input.factCutoverAt > input.coverageStartedAt ? input.factCutoverAt : input.coverageStartedAt;
  return startedAt >= completeFrom ? { startedAt, endedAt: input.plan.startedAt } : null;
}
