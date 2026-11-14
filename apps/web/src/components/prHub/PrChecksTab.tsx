import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SparklesIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type { PrHubCheckRun, PrHubCheckStatus, TrackedPullRequest } from "@t3tools/contracts";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prHubCheckLogQueryOptions, prHubChecksQueryOptions } from "../../lib/prHubReactQuery";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  groupPrChecks,
  prCheckDuration,
  prCheckLogUnavailableText,
  prCheckStatusLabel,
  prCheckWorkflows,
  prChecksSummary,
  type PrCheckGroup,
  type PrCheckGroupId,
} from "./prChecks";
import { prCanRerunChecks } from "./prQueueModel";

const CHECK_ICON: Record<PrHubCheckStatus, { Icon: LucideIcon; className: string }> = {
  success: { Icon: CheckCircle2Icon, className: "text-success-foreground" },
  failure: { Icon: XCircleIcon, className: "text-destructive-foreground" },
  cancelled: { Icon: CircleSlashIcon, className: "text-destructive-foreground" },
  pending: { Icon: CircleDashedIcon, className: "text-info-foreground" },
  neutral: { Icon: MinusCircleIcon, className: "text-muted-foreground" },
  skipped: { Icon: MinusCircleIcon, className: "text-muted-foreground" },
};

/** The icon that says how a check ended, so a failed check does not look like a passed one. */
export function PrCheckStatusIcon({
  status,
  className,
}: {
  status: PrHubCheckStatus;
  className?: string;
}) {
  const { Icon, className: tone } = CHECK_ICON[status];
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone, className)} />;
}

/** Passed and skipped checks are rarely why someone opens the tab; they start folded. */
const FOLDED_BY_DEFAULT: ReadonlySet<PrCheckGroupId> = new Set(["passed", "skipped"]);
/** How many failed checks show their log without being asked. */
const LOGS_OPEN_BY_DEFAULT = 3;

export interface PrChecksTabProps {
  pr: TrackedPullRequest;
  /** Asks to re-run the failed jobs; the caller confirms it. */
  onRerun?: (() => void) | undefined;
  /** Starts an agent on the failing checks. */
  onFixCi?: (() => void) | undefined;
  isStartingFix?: boolean | undefined;
}

function CheckLog({ pr, check }: { pr: TrackedPullRequest; check: PrHubCheckRun }) {
  const query = useQuery(prHubCheckLogQueryOptions(pr.key, check.id));
  if (query.isPending)
    return (
      <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" /> Loading log…
      </p>
    );
  const log = query.data;
  if (query.isError || !log?.excerpt) {
    const reason = query.isError
      ? query.error instanceof Error
        ? query.error.message
        : "The log could not be loaded."
      : prCheckLogUnavailableText(log?.unavailable ?? "failed");
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
        <span>{reason}</span>
        {query.isError || log?.unavailable === "failed" ? (
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        ) : null}
      </p>
    );
  }
  const lines = log.excerpt.split("\n");
  const endLine = log.startLine + lines.length - 1;
  const copy = () => {
    void writeTextToClipboard(log.excerpt ?? "").then(
      () => toastManager.add({ type: "success", title: "Log excerpt copied" }),
      () => toastManager.add({ type: "error", title: "Could not copy the log excerpt" }),
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-3 pb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {log.truncated
            ? `Lines ${log.startLine}–${endLine} of ${log.totalLines}`
            : `${log.totalLines} ${log.totalLines === 1 ? "line" : "lines"}`}
        </span>
        <Button size="xs" variant="ghost" onClick={copy}>
          <CopyIcon /> Copy
        </Button>
        {check.url ? (
          <OpenLinkAnchor
            href={check.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Open full log <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </OpenLinkAnchor>
        ) : null}
      </div>
      <pre
        // Focusable so the keyboard can scroll it; a group so the label is announced.
        role="group"
        tabIndex={0}
        aria-label={`Log of ${check.name}`}
        className="max-h-96 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {lines.map((line, index) => (
          <span
            // Lines repeat; their position in the excerpt is the only stable identity.
            key={index}
            className={cn(
              "block whitespace-pre",
              line.includes("##[error]") && "font-semibold text-destructive-foreground",
            )}
          >
            {/* An empty line still takes a row. */}
            {line === "" ? " " : line}
          </span>
        ))}
      </pre>
    </div>
  );
}

function CheckRow({
  pr,
  check,
  logOpenByDefault,
}: {
  pr: TrackedPullRequest;
  check: PrHubCheckRun;
  logOpenByDefault: boolean;
}) {
  const [logOpen, setLogOpen] = useState(logOpenByDefault);
  const failed = check.status === "failure" || check.status === "cancelled";
  const duration = prCheckDuration(check);
  const showsLog = failed && check.logAvailable;
  return (
    <li className="flex min-w-0 flex-col border-b border-border last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
        <PrCheckStatusIcon status={check.status} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-foreground">{check.name}</span>
            {check.required ? (
              <Badge variant="outline" size="sm">
                Required
              </Badge>
            ) : null}
          </span>
          {check.description ? (
            <span className="truncate text-xs text-muted-foreground">{check.description}</span>
          ) : null}
        </span>
        {showsLog ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={logOpen}
            aria-label={`${logOpen ? "Hide" : "Show"} log of ${check.name}`}
            onClick={() => setLogOpen(!logOpen)}
          >
            {logOpen ? "Hide log" : "Show log"}
          </Button>
        ) : null}
        {duration ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{duration}</span>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">
          {prCheckStatusLabel(check.status)}
        </span>
        {check.url ? (
          <OpenLinkAnchor
            href={check.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${check.name} on the forge`}
            className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </OpenLinkAnchor>
        ) : null}
      </div>
      {showsLog && logOpen ? <CheckLog pr={pr} check={check} /> : null}
    </li>
  );
}

function CheckGroup({
  pr,
  group,
  onlyGroup,
}: {
  pr: TrackedPullRequest;
  group: PrCheckGroup<PrHubCheckRun>;
  onlyGroup: boolean;
}) {
  const [open, setOpen] = useState(onlyGroup || !FOLDED_BY_DEFAULT.has(group.id));
  const headingId = `pr-checks-${group.id}`;
  const workflows = prCheckWorkflows(group.checks);
  // The first few failed checks that have a log open it; the rest wait for a click.
  const openLogs = new Set(
    group.id === "failed"
      ? group.checks
          .filter((check) => check.logAvailable)
          .slice(0, LOGS_OPEN_BY_DEFAULT)
          .map((check) => check.id)
      : [],
  );
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="text-sm font-semibold">
        <button
          type="button"
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {group.label}
          <span className="font-normal text-muted-foreground tabular-nums">
            {group.checks.length}
          </span>
        </button>
      </h3>
      {open
        ? workflows.map((workflow) => (
            <div key={workflow.name ?? ""} className="flex flex-col gap-1">
              {workflow.name !== null || workflows.length > 1 ? (
                <h4 className="text-xs font-medium text-muted-foreground">
                  {workflow.name ?? "Other checks"}
                </h4>
              ) : null}
              <ul
                aria-label={`${group.label} checks${workflow.name ? ` of ${workflow.name}` : ""}`}
                className="flex flex-col rounded-lg border border-border"
              >
                {workflow.checks.map((check) => (
                  <CheckRow
                    key={check.id}
                    pr={pr}
                    check={check}
                    logOpenByDefault={openLogs.has(check.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        : null}
    </section>
  );
}

/**
 * Every check of the head commit: the ones that block first, grouped by workflow, with the
 * log of each failed job cut down to the part around its error.
 */
export function PrChecksTab({ pr, onRerun, onFixCi, isStartingFix = false }: PrChecksTabProps) {
  const options = prHubChecksQueryOptions(pr.key);
  const query = useQuery(options);
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // The server reuses a recent read; Refresh asks the forge again.
  const refresh = async () => {
    setRefreshing(true);
    try {
      const data = await ensureNativeApi().prHub.getChecks({
        key: pr.key,
        accountGeneration: getPrHubAccountGeneration(),
        mode: "force",
      });
      client.setQueryData(options.queryKey, data);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not refresh the checks",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRefreshing(false);
    }
  };

  if (query.isPending) {
    return (
      <div
        role="tabpanel"
        aria-label="Checks"
        className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
      >
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading checks…
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="error" role="tabpanel" aria-label="Checks">
        <AlertTriangleIcon />
        <AlertTitle>Checks unavailable</AlertTitle>
        <AlertDescription>
          <span>
            {query.error instanceof Error ? query.error.message : "The checks could not be loaded."}
          </span>
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const { checks, truncated, headOid } = query.data;
  const groups = groupPrChecks(checks);
  const failed = groups.find((group) => group.id === "failed")?.checks ?? [];
  const actionable = pr.state === "open" && pr.ignoredAt === null && !pr.repositoryArchived;
  // Only GitHub Actions jobs belong to a workflow run that can be started again.
  const canRerun =
    !!onRerun && prCanRerunChecks(pr) && failed.some((check) => check.workflowRunId !== null);
  const canFix = !!onFixCi && actionable && failed.length > 0 && pr.roles.includes("author");
  // The list can be a commit behind the row for a moment after a push.
  const outdated = headOid !== null && pr.headRefOid !== null && headOid !== pr.headRefOid;
  return (
    <div role="tabpanel" aria-label="Checks" className="flex flex-col gap-4 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {groups.length > 0 ? prChecksSummary(checks) : "No checks ran on this commit."}
        </p>
        <Button
          size="xs"
          variant="ghost"
          disabled={refreshing}
          aria-label="Refresh checks"
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className={cn(refreshing && "animate-spin")} /> Refresh
        </Button>
        {canRerun ? (
          <Button size="xs" variant="outline" onClick={onRerun}>
            <RotateCcwIcon /> Re-run failed jobs
          </Button>
        ) : null}
        {canFix ? (
          <Button size="xs" disabled={isStartingFix} onClick={onFixCi}>
            <SparklesIcon /> {isStartingFix ? "Starting…" : "Fix CI with F5"}
          </Button>
        ) : null}
      </div>
      {truncated ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>Some checks are not listed</AlertTitle>
          <AlertDescription>
            This commit has more checks than F5 reads. Open the pull request on the forge to see all
            of them.
          </AlertDescription>
        </Alert>
      ) : null}
      {outdated ? (
        <p className="text-xs text-muted-foreground">
          These checks belong to a newer commit than the one shown above. Refresh the pull request
          to see it.
        </p>
      ) : null}
      {groups.map((group) => (
        <CheckGroup key={group.id} pr={pr} group={group} onlyGroup={groups.length === 1} />
      ))}
    </div>
  );
}
