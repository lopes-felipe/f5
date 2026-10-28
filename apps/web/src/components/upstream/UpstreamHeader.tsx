import type {
  ProjectId,
  ServerProvider,
  UpstreamOverview,
  UpstreamProjectSummary,
  UpstreamResolvePublicationInput,
  UpstreamRunKind,
  UpstreamRunTriage,
} from "@t3tools/contracts";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  PlayIcon,
  RefreshCwIcon,
} from "lucide-react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LedgerChip } from "./PublicationBanner";
import { UpstreamSettingsPopover } from "./UpstreamSettingsPopover";
import { UpstreamPortQueue } from "./UpstreamPortQueue";
import { repositoryUrl, runDisabledReason, runStatus, shortRepository } from "./upstreamPage.logic";

const formatNextRun = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

function RunStatusChip(props: {
  readonly overview: UpstreamOverview;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onRun: (kind: UpstreamRunKind, triage: UpstreamRunTriage) => void;
}) {
  const { overview } = props;
  const status = runStatus(overview, formatRelativeTimeLabel, formatNextRun);
  const run = overview.activeRun ?? overview.lastRun;
  const disabledReason = runDisabledReason(props);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className={cn("text-muted-foreground", status.tone === "failed" && "text-destructive-foreground")}
          />
        }
      >
        {status.tone === "running" ? (
          <Spinner className="size-3.5" />
        ) : status.tone === "failed" ? (
          <AlertCircleIcon aria-hidden="true" />
        ) : (
          <CircleCheckIcon aria-hidden="true" />
        )}
        {status.label}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 space-y-3 text-sm">
        {run ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">
              {run.kind === "retriage" ? "Re-triage run" : run.kind === "legacy" ? "Legacy run" : "Run"}
            </dt>
            <dd>
              {run.status} · {formatRelativeTimeLabel(run.finishedAt ?? run.startedAt)} ({run.trigger},{" "}
              {run.triage === "llm" ? "LLM" : "rules only"})
            </dd>
            <dt className="text-muted-foreground">Commits</dt>
            <dd className="tabular-nums">{run.commitCount}</dd>
            <dt className="text-muted-foreground">To review</dt>
            <dd className="tabular-nums">{run.inboxCount}</dd>
            <dt className="text-muted-foreground">Automatic</dt>
            <dd className="tabular-nums">{run.autoDecidedCount}</dd>
            <dt className="text-muted-foreground">LLM calls</dt>
            <dd className="tabular-nums">{run.llmCalls}</dd>
            {run.remainingCount > 0 && (
              <>
                <dt className="text-muted-foreground">Remaining</dt>
                <dd className="tabular-nums">{run.remainingCount}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-muted-foreground">No run yet. Run now to triage upstream commits.</p>
        )}
        {overview.lastRun?.status === "failed" && overview.lastRun.errorMessage && (
          <p className="text-destructive-foreground">
            Last run failed ({overview.lastRun.failureKind}): {overview.lastRun.errorMessage}
          </p>
        )}
        {overview.occurrence?.status === "failed" && (
          <p className="text-destructive-foreground">
            The scheduled run failed after {overview.occurrence.attempts} attempts: {overview.occurrence.lastError}
          </p>
        )}
        <p className="text-muted-foreground">
          {overview.nextRunAt
            ? `Next run ${new Date(overview.nextRunAt).toLocaleString()}`
            : "No schedule. Turn one on in the settings."}
        </p>
        {overview.untriagedUpstreamCount > 0 && (
          <p>
            {overview.untriagedUpstreamCount} newer upstream commit
            {overview.untriagedUpstreamCount === 1 ? " is" : "s are"} not triaged yet.
          </p>
        )}
        {!overview.ghAvailable && (
          <p className="text-xs text-muted-foreground">
            GitHub CLI is unavailable: runs skip PR descriptions and publishing waits for sign-in.
          </p>
        )}
        {overview.policyTruncated && (
          <p className="text-xs text-warning-foreground">
            upstream/policy.md is over 16 KiB; triage sees a truncated copy.
          </p>
        )}
        {overview.legacyRemaining > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span>{overview.legacyRemaining} commits from the earlier catch-up are untriaged.</span>
            <Button
              size="xs"
              variant="outline"
              disabled={disabledReason !== null}
              onClick={() => props.onRun("legacy", overview.triageModelAvailable ? "llm" : "rules-only")}
            >
              Triage legacy backlog ({overview.legacyRemaining})
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function RunButton(props: {
  readonly overview: UpstreamOverview;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onRun: (kind: UpstreamRunKind, triage: UpstreamRunTriage) => void;
}) {
  const { overview } = props;
  const disabledReason = runDisabledReason(props);
  const triage: UpstreamRunTriage = overview.triageModelAvailable ? "llm" : "rules-only";
  return (
    <div className="flex">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            size="sm"
            className="rounded-e-none"
            disabled={disabledReason !== null}
            onClick={() => props.onRun("upstream", triage)}
          >
            <PlayIcon />
            {overview.lastRun ? "Run again" : "Run now"}
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {disabledReason ??
            (triage === "llm"
              ? "Fetch upstream and triage new commits"
              : "No Claude instance is available, so triage runs on rules only")}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              className="rounded-s-none border-s border-s-primary-foreground/20 px-1.5"
              aria-label="More run options"
              disabled={disabledReason !== null}
            />
          }
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => props.onRun("upstream", "rules-only")}>Run with rules only</MenuItem>
          <MenuItem
            disabled={overview.triageFailedCount === 0 || !overview.triageModelAvailable}
            onClick={() => props.onRun("retriage", "llm")}
          >
            Re-triage failed topics ({overview.triageFailedCount})
          </MenuItem>
          <MenuItem disabled={overview.legacyRemaining === 0} onClick={() => props.onRun("legacy", triage)}>
            Triage legacy backlog
            {overview.legacyRemaining > 0 ? ` (${overview.legacyRemaining})` : ""}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function UpstreamHeader(props: {
  readonly projects: ReadonlyArray<UpstreamProjectSummary>;
  readonly projectId: ProjectId;
  readonly onProjectChange: (projectId: ProjectId) => void;
  readonly overview: UpstreamOverview;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly refreshing: boolean;
  readonly onRun: (kind: UpstreamRunKind, triage: UpstreamRunTriage) => void;
  readonly onRefresh: () => void;
  readonly onResolvePublication: (action: UpstreamResolvePublicationInput["action"]) => void;
}) {
  const { overview } = props;
  const repository = overview.config?.repository ?? "";
  const current = props.projects.find((project) => project.projectId === props.projectId);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-lg font-semibold">Upstream</h1>
      {props.projects.length > 1 && (
        <Select value={props.projectId} onValueChange={(value) => value && props.onProjectChange(value as ProjectId)}>
          <SelectTrigger size="sm" className="w-auto min-w-40" aria-label="Project">
            <SelectValue>{current?.title ?? props.projectId}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {props.projects.map((project) => (
              <SelectItem key={project.projectId} value={project.projectId}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {repository && (
        <a
          href={repositoryUrl(repository)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {shortRepository(repository)}
          <ExternalLinkIcon className="size-3" aria-hidden="true" />
        </a>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <UpstreamPortQueue projectId={props.projectId} overview={overview} readOnly={props.readOnly} />
        <RunStatusChip overview={overview} readOnly={props.readOnly} busy={props.busy} onRun={props.onRun} />
        <LedgerChip
          publication={overview.publication}
          busy={props.busy || props.readOnly}
          onResolve={props.onResolvePublication}
        />
        <RunButton overview={overview} readOnly={props.readOnly} busy={props.busy} onRun={props.onRun} />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          <RefreshCwIcon className={cn(props.refreshing && "animate-spin")} />
        </Button>
        <UpstreamSettingsPopover
          projectId={props.projectId}
          overview={overview}
          providers={props.providers}
          readOnly={props.readOnly}
        />
      </div>
    </div>
  );
}
