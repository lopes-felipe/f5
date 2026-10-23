import type { ProjectId, UsageMetrics, UsageProjectScope } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "../ui/card";
import type { UsageChartMetric } from "./charts/StackedBarChart";
import {
  costLabel,
  isCostUnknown,
  recordCountDisplay,
  tokenFieldDisplay,
  usageMetricValue,
} from "./format";

const INITIAL_PROJECT_ROWS = 10;
const TOP_THREAD_ROWS = 10;

interface Row {
  readonly key: string;
  readonly name: string;
  readonly deleted: boolean;
  readonly projectId: ProjectId | null;
  readonly threadId: string | null;
  readonly projectName: string | null;
  readonly metrics: UsageMetrics;
  readonly unattributed: boolean;
}

function sortRows(rows: ReadonlyArray<Row>, metric: UsageChartMetric): Array<Row> {
  return [...rows].sort(
    (left, right) =>
      Number(left.unattributed) - Number(right.unattributed) ||
      usageMetricValue(right.metrics, metric) - usageMetricValue(left.metrics, metric) ||
      left.name.localeCompare(right.name) ||
      left.key.localeCompare(right.key),
  );
}

export function ProjectsThreadsCard(props: {
  readonly scope: UsageProjectScope;
  readonly metric: UsageChartMetric;
  /** Metrics of the (possibly project-filtered) summary; the Threads denominator. */
  readonly totalMetrics: UsageMetrics;
  readonly projectName: (projectId: ProjectId, title: string | null) => string;
  readonly onSelectProject: (projectId: ProjectId | undefined) => void;
}) {
  const [view, setView] = useState<"projects" | "threads">("projects");
  const [showAll, setShowAll] = useState(false);
  const { scope } = props;
  // Shares follow the selected metric. Projects ignore the project filter, so
  // their shares use the catalog total.
  const shareDenominator =
    view === "projects"
      ? scope.byProject.reduce(
          (sum, project) => sum + usageMetricValue(project.metrics, props.metric),
          0,
        )
      : usageMetricValue(props.totalMetrics, props.metric);
  const showShare = shareDenominator > 0;

  const projectRows = sortRows(
    scope.byProject.map((project) => ({
      key: project.projectId ?? "\u0000unattributed",
      name:
        project.projectId === null
          ? "Unattributed historical cost"
          : props.projectName(project.projectId, project.title),
      deleted: project.deleted,
      projectId: project.projectId,
      threadId: null,
      projectName: null,
      metrics: project.metrics,
      unattributed: project.projectId === null,
    })),
    props.metric,
  );
  const threadRows = sortRows(
    scope.topThreads.map((thread) => ({
      key: thread.threadId,
      name: thread.title ?? "Untitled thread",
      deleted: thread.deleted,
      projectId: thread.projectId,
      threadId: thread.threadId,
      projectName:
        thread.projectId === null
          ? "Unknown project"
          : props.projectName(
              thread.projectId,
              scope.byProject.find((project) => project.projectId === thread.projectId)?.title ??
                null,
            ),
      metrics: thread.metrics,
      unattributed: false,
    })),
    props.metric,
    // The server sends the top threads by every metric; show the top by this one.
  ).slice(0, TOP_THREAD_ROWS);
  const rows =
    view === "projects"
      ? showAll
        ? projectRows
        : projectRows.slice(0, INITIAL_PROJECT_ROWS)
      : threadRows;
  const selectedName =
    scope.selectedProjectId === null
      ? null
      : (projectRows.find((row) => row.projectId === scope.selectedProjectId)?.name ??
        props.projectName(scope.selectedProjectId, null));

  return (
    <Card className="rounded-xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 p-4 pb-2">
        <CardTitle className="text-sm">Projects and threads</CardTitle>
        <div className="flex items-center gap-2">
          {selectedName ? (
            <Button size="xs" variant="ghost" onClick={() => props.onSelectProject(undefined)}>
              Clear filter: {selectedName}
            </Button>
          ) : null}
          <div
            aria-label="Breakdown view"
            className="flex rounded-lg border border-border bg-muted/30 p-0.5"
          >
            {(["projects", "threads"] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={view === value ? "secondary" : "ghost"}
                aria-pressed={view === value}
                onClick={() => setView(value)}
              >
                {value === "projects" ? "Projects" : "Threads"}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardPanel className="overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No recorded usage in this range.</p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="border-y border-border/70 bg-muted/20 text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                {view === "threads" ? <th className="px-4 py-2 font-medium">Project</th> : null}
                <th className="px-4 py-2 text-right font-medium">Recorded turns</th>
                <th className="px-4 py-2 text-right font-medium">Known tokens</th>
                <th className="px-4 py-2 text-right font-medium">Known cost</th>
                {showShare ? (
                  <th
                    className="px-4 py-2 text-right font-medium"
                    title={`Share of ${props.metric}`}
                  >
                    Share
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const tokens = tokenFieldDisplay(row.metrics, "totalTokens");
                const records = recordCountDisplay(row.metrics);
                const label = `${row.name}${row.deleted ? " (deleted)" : ""}`;
                return (
                  <tr
                    key={row.key}
                    className={cn(
                      "border-b border-border/50 last:border-b-0",
                      (row.deleted || row.unattributed) && "text-muted-foreground",
                    )}
                  >
                    <td className="max-w-72 truncate px-4 py-2.5 font-medium">
                      {view === "threads" && row.threadId && !row.deleted ? (
                        <Link
                          to="/$threadId"
                          params={{ threadId: row.threadId }}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {label}
                        </Link>
                      ) : view === "projects" && row.projectId && !row.unattributed ? (
                        <button
                          type="button"
                          className="text-left text-foreground underline-offset-2 hover:underline aria-pressed:font-semibold"
                          aria-pressed={scope.selectedProjectId === row.projectId}
                          onClick={() => props.onSelectProject(row.projectId ?? undefined)}
                        >
                          {label}
                        </button>
                      ) : (
                        label
                      )}
                    </td>
                    {view === "threads" ? (
                      <td className="max-w-48 truncate px-4 py-2.5 text-muted-foreground">
                        {row.projectName}
                      </td>
                    ) : null}
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {records.count}
                      {records.legacyCostEvents
                        ? ` + ${records.legacyCostEvents} legacy cost records`
                        : ""}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {tokens.value}
                      {tokens.detail ? (
                        <span className="block text-2xs text-muted-foreground">
                          {tokens.detail}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {costLabel(row.metrics)}
                    </td>
                    {showShare ? (
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {props.metric === "cost" && isCostUnknown(row.metrics)
                          ? ""
                          : `${Math.round(
                              (usageMetricValue(row.metrics, props.metric) / shareDenominator) *
                                100,
                            )}%`}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {view === "projects" && !showAll && projectRows.length > INITIAL_PROJECT_ROWS ? (
          <div className="p-3">
            <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
              Show all {projectRows.length}
            </Button>
          </div>
        ) : null}
        {view === "threads" && threadRows.length > 0 ? (
          <p className="p-3 text-2xs text-muted-foreground">
            Showing top {threadRows.length} of {scope.threadCount} threads
          </p>
        ) : null}
      </CardPanel>
    </Card>
  );
}
