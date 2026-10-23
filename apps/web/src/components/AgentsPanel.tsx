import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { deriveProviderInstanceEntries } from "../providerInstances";
import type { ProviderSessionCapabilities, ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EyeOffIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useAgentsPanelStore, type AgentsPanelScope } from "../agentsPanelStore";
import {
  buildAgentsPanelModel,
  resolveAgentProviderName,
  countAgentsByStatus,
  filterAgentsPanelEntries,
  type AgentsPanelEntry,
  type AgentsPanelModel,
  type AgentsStatusFilter,
} from "../lib/agentsModel";
import { agentsSnapshotQueryOptions, dismissAgentWork } from "../lib/agentsReactQuery";
import {
  canInspectNativeTask,
  canStopNativeTask,
  inspectNativeTask,
  isNativeTaskStopBlocked,
  nativeTaskStopKey,
  stopNativeTasks,
  useNativeTaskStopStore,
  type NativeTaskInspection,
  type NativeTaskTarget,
} from "../lib/nativeTaskActions";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { AgentRow, type AgentRowActions } from "./AgentsPanelRow";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const STATUS_FILTERS: ReadonlyArray<{
  readonly value: AgentsStatusFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
  { value: "done", label: "Done" },
];

function useAgentsClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return now;
}

export interface AgentsPanelLiveCounts {
  readonly thread: number;
  readonly all: number;
}

export interface AgentsPanelViewProps {
  /** Unfiltered model for the selected scope. */
  readonly model: AgentsPanelModel;
  readonly providerName?: (entry: AgentsPanelEntry) => string | undefined;
  readonly scope: AgentsPanelScope;
  readonly liveCounts: AgentsPanelLiveCounts;
  readonly loading: boolean;
  readonly error: boolean;
  readonly fetching: boolean;
  readonly now: number;
  readonly query: string;
  readonly statusFilter: AgentsStatusFilter;
  readonly backgroundTasksExpanded: boolean;
  readonly stoppingIds: ReadonlySet<string>;
  readonly canStop: (entry: AgentsPanelEntry) => boolean;
  readonly canInspect: (entry: AgentsPanelEntry) => boolean;
  readonly onScopeChange: (scope: AgentsPanelScope) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onStatusFilterChange: (filter: AgentsStatusFilter) => void;
  readonly onBackgroundTasksExpandedChange: (expanded: boolean) => void;
  readonly onRetry: () => void;
  readonly onNavigate: (entry: AgentsPanelEntry) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStop: (entry: AgentsPanelEntry) => void;
  readonly onStopAll: (entries: ReadonlyArray<AgentsPanelEntry>) => void;
  readonly onDismiss: (entry: AgentsPanelEntry) => void;
  readonly onClearFinished: () => void;
  /** Loads a prompt the snapshot left out (global snapshots carry none). */
  readonly onLoadPrompt: (entry: AgentsPanelEntry) => Promise<string | null>;
  readonly onInspect: (
    entry: AgentsPanelEntry,
    cursor?: string,
  ) => Promise<NativeTaskInspection | null>;
}

function AgentsPanelToolbar(props: {
  readonly view: AgentsPanelViewProps;
  readonly counts: Readonly<Record<AgentsStatusFilter, number>>;
  readonly stoppable: ReadonlyArray<AgentsPanelEntry>;
  readonly onRequestStopAll: () => void;
  readonly onRequestClearFinished: () => void;
}) {
  const { view } = props;
  const finishedCount = view.model.settledCount;
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 px-2 pt-2 pb-2">
      <div className="flex items-center gap-2">
        <ToggleGroup
          variant="outline"
          size="xs"
          aria-label="Agent scope"
          value={[view.scope]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "thread" || next === "all") view.onScopeChange(next);
          }}
        >
          <ToggleGroupItem value="thread" aria-label="This thread">
            This thread
            <span className="font-mono text-muted-foreground tabular-nums">
              {view.liveCounts.thread}
            </span>
          </ToggleGroupItem>
          <ToggleGroupItem value="all" aria-label="All threads">
            All threads
            <span className="font-mono text-muted-foreground tabular-nums">
              {view.liveCounts.all}
            </span>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-1">
          {view.fetching ? (
            <RefreshCwIcon
              aria-label="Refreshing"
              className="size-3.5 animate-spin text-muted-foreground"
            />
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Agent actions" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-44">
              <MenuItem
                disabled={props.stoppable.length === 0}
                onClick={props.stoppable.length > 0 ? props.onRequestStopAll : undefined}
              >
                <SquareIcon />
                Stop all running
              </MenuItem>
              <MenuItem
                disabled={finishedCount === 0}
                onClick={finishedCount > 0 ? props.onRequestClearFinished : undefined}
              >
                <EyeOffIcon />
                Clear finished
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="relative">
        <Input
          size="sm"
          type="search"
          aria-label="Search agents"
          placeholder="Search agents, prompts, output…"
          className="[&_input]:pr-7 [&_input]:pl-7"
          value={view.query}
          onChange={(event) => view.onQueryChange(event.currentTarget.value)}
        />
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        {view.query ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Clear search"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => view.onQueryChange("")}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <div role="radiogroup" aria-label="Status filter" className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((filter) => {
          const selected = view.statusFilter === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
                selected
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onClick={() => view.onStatusFilterChange(filter.value)}
            >
              {filter.label}
              <span className="font-mono text-2xs tabular-nums">{props.counts[filter.value]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionHeader(props: {
  readonly title: string;
  readonly icon: typeof BotIcon;
  readonly count: number;
  readonly liveCount: number;
  readonly collapsible?: { readonly expanded: boolean; readonly onToggle: () => void };
}) {
  const Icon = props.icon;
  const content = (
    <>
      {props.collapsible ? (
        props.collapsible.expanded ? (
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-3" />
        )
      ) : null}
      <Icon aria-hidden="true" className="size-3" />
      {props.title}
      {props.liveCount > 0 ? (
        <span className="rounded-full bg-info/15 px-1.5 font-mono tracking-normal text-info-foreground normal-case">
          {props.liveCount} running
        </span>
      ) : null}
      <span className="ml-auto font-mono tracking-normal">{props.count}</span>
    </>
  );
  const className =
    "flex w-full items-center gap-1.5 px-2 pt-2 pb-1 text-2xs font-medium tracking-wider text-muted-foreground uppercase";
  return props.collapsible ? (
    <button
      type="button"
      className={cn(className, "rounded-md hover:text-foreground")}
      aria-expanded={props.collapsible.expanded}
      onClick={props.collapsible.onToggle}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function EntryList(props: {
  readonly entries: ReadonlyArray<AgentsPanelEntry>;
  readonly expandedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly showThread: boolean;
  readonly view: AgentsPanelViewProps;
}) {
  const { view } = props;
  return (
    <div className="flex flex-col">
      {props.entries.map((entry) => {
        const actions: AgentRowActions = {
          canStop: view.canStop(entry),
          canInspect: view.canInspect(entry),
          stopping: view.stoppingIds.has(entry.id),
          onStop: () => view.onStop(entry),
          onDismiss: () => view.onDismiss(entry),
          onNavigate: () => view.onNavigate(entry),
          onOpenThread: () => view.onOpenThread(entry.threadId),
          onInspect: (cursor) => view.onInspect(entry, cursor),
          onLoadPrompt: () => view.onLoadPrompt(entry),
        };
        return (
          <AgentRow
            key={entry.id}
            entry={entry}
            providerName={view.providerName?.(entry)}
            now={view.now}
            expanded={props.expandedId === entry.id}
            showThread={props.showThread}
            onToggle={() => props.onToggle(entry.id)}
            actions={actions}
          />
        );
      })}
    </div>
  );
}

function AgentSections(props: {
  readonly agents: ReadonlyArray<AgentsPanelEntry>;
  readonly backgroundTasks: ReadonlyArray<AgentsPanelEntry>;
  readonly expandedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly showThread: boolean;
  readonly forceExpandBackground: boolean;
  readonly view: AgentsPanelViewProps;
}) {
  const { view } = props;
  const backgroundExpanded = view.backgroundTasksExpanded || props.forceExpandBackground;
  return (
    <>
      {props.agents.length > 0 ? (
        <section aria-label="Agents">
          <SectionHeader
            title="Agents"
            icon={BotIcon}
            count={props.agents.length}
            liveCount={props.agents.filter((entry) => entry.live).length}
          />
          <EntryList
            entries={props.agents}
            expandedId={props.expandedId}
            onToggle={props.onToggle}
            showThread={props.showThread}
            view={view}
          />
        </section>
      ) : null}
      {props.backgroundTasks.length > 0 ? (
        <section aria-label="Background tasks">
          <SectionHeader
            title="Background tasks"
            icon={TerminalIcon}
            count={props.backgroundTasks.length}
            liveCount={props.backgroundTasks.filter((entry) => entry.live).length}
            collapsible={{
              expanded: backgroundExpanded,
              onToggle: () => view.onBackgroundTasksExpandedChange(!backgroundExpanded),
            }}
          />
          {backgroundExpanded ? (
            <EntryList
              entries={props.backgroundTasks}
              expandedId={props.expandedId}
              onToggle={props.onToggle}
              showThread={props.showThread}
              view={view}
            />
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function ThreadGroup(props: {
  readonly group: AgentsPanelModel["threads"][number];
  readonly children: ReactNode;
  readonly onOpenThread: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const label = props.group.projectName
    ? `${props.group.projectName} · ${props.group.threadTitle}`
    : props.group.threadTitle;
  return (
    <section aria-label={label} className="rounded-lg border border-border/60">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </Button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
          onClick={props.onOpenThread}
        >
          {label}
        </button>
        {props.group.liveCount > 0 ? (
          <span className="shrink-0 rounded-full bg-info/15 px-1.5 font-mono text-2xs text-info-foreground">
            {props.group.liveCount} running
          </span>
        ) : null}
      </div>
      {collapsed ? null : <div className="pb-1">{props.children}</div>}
    </section>
  );
}

function EmptyState(props: {
  readonly scope: AgentsPanelScope;
  readonly filtered: boolean;
  readonly onShowAll: () => void;
  readonly onResetFilters: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
      <BotIcon aria-hidden="true" className="size-6 text-muted-foreground" />
      {props.filtered ? (
        <>
          <p className="text-sm font-medium">No agents match these filters</p>
          <Button size="xs" variant="outline" onClick={props.onResetFilters}>
            Reset filters
          </Button>
        </>
      ) : props.scope === "thread" ? (
        <>
          <p className="text-sm font-medium">No agents in this thread yet</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            Subagents, workflow work and background shells started here appear in this panel.
          </p>
          <Button size="xs" variant="outline" onClick={props.onShowAll}>
            Show all threads
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">No agent work yet</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            Subagents and workflow work from every thread appear here, even after a restart.
          </p>
        </>
      )}
    </div>
  );
}

export function AgentsPanelView(props: AgentsPanelViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  // Clearing across every thread also hides entries beyond the ones listed, and
  // nothing brings them back, so it asks first.
  const requestClearFinished = () =>
    props.scope === "all" ? setConfirmClearAll(true) : props.onClearFinished();

  const allEntries = useMemo(
    () => [...props.model.agents, ...props.model.backgroundTasks],
    [props.model.agents, props.model.backgroundTasks],
  );
  const searched = useMemo(
    () => filterAgentsPanelEntries(allEntries, { query: props.query, status: "all" }),
    [allEntries, props.query],
  );
  const counts = useMemo(() => countAgentsByStatus(searched), [searched]);
  const filteredModel = useMemo(
    () =>
      buildAgentsPanelModel(
        filterAgentsPanelEntries(searched, { query: "", status: props.statusFilter }),
        props.model.generatedAt,
      ),
    [props.model.generatedAt, props.statusFilter, searched],
  );
  const stoppable = useMemo(
    () => allEntries.filter((entry) => entry.live && props.canStop(entry)),
    [allEntries, props.canStop],
  );
  const filtered = props.query.trim().length > 0 || props.statusFilter !== "all";
  // A search or filter that only matches shells must not hide its results behind a collapsed group.
  const forceExpandBackground = filtered && filteredModel.agents.length === 0;
  const toggle = (id: string) => setExpandedId((current) => (current === id ? null : id));

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
            Background work status could not be loaded.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  const isEmpty = filteredModel.agents.length === 0 && filteredModel.backgroundTasks.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentsPanelToolbar
        view={props}
        counts={counts}
        stoppable={stoppable}
        onRequestStopAll={() => setConfirmStopAll(true)}
        onRequestClearFinished={requestClearFinished}
      />
      <ScrollArea className="min-h-0 flex-1">
        {isEmpty ? (
          <EmptyState
            scope={props.scope}
            filtered={filtered && allEntries.length > 0}
            onShowAll={() => props.onScopeChange("all")}
            onResetFilters={() => {
              props.onQueryChange("");
              props.onStatusFilterChange("all");
            }}
          />
        ) : props.scope === "all" ? (
          <div className="flex flex-col gap-2 p-1.5">
            {filteredModel.threads.map((group) => (
              <ThreadGroup
                key={group.threadId}
                group={group}
                onOpenThread={() => props.onOpenThread(group.threadId)}
              >
                <AgentSections
                  agents={group.agents}
                  backgroundTasks={group.backgroundTasks}
                  expandedId={expandedId}
                  onToggle={toggle}
                  showThread={false}
                  forceExpandBackground={forceExpandBackground}
                  view={props}
                />
              </ThreadGroup>
            ))}
          </div>
        ) : (
          <div className="p-1.5">
            <AgentSections
              agents={filteredModel.agents}
              backgroundTasks={filteredModel.backgroundTasks}
              expandedId={expandedId}
              onToggle={toggle}
              showThread={false}
              forceExpandBackground={forceExpandBackground}
              view={props}
            />
          </div>
        )}
      </ScrollArea>
      <footer className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">
        <span>
          {props.model.liveCount > 0 ? `${props.model.liveCount} running` : "Nothing running"}
          {` · ${props.model.settledCount} finished`}
        </span>
        {props.model.settledCount > 0 ? (
          <button
            type="button"
            className="ml-auto underline-offset-2 hover:text-foreground hover:underline"
            onClick={requestClearFinished}
          >
            Clear finished
          </button>
        ) : null}
      </footer>
      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogPopup className="sm:max-w-[420px]">
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle>Clear finished work in every thread?</AlertDialogTitle>
            <AlertDialogDescription>
              Finished agents and background tasks in all threads are hidden from this panel,
              including any not listed here. This can't be undone. Running work is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setConfirmClearAll(false);
                props.onClearFinished();
              }}
            >
              Clear finished
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmStopAll} onOpenChange={setConfirmStopAll}>
        <AlertDialogPopup className="sm:max-w-[420px]">
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle>
              Stop {stoppable.length} running {stoppable.length === 1 ? "task" : "tasks"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {props.scope === "thread"
                ? "Every running agent and background task in this thread will be asked to stop."
                : "Every running agent and background task across all threads will be asked to stop."}{" "}
              Work already done is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmStopAll(false);
                props.onStopAll(stoppable);
              }}
            >
              Stop all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

const EMPTY_STOPPING_IDS: ReadonlySet<string> = new Set();

export function AgentsPanel(props: {
  readonly threadId: ThreadId;
  readonly model: AgentsPanelModel;
  readonly liveCounts: AgentsPanelLiveCounts;
  readonly loading: boolean;
  readonly error: boolean;
  readonly fetching: boolean;
  readonly onRetry: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const providers = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.providers,
  }).data;
  const providerName = useMemo(() => {
    const instances = new Map(
      deriveProviderInstanceEntries(providers ?? []).map((instance) => [
        instance.instanceId,
        instance,
      ]),
    );
    return (entry: AgentsPanelEntry) => resolveAgentProviderName(entry, instances);
  }, [providers]);
  const now = useAgentsClock(props.model.liveCount > 0);
  const scope = useAgentsPanelStore((state) => state.scope);
  const statusFilter = useAgentsPanelStore((state) => state.statusFilter);
  const backgroundTasksExpanded = useAgentsPanelStore((state) => state.backgroundTasksExpanded);
  const setScope = useAgentsPanelStore((state) => state.setScope);
  const setStatusFilter = useAgentsPanelStore((state) => state.setStatusFilter);
  const setBackgroundTasksExpanded = useAgentsPanelStore(
    (state) => state.setBackgroundTasksExpanded,
  );
  const [query, setQuery] = useState("");
  const pendingStops = useNativeTaskStopStore((state) => state.pending);
  const stoppingIds = useMemo(() => {
    if (pendingStops.size === 0) return EMPTY_STOPPING_IDS;
    const ids = new Set<string>();
    for (const entry of [...props.model.agents, ...props.model.backgroundTasks]) {
      if (pendingStops.has(nativeTaskStopKey(entry.threadId, entry.nativeWorkItemId))) {
        ids.add(entry.id);
      }
    }
    return ids;
  }, [pendingStops, props.model]);
  // Shallow-compared map: streaming deltas keep each session's capabilities
  // reference, so the panel does not re-render for every token.
  const capabilitiesByThreadId = useStore(
    useShallow((state) => {
      const map = new Map<ThreadId, ProviderSessionCapabilities>();
      for (const thread of state.threads) {
        if (thread.session?.capabilities) map.set(thread.id, thread.session.capabilities);
      }
      return map;
    }),
  );

  const targetFor = (entry: AgentsPanelEntry): NativeTaskTarget | null => {
    const capabilities = capabilitiesByThreadId.get(entry.threadId);
    return capabilities
      ? { threadId: entry.threadId, capabilities, workItemId: entry.nativeWorkItemId }
      : null;
  };

  // Stops run outside the component, so they finish and report even if the
  // panel closes first.
  const stop = (entries: ReadonlyArray<AgentsPanelEntry>) =>
    void stopNativeTasks(
      entries.flatMap((entry) => {
        const target = targetFor(entry);
        return target ? [target] : [];
      }),
    );

  const dismiss = async (input: Parameters<typeof dismissAgentWork>[1]) => {
    try {
      return await dismissAgentWork(queryClient, input);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not clear agent work",
        description: cause instanceof Error ? cause.message : "The request failed.",
      });
      return null;
    }
  };

  const navigateToThread = (threadId: ThreadId, focusActivityId: string | null) => {
    useRightPanelStore.getState().open(threadId, "agents");
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => ({
        ...previous,
        timelineEntryId: focusActivityId ?? undefined,
        timelineEntryKind: focusActivityId ? "activity" : undefined,
      }),
    });
  };

  return (
    <AgentsPanelView
      model={props.model}
      providerName={providerName}
      scope={scope}
      liveCounts={props.liveCounts}
      loading={props.loading}
      error={props.error}
      fetching={props.fetching}
      now={now}
      query={query}
      statusFilter={statusFilter}
      backgroundTasksExpanded={backgroundTasksExpanded}
      stoppingIds={stoppingIds}
      canStop={(entry) =>
        entry.live &&
        canStopNativeTask(capabilitiesByThreadId.get(entry.threadId)) &&
        !isNativeTaskStopBlocked(pendingStops, entry.threadId, entry.nativeWorkItemId)
      }
      canInspect={(entry) => canInspectNativeTask(capabilitiesByThreadId.get(entry.threadId))}
      onScopeChange={setScope}
      onQueryChange={setQuery}
      onStatusFilterChange={setStatusFilter}
      onBackgroundTasksExpandedChange={setBackgroundTasksExpanded}
      onRetry={props.onRetry}
      onNavigate={(entry) => navigateToThread(entry.threadId, entry.focusActivityId)}
      onOpenThread={(threadId) => navigateToThread(threadId, null)}
      onStop={(entry) => stop([entry])}
      onStopAll={stop}
      onDismiss={(entry) =>
        void dismiss({ threadId: entry.threadId, workItemIds: [...entry.workItemIds] })
      }
      onClearFinished={() => {
        void dismiss(scope === "thread" ? { threadId: props.threadId } : {}).then((result) => {
          if (result && result.dismissedCount > 0) {
            toastManager.add({
              type: "success",
              title: `Cleared ${result.dismissedCount} finished ${
                result.dismissedCount === 1 ? "entry" : "entries"
              }`,
            });
          }
        });
      }}
      onInspect={(entry, cursor) => {
        const target = targetFor(entry);
        return target ? inspectNativeTask(target, cursor) : Promise.resolve(null);
      }}
      onLoadPrompt={async (entry) => {
        // Global snapshots leave prompts out; the thread snapshot carries them.
        try {
          const snapshot = await queryClient.fetchQuery(agentsSnapshotQueryOptions(entry.threadId));
          return (
            snapshot.entries.find(
              (row) => row.prompt !== null && entry.workItemIds.includes(row.workItemId),
            )?.prompt ?? null
          );
        } catch {
          return null;
        }
      }}
    />
  );
}
