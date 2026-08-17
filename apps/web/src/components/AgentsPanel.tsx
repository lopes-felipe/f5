import type { BackgroundWorkStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, RefreshCwIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentsPanelEntry, AgentsPanelModel } from "../lib/agentsModel";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

const STATUS_PRESENTATION: Record<
  BackgroundWorkStatus,
  { readonly label: string; readonly dotClassName: string }
> = {
  running: { label: "Working", dotClassName: "bg-sky-500" },
  monitoring: { label: "Monitoring", dotClassName: "bg-sky-500" },
  idle: { label: "Idle", dotClassName: "bg-muted-foreground/50" },
  completed: { label: "Completed", dotClassName: "bg-emerald-500" },
  failed: { label: "Failed", dotClassName: "bg-destructive" },
  stopped: { label: "Stopped", dotClassName: "bg-muted-foreground/50" },
  interrupted: { label: "Interrupted", dotClassName: "bg-amber-500" },
};

function elapsedLabel(startedAt: string, completedAt: string | null, now: number): string | null {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function useAgentsClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return now;
}

function AgentRow(props: {
  readonly entry: AgentsPanelEntry;
  readonly now: number;
  readonly onNavigate: (entry: AgentsPanelEntry) => void;
}) {
  const presentation = STATUS_PRESENTATION[props.entry.status];
  const elapsed = elapsedLabel(props.entry.startedAt, props.entry.completedAt, props.now);
  const source = props.entry.projectName
    ? `${props.entry.projectName} · ${props.entry.threadTitle}`
    : props.entry.threadTitle;

  return (
    <button
      type="button"
      className="group flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
      onClick={() => props.onNavigate(props.entry)}
      aria-label={`Open ${props.entry.title} in ${props.entry.threadTitle}`}
    >
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", presentation.dotClassName)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{props.entry.title}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {elapsed}
          </span>
        </span>
        {props.entry.detail ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {props.entry.detail}
            {props.entry.outputTruncated ? " …" : ""}
          </span>
        ) : null}
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/80">
          <span className="shrink-0">{presentation.label}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{source}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 font-mono">{props.entry.provider}</span>
          {props.entry.model ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="max-w-28 truncate font-mono">{props.entry.model}</span>
            </>
          ) : null}
          {props.entry.phase ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="max-w-28 truncate">{props.entry.phase}</span>
            </>
          ) : null}
        </span>
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="mt-1 size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-foreground"
      />
    </button>
  );
}

function AgentSection(props: {
  readonly title: string;
  readonly icon: typeof BotIcon;
  readonly entries: ReadonlyArray<AgentsPanelEntry>;
  readonly now: number;
  readonly onNavigate: (entry: AgentsPanelEntry) => void;
}) {
  if (props.entries.length === 0) return null;
  const Icon = props.icon;
  return (
    <section aria-label={props.title}>
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
        <Icon aria-hidden="true" className="size-3" />
        {props.title}
        <span className="ml-auto font-mono tracking-normal">{props.entries.length}</span>
      </div>
      {props.entries.map((entry) => (
        <AgentRow key={entry.id} entry={entry} now={props.now} onNavigate={props.onNavigate} />
      ))}
    </section>
  );
}

export interface AgentsPanelViewProps {
  readonly model: AgentsPanelModel;
  readonly loading: boolean;
  readonly error: boolean;
  readonly fetching: boolean;
  readonly now: number;
  readonly onRetry: () => void;
  readonly onNavigate: (entry: AgentsPanelEntry) => void;
}

export function AgentsPanelView(props: AgentsPanelViewProps) {
  if (props.loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading agent activity…
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <BotIcon aria-hidden="true" className="size-6 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Agent activity is unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The durable background-work snapshot could not be loaded.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (props.model.directEntries.length === 0 && props.model.workflowEntries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BotIcon aria-hidden="true" className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agent work yet</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          Subagents and workflow work appear here with durable status, even after a server restart.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5">
          <AgentSection
            title="Workflow work"
            icon={WorkflowIcon}
            entries={props.model.workflowEntries}
            now={props.now}
            onNavigate={props.onNavigate}
          />
          <AgentSection
            title="Direct subagents"
            icon={BotIcon}
            entries={props.model.directEntries}
            now={props.now}
            onNavigate={props.onNavigate}
          />
        </div>
      </ScrollArea>
      <footer className="border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <span>
            {props.model.liveCount > 0 ? `${props.model.liveCount} working` : "No active agents"}
            {props.model.settledCount > 0 ? ` · ${props.model.settledCount} settled` : ""}
          </span>
          {props.fetching ? <span>Refreshing…</span> : null}
        </div>
        {props.model.coverageWindowLimited ? (
          <p className="mt-1 leading-relaxed">
            Durable status is complete; activity detail reflects the loaded history window.
          </p>
        ) : null}
      </footer>
    </div>
  );
}

export function AgentsPanel(props: {
  readonly model: AgentsPanelModel;
  readonly loading: boolean;
  readonly error: boolean;
  readonly fetching: boolean;
  readonly onRetry: () => void;
}) {
  const navigate = useNavigate();
  const now = useAgentsClock(props.model.liveCount > 0);

  const navigateToSource = (entry: AgentsPanelEntry) => {
    useRightPanelStore.getState().open(entry.threadId, "agents");
    void navigate({
      to: "/$threadId",
      params: { threadId: entry.threadId },
      search: (previous) => ({
        ...previous,
        timelineEntryId: entry.focusActivityId ?? undefined,
        timelineEntryKind: entry.focusActivityId ? "activity" : undefined,
      }),
    });
  };

  return (
    <AgentsPanelView
      model={props.model}
      loading={props.loading}
      error={props.error}
      fetching={props.fetching}
      now={now}
      onRetry={props.onRetry}
      onNavigate={navigateToSource}
    />
  );
}
