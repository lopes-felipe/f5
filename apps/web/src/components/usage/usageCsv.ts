import type { ProjectId, UsageMetrics, UsageRange, UsageSummary } from "@t3tools/contracts";

import { isCostUnknown, providerLabel, totalCost } from "./format";

export type UsageCsvKind = "over-time" | "models" | "projects" | "threads";

export const USAGE_CSV_KINDS: ReadonlyArray<{
  readonly kind: UsageCsvKind;
  readonly label: string;
}> = [
  { kind: "over-time", label: "Usage over time" },
  { kind: "models", label: "Providers and models" },
  { kind: "projects", label: "Projects" },
  { kind: "threads", label: "Threads" },
];

type Cell = string | number | boolean | null | undefined;

/**
 * RFC 4180 quoting: wrap fields containing a quote, comma, CR or LF and double
 * inner quotes. Text cells that a spreadsheet would read as a formula (thread
 * titles can carry agent output) get a leading `'`; numbers stay raw.
 */
export function csvField(value: Cell): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<Cell>>) {
  return `${[header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

const METRIC_HEADER = [
  "recorded_turns",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_usd",
  "unpriced_turns",
] as const;

/** Raw numbers; an unknown cost stays empty rather than zero. */
function metricCells(metrics: UsageMetrics): Array<Cell> {
  return [
    metrics.turnCount,
    metrics.totalTokens,
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.cacheReadTokens,
    metrics.cacheWriteTokens,
    isCostUnknown(metrics) ? null : Number(totalCost(metrics).toFixed(6)),
    metrics.unpricedTurnCount,
  ];
}

export function usageCsv(
  summary: UsageSummary,
  kind: UsageCsvKind,
  projectName: (projectId: ProjectId, title: string | null) => string,
): string {
  switch (kind) {
    case "over-time":
      return toCsv(
        ["interval_start", "interval_end", ...METRIC_HEADER],
        summary.buckets.map((bucket) => [
          bucket.startAt,
          bucket.endAt,
          ...metricCells(bucket.metrics),
        ]),
      );
    case "models":
      return toCsv(
        ["provider", "model", ...METRIC_HEADER],
        summary.byProvider.map((entry) => [
          providerLabel(entry.provider),
          entry.model,
          ...metricCells(entry.metrics),
        ]),
      );
    case "projects":
      return toCsv(
        ["project_id", "project", "deleted", ...METRIC_HEADER],
        (summary.projectScope?.byProject ?? []).map((project) => [
          project.projectId,
          project.projectId === null
            ? "Unattributed historical cost"
            : projectName(project.projectId, project.title),
          project.deleted,
          ...metricCells(project.metrics),
        ]),
      );
    case "threads":
      return toCsv(
        ["thread_id", "thread", "project_id", "deleted", ...METRIC_HEADER],
        (summary.projectScope?.topThreads ?? []).map((thread) => [
          thread.threadId,
          thread.title ?? "Untitled thread",
          thread.projectId,
          thread.deleted,
          ...metricCells(thread.metrics),
        ]),
      );
  }
}

/** `f5-usage-7d-models-2026-11-08.csv`, dated in local time. */
export function usageCsvFilename(range: UsageRange, kind: UsageCsvKind, now = new Date()): string {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `f5-usage-${range}-${kind}-${date}.csv`;
}
