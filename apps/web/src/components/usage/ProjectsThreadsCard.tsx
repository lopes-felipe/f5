import type { ProjectId, UsageMetrics, UsageProjectScope } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SearchIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import type { UsageChartMetric } from "./charts/StackedBarChart";
import {
  costLabel,
  isCostUnknown,
  recordCountDisplay,
  tokenFieldDisplay,
  totalCost,
  usageMetricValue,
} from "./format";
import {
  sortUsageRows,
  type UsageColumn,
  type UsageSort,
  UsageSection,
  UsageTable,
  UsageToggle,
} from "./kit";

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

/** Case-insensitive name match; threads also match their project's name. */
export function matchesUsageRowQuery(
  row: { readonly name: string; readonly projectName: string | null },
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return (
    row.name.toLocaleLowerCase().includes(needle) ||
    (row.projectName?.toLocaleLowerCase().includes(needle) ?? false)
  );
}

const METRIC_COLUMN: Record<UsageChartMetric, string> = {
  tokens: "tokens",
  cost: "cost",
  turns: "turns",
};

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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<UsageSort | null>(null);
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
          ? "Usage without a project"
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
  const allThreadRows = sortRows(
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
  );
  // The server sends the top threads by every metric; show the top by this one,
  // but let search reach all of them.
  const threadRows = allThreadRows.slice(0, TOP_THREAD_ROWS);
  const searching = query.trim() !== "";
  const selectedName =
    scope.selectedProjectId === null
      ? null
      : (projectRows.find((row) => row.projectId === scope.selectedProjectId)?.name ??
        props.projectName(scope.selectedProjectId, null));

  const columns: Array<UsageColumn<Row>> = [
    {
      key: "name",
      header: "Name",
      sortValue: (row) => row.name,
      className: "max-w-72 truncate font-medium",
      render: (row) => {
        const label = `${row.name}${row.deleted ? " (deleted)" : ""}`;
        if (view === "threads" && row.threadId && !row.deleted)
          return (
            <Link
              to="/$threadId"
              params={{ threadId: row.threadId }}
              className="text-foreground underline-offset-2 hover:underline"
            >
              {label}
            </Link>
          );
        if (view === "projects" && row.projectId && !row.unattributed)
          return (
            <button
              type="button"
              className="text-left text-foreground underline-offset-2 hover:underline aria-pressed:font-semibold"
              aria-pressed={scope.selectedProjectId === row.projectId}
              onClick={() => props.onSelectProject(row.projectId ?? undefined)}
            >
              {label}
            </button>
          );
        return label;
      },
    },
    ...(view === "threads"
      ? [
          {
            key: "project",
            header: "Project",
            sortValue: (row: Row) => row.projectName ?? "",
            className: "max-w-48 truncate text-muted-foreground",
            render: (row: Row) => row.projectName,
          },
        ]
      : []),
    {
      key: "turns",
      header: "Recorded turns",
      align: "right",
      sortValue: (row) => row.metrics.turnCount,
      render: (row) => {
        const records = recordCountDisplay(row.metrics);
        return `${records.count}${
          records.legacyCostEvents ? ` + ${records.legacyCostEvents} legacy cost records` : ""
        }`;
      },
    },
    {
      key: "tokens",
      header: "Known tokens",
      align: "right",
      sortValue: (row) => row.metrics.totalTokens,
      render: (row) => {
        const tokens = tokenFieldDisplay(row.metrics, "totalTokens");
        return (
          <>
            {tokens.value}
            {tokens.detail ? (
              <span className="block text-2xs text-muted-foreground">{tokens.detail}</span>
            ) : null}
          </>
        );
      },
    },
    {
      key: "cost",
      header: "Known cost",
      align: "right",
      sortValue: (row) => (isCostUnknown(row.metrics) ? -1 : totalCost(row.metrics)),
      render: (row) => costLabel(row.metrics),
    },
    ...(showShare
      ? [
          {
            key: "share",
            header: "Share",
            headerTitle: `Share of ${props.metric}`,
            align: "right" as const,
            render: (row: Row) =>
              props.metric === "cost" && isCostUnknown(row.metrics)
                ? ""
                : `${Math.round((usageMetricValue(row.metrics, props.metric) / shareDenominator) * 100)}%`,
          },
        ]
      : []),
  ];
  // Without a chosen column the rows keep the selected-metric order.
  const effectiveSort: UsageSort = sort ?? { key: METRIC_COLUMN[props.metric], direction: "desc" };
  const pinLast = (row: Row) => row.unattributed;
  // Sort the whole list before trimming, so a column sort reaches every project.
  const visibleProjects = sortUsageRows(
    projectRows.filter((row) => matchesUsageRowQuery(row, query)),
    columns,
    effectiveSort,
    pinLast,
  );
  const rows =
    view === "projects"
      ? showAll || searching
        ? visibleProjects
        : visibleProjects.slice(0, INITIAL_PROJECT_ROWS)
      : (searching ? allThreadRows : threadRows).filter((row) => matchesUsageRowQuery(row, query));

  return (
    <UsageSection
      title="Projects and threads"
      flush
      actions={
        <>
          {selectedName ? (
            <Button size="xs" variant="ghost" onClick={() => props.onSelectProject(undefined)}>
              Clear filter: {selectedName}
            </Button>
          ) : null}
          <InputGroup className="w-44">
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              size="sm"
              type="search"
              aria-label="Filter by name"
              placeholder="Filter by name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {searching ? (
              <InputGroupAddon align="inline-end">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Clear name filter"
                  onClick={() => setQuery("")}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <UsageToggle
            label="Breakdown view"
            value={view}
            options={[
              { value: "projects", label: "Projects" },
              { value: "threads", label: "Threads" },
            ]}
            onChange={(next) => {
              setView(next);
              setSort(null);
            }}
          />
        </>
      }
    >
      <UsageTable
        caption={view === "projects" ? "Projects" : "Threads"}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        rowClassName={(row) => (row.deleted || row.unattributed) && "text-muted-foreground"}
        sort={effectiveSort}
        onSortChange={setSort}
        pinLast={pinLast}
        empty={
          searching ? `No ${view} match “${query.trim()}”.` : "No recorded usage in this range."
        }
        footer={
          <>
            {view === "projects" &&
            !showAll &&
            !searching &&
            projectRows.length > INITIAL_PROJECT_ROWS ? (
              <div className="border-t border-border/50 p-3">
                <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
                  Show all {projectRows.length}
                </Button>
              </div>
            ) : null}
            {view === "threads" && threadRows.length > 0 ? (
              <p className="border-t border-border/50 p-3 text-2xs text-muted-foreground">
                {searching
                  ? `Search covers the top ${allThreadRows.length} of ${scope.threadCount} threads.`
                  : `Showing top ${threadRows.length} of ${scope.threadCount} threads`}
              </p>
            ) : null}
          </>
        }
      />
    </UsageSection>
  );
}
