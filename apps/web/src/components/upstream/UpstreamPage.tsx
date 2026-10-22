import type {
  ProjectId,
  UpstreamDecision,
  UpstreamOverview,
  UpstreamPortLinkSummary,
  UpstreamResolvePublicationInput,
  UpstreamTopicList as UpstreamListId,
  UpstreamTopicRow,
} from "@t3tools/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { resolveShortcutCommand, useServerKeybindings } from "../../keybindings";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import {
  hasStaleTopicPages,
  invalidateUpstreamPorts,
  upstreamOverviewQueryOptions,
  upstreamProjectsQueryOptions,
  upstreamPortsQueryKeys,
  upstreamTopicsQueryOptions,
  type UpstreamTopicFilter,
} from "../../lib/upstreamPortsReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { PublicationBanner } from "./PublicationBanner";
import { DeclineDialog, modelOptions, SkipReasonDialog, StartPortDialog } from "./UpstreamDialogs";
import { UpstreamConfigEmptyState } from "./UpstreamConfigEmptyState";
import { UpstreamSettingsPopover } from "./UpstreamSettingsPopover";
import { UpstreamTopicDetail } from "./UpstreamTopicDetail";
import { UpstreamTopicList, type UpstreamTopicListHandle } from "./UpstreamTopicList";
import {
  focusAfterRemoval,
  isDialogTarget,
  isEditableTarget,
  moveFocus,
  preselectedSkipReason,
  reconcileFocus,
  UPSTREAM_LISTS,
  upstreamPrUrl,
} from "./upstreamPage.logic";

export interface UpstreamSearch {
  readonly project?: ProjectId;
  readonly list?: UpstreamListId;
  readonly topic?: string;
}

const EMPTY_ROWS: ReadonlyArray<UpstreamTopicRow> = [];

function describeRun(run: UpstreamOverview["lastRun"]): string | null {
  if (!run) return null;
  const parts = [
    `${run.kind === "legacy" ? "Legacy run" : "Run"} ${run.status}`,
    formatRelativeTimeLabel(run.finishedAt ?? run.startedAt),
    `${run.commitCount} commits`,
    `${run.inboxCount} to review`,
    `${run.autoDecidedCount} automatic`,
  ];
  if (run.remainingCount > 0) parts.push(`${run.remainingCount} remaining`);
  return parts.join(" · ");
}

export function UpstreamPage(props: {
  readonly search: UpstreamSearch;
  readonly onSearchChange: (search: UpstreamSearch) => void;
}) {
  const queryClient = useQueryClient();
  const keybindings = useServerKeybindings();
  const projectsQuery = useQuery(upstreamProjectsQueryOptions());
  const projects = projectsQuery.data?.projects ?? [];
  const projectId = props.search.project ?? projects[0]?.projectId ?? null;
  const list = props.search.list ?? "inbox";
  const [hasQuestion, setHasQuestion] = useState(false);
  const [automaticOnly, setAutomaticOnly] = useState(false);
  const filter: UpstreamTopicFilter = useMemo(
    () => ({
      ...(list === "inbox" && hasQuestion ? { hasQuestion: true } : {}),
      ...(list === "skipped" && automaticOnly ? { decidedBy: "llm" as const } : {}),
    }),
    [list, hasQuestion, automaticOnly],
  );

  const overviewQuery = useQuery({
    ...upstreamOverviewQueryOptions(projectId ?? ("" as ProjectId)),
    enabled: projectId !== null,
  });
  const overview = overviewQuery.data;
  const topicsQuery = useInfiniteQuery({
    ...upstreamTopicsQueryOptions(projectId ?? ("" as ProjectId), list, filter),
    enabled: projectId !== null && Boolean(overview?.config),
  });
  const serverConfig = useQuery(serverConfigQueryOptions());
  const providers = serverConfig.data?.providers ?? [];
  const projectSettings = useQuery({
    ...projectSettingsQueryOptions(projectId ?? ("" as ProjectId)),
    enabled: projectId !== null,
  });

  const rows = useMemo(() => {
    if (!topicsQuery.data) return EMPTY_ROWS;
    return topicsQuery.data.pages.flatMap((page) => page.topics);
  }, [topicsQuery.data]);
  const ids = useMemo(() => rows.map((row) => row.topic.id), [rows]);

  useEffect(() => {
    if (projectId && hasStaleTopicPages(topicsQuery.data))
      void queryClient.resetQueries({ queryKey: upstreamPortsQueryKeys.topics(projectId, list, filter) });
  }, [topicsQuery.data, projectId, list, filter, queryClient]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [skipDialog, setSkipDialog] = useState<{ ids: string[]; preselected: string | null; reason?: string } | null>(null);
  const [declineIds, setDeclineIds] = useState<string[] | null>(null);
  const [portIds, setPortIds] = useState<string[] | null>(null);
  const listRef = useRef<UpstreamTopicListHandle | null>(null);
  const lastIndex = useRef(0);

  const focused = props.search.topic ?? null;
  const { onSearchChange, search } = props;
  const setFocused = useCallback(
    (topic: string | null) => {
      const { topic: _previous, ...rest } = search;
      onSearchChange(topic ? { ...rest, topic } : rest);
    },
    [onSearchChange, search],
  );

  useEffect(() => {
    if (topicsQuery.isPending) return;
    const next = reconcileFocus(ids, focused, lastIndex.current);
    if (next !== focused && (next !== null || focused !== null)) setFocused(next);
    if (next) lastIndex.current = ids.indexOf(next);
  }, [ids, focused, setFocused, topicsQuery.isPending]);

  useEffect(() => setSelected(new Set()), [projectId, list]);

  const readOnly = overview ? !overview.writer.managedByThisProfile && overview.writer.claimed : false;
  const targets = useCallback(
    () => (selected.size > 0 ? ids.filter((id) => selected.has(id)) : focused ? [focused] : []),
    [selected, ids, focused],
  );

  const withBusy = async <T,>(title: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const applyDecision = async (topicIds: string[], decision: UpstreamDecision | "accept") => {
    if (!projectId || topicIds.length === 0) return;
    const order = ids;
    const result = await withBusy("Decision failed", () =>
      decision === "accept"
        ? ensureNativeApi().upstreamPorts.acceptSuggestions({ projectId, topicIds: topicIds as never })
        : ensureNativeApi().upstreamPorts.decide({ projectId, topicIds: topicIds as never, decision }),
    );
    if (!result) return;
    const moved = new Set(result.updated);
    setSelected(new Set());
    setFocused(focusAfterRemoval(order, moved, focused));
    if (result.unchanged.length > 0 && decision === "accept")
      toastManager.add({ type: "info", title: `${result.unchanged.length} topic(s) had no suggestion to accept` });
    await invalidateUpstreamPorts(queryClient);
    listRef.current?.focus();
  };

  const openSkip = (topicIds: string[], reason?: string) => {
    if (topicIds.length === 0) return;
    const first = rows.find((row) => row.topic.id === topicIds[0]);
    setSkipDialog({ ids: topicIds, preselected: first ? preselectedSkipReason(first.topic) : null, ...(reason ? { reason } : {}) });
  };

  const runNow = (kind: "upstream" | "legacy", triage: "llm" | "rules-only") => {
    if (!projectId) return;
    void withBusy("Could not start the run", async () => {
      await ensureNativeApi().upstreamPorts.run({ projectId, kind, triage });
      await invalidateUpstreamPorts(queryClient);
    });
  };

  const resolvePublication = (action: UpstreamResolvePublicationInput["action"]) => {
    if (!projectId) return;
    void withBusy("Publication action failed", async () => {
      await ensureNativeApi().upstreamPorts.resolvePublication({ projectId, action });
      await invalidateUpstreamPorts(queryClient);
    });
  };

  const copyPrompt = (topicIds: string[]) => {
    if (!projectId || topicIds.length === 0) return;
    void withBusy("Could not copy the port prompt", async () => {
      const { prompt } = await ensureNativeApi().upstreamPorts.getPortPrompt({ projectId, topicIds: topicIds as never });
      await writeTextToClipboard(prompt);
      toastManager.add({ type: "success", title: "Port prompt copied" });
    });
  };

  const unlink = (link: UpstreamPortLinkSummary) => {
    if (!projectId || !focused) return;
    void withBusy("Could not unlink", async () => {
      await ensureNativeApi().upstreamPorts.unlinkPort({ projectId, topicId: focused as never, threadId: link.threadId });
      await invalidateUpstreamPorts(queryClient);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const command = resolveShortcutCommand(event.nativeEvent, keybindings, {
      context: {
        upstreamListFocus: true,
        editableFocus: isEditableTarget(event.target),
        dialogFocus: isDialogTarget(event.target),
      },
    });
    if (!command?.startsWith("upstream.")) return;
    event.preventDefault();
    const focusedRow = rows.find((row) => row.topic.id === focused);
    const canDecide = !readOnly && !busy;
    switch (command) {
      case "upstream.next":
      case "upstream.previous": {
        const next = moveFocus(ids, focused, command === "upstream.next" ? 1 : -1);
        if (next) {
          lastIndex.current = ids.indexOf(next);
          setFocused(next);
        }
        if (command === "upstream.next" && topicsQuery.hasNextPage && ids.indexOf(next ?? "") > ids.length - 5)
          void topicsQuery.fetchNextPage();
        return;
      }
      case "upstream.toggleSelect":
        if (!focused) return;
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(focused)) next.delete(focused);
          else next.add(focused);
          return next;
        });
        return;
      case "upstream.selectAll":
        setSelected((current) => (current.size === ids.length ? new Set() : new Set(ids)));
        return;
      case "upstream.acceptSuggestion":
        if (canDecide) void applyDecision(targets(), "accept");
        return;
      case "upstream.port":
        if (canDecide) void applyDecision(targets(), { kind: "port" });
        return;
      case "upstream.skip":
        if (canDecide) openSkip(targets());
        return;
      case "upstream.watch":
        if (canDecide) void applyDecision(targets(), { kind: "watch" });
        return;
      case "upstream.decline":
        if (canDecide && targets().length) setDeclineIds(targets());
        return;
      case "upstream.reopen":
        if (canDecide) void applyDecision(targets(), { kind: "inbox" });
        return;
      case "upstream.openDetail":
        if (focused) document.getElementById("upstream-topic-detail")?.focus();
        return;
      case "upstream.openUpstreamPr": {
        const pr = focusedRow?.topic.upstreamPrs[0];
        if (pr && overview?.config) window.open(upstreamPrUrl(overview.config.repository, pr), "_blank", "noopener");
        return;
      }
      case "upstream.startPort": {
        const portable = targets().filter((id) => {
          const row = rows.find((entry) => entry.topic.id === id);
          return row?.state === "ready" || row?.state === "in-progress";
        });
        if (canDecide && portable.length) setPortIds(portable);
        return;
      }
    }
  };

  if (projectsQuery.isPending) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (projects.length === 0 || !projectId) return <UpstreamConfigEmptyState />;
  if (overview && !overview.config) return <UpstreamConfigEmptyState diagnostics={overview.diagnostics} />;

  const defaultRuntimeMode = projectSettings.data?.settings.defaultRuntimeMode ?? "full-access";
  const portModels = modelOptions(providers);
  const runSummary = describeRun(overview?.activeRun ?? overview?.lastRun ?? null);

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">Upstream</h1>
          {projects.length > 1 && (
            <select
              aria-label="Project"
              className="rounded border bg-background p-1.5 text-sm"
              value={projectId}
              onChange={(event) =>
                props.onSearchChange({ project: event.target.value as ProjectId, list: props.search.list ?? "inbox" })
              }
            >
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.title}
                </option>
              ))}
            </select>
          )}
          {overview?.config && <span className="text-xs text-muted-foreground">{overview.config.repository}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {runSummary && <span className="text-xs text-muted-foreground">{runSummary}</span>}
            <Button
              size="sm"
              disabled={busy || readOnly || overview?.activeRun != null || overview?.remoteStatus !== "ok"}
              onClick={() => runNow("upstream", overview?.triageModelAvailable ? "llm" : "rules-only")}
            >
              <PlayIcon className="size-4" />
              {overview?.lastRun ? "Run again" : "Run now"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || readOnly || overview?.activeRun != null || overview?.remoteStatus !== "ok"}
              onClick={() => runNow("upstream", "rules-only")}
            >
              Rules only
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Refresh"
              disabled={overviewQuery.isFetching}
              onClick={() => void invalidateUpstreamPorts(queryClient)}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
            {overview && (
              <UpstreamSettingsPopover projectId={projectId} overview={overview} providers={providers} readOnly={readOnly} />
            )}
          </div>
        </div>
        {overview && (
          <div className="space-y-2 text-sm">
            {overview.writer.claimed && !overview.writer.managedByThisProfile && (
              <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <span>
                  Managed by profile {overview.writer.profileId}
                  {overview.writer.hostname ? ` on ${overview.writer.hostname}` : ""}. This page is read-only here.
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void withBusy("Could not take over", async () => {
                      await ensureNativeApi().upstreamPorts.takeOverWriter({ projectId });
                      await invalidateUpstreamPorts(queryClient);
                    })
                  }
                >
                  Take over
                </Button>
                <span className="text-xs text-muted-foreground">
                  The other profile's unpublished changes will not be published.
                </span>
              </div>
            )}
            {overview.remoteStatus !== "ok" && overview.config && (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/8 px-3 py-2">
                {overview.remoteStatus === "missing" ? (
                  <>
                    <span>The {overview.config.remote} remote is missing.</span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void withBusy("Could not add the remote", async () => {
                          await ensureNativeApi().upstreamPorts.addRemote({ projectId });
                          await invalidateUpstreamPorts(queryClient);
                        })
                      }
                    >
                      Add upstream remote
                    </Button>
                  </>
                ) : (
                  <span>
                    The {overview.config.remote} remote points at {overview.remoteUrl}, but f5.json expects{" "}
                    {overview.config.repository}.
                  </span>
                )}
              </div>
            )}
            {overview.occurrence?.status === "failed" && (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2">
                The scheduled run failed after {overview.occurrence.attempts} attempts: {overview.occurrence.lastError}
              </div>
            )}
            {overview.lastRun?.status === "failed" && overview.lastRun.errorMessage && (
              <p className="text-xs text-destructive-foreground">
                Last run failed ({overview.lastRun.failureKind}): {overview.lastRun.errorMessage}
              </p>
            )}
            {overview.nextRunAt && (
              <p className="text-xs text-muted-foreground">Next run {new Date(overview.nextRunAt).toLocaleString()}</p>
            )}
            {overview.diagnostics.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-destructive-foreground">
                {overview.diagnostics.slice(0, 5).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            {overview.policyTruncated && (
              <p className="text-xs text-warning-foreground">upstream/policy.md is over 16 KiB; triage sees a truncated copy.</p>
            )}
            {!overview.ghAvailable && (
              <p className="text-xs text-muted-foreground">
                GitHub CLI is unavailable: runs skip PR descriptions and publishing waits for sign-in.
              </p>
            )}
            <PublicationBanner publication={overview.publication} busy={busy || readOnly} onResolve={resolvePublication} />
            {overview.legacyRemaining > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <span>{overview.legacyRemaining} commits from the earlier catch-up are still untriaged.</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || readOnly || overview.activeRun != null}
                  onClick={() => runNow("legacy", overview.triageModelAvailable ? "llm" : "rules-only")}
                >
                  Triage legacy backlog
                </Button>
              </div>
            )}
          </div>
        )}
        <nav aria-label="Topic lists" className="flex flex-wrap items-center gap-1">
          {UPSTREAM_LISTS.map((entry) => (
            <Button
              key={entry.id}
              size="xs"
              variant={entry.id === list ? "secondary" : "ghost"}
              aria-current={entry.id === list ? "page" : undefined}
              onClick={() => props.onSearchChange({ project: projectId, list: entry.id })}
            >
              {entry.label}
              <Badge variant="outline" size="sm" className="tabular-nums">
                {overview?.counts[entry.id] ?? 0}
              </Badge>
            </Button>
          ))}
          {list === "inbox" && (
            <label className="ml-2 flex items-center gap-1 text-xs">
              <input type="checkbox" checked={hasQuestion} onChange={(e) => setHasQuestion(e.target.checked)} />
              Has question
            </label>
          )}
          {list === "skipped" && (
            <label className="ml-2 flex items-center gap-1 text-xs">
              <input type="checkbox" checked={automaticOnly} onChange={(e) => setAutomaticOnly(e.target.checked)} />
              Automatic only
            </label>
          )}
          {selected.size > 0 && <span className="ml-auto text-xs text-muted-foreground">{selected.size} selected</span>}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 w-1/2 min-w-80 flex-col border-r">
          {topicsQuery.error ? (
            <p role="alert" className="p-4 text-sm text-destructive-foreground">
              {String(topicsQuery.error)}
            </p>
          ) : (
            <UpstreamTopicList
              ref={listRef}
              rows={rows}
              repository={overview?.config?.repository ?? ""}
              focusedId={focused}
              selected={selected}
              hasMore={Boolean(topicsQuery.hasNextPage)}
              loadingMore={topicsQuery.isFetchingNextPage}
              onLoadMore={() => void topicsQuery.fetchNextPage()}
              onFocusRow={(id) => {
                lastIndex.current = ids.indexOf(id);
                setFocused(id);
              }}
              onToggleRow={(id) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onOpenRow={(id) => {
                setFocused(id);
                document.getElementById("upstream-topic-detail")?.focus();
              }}
              onKeyDown={handleKeyDown}
            />
          )}
        </section>
        <section id="upstream-topic-detail" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          {focused && overview ? (
            <UpstreamTopicDetail
              projectId={projectId}
              topicId={focused}
              overview={overview}
              readOnly={readOnly}
              busy={busy}
              onDecide={(decision) => void applyDecision([focused], decision)}
              onSkip={(options) => openSkip([focused], options?.reason)}
              onDecline={() => setDeclineIds([focused])}
              onStartPort={() => setPortIds(selected.size > 0 ? targets() : [focused])}
              onCopyPrompt={() => copyPrompt(selected.size > 0 ? targets() : [focused])}
              onUnlink={unlink}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">Select a topic. Use j and k to move, ? for shortcuts.</p>
          )}
        </section>
      </div>
      {overview && (
        <>
          <SkipReasonDialog
            open={skipDialog !== null}
            count={skipDialog?.ids.length ?? 0}
            reasonKeys={overview.reasonKeys}
            reasonLabels={overview.reasonLabels}
            upstreamOnlySubsystems={overview.upstreamOnlySubsystems}
            preselected={skipDialog?.preselected ?? null}
            {...(skipDialog?.reason ? { defaultReason: skipDialog.reason } : {})}
            onClose={() => {
              setSkipDialog(null);
              listRef.current?.focus();
            }}
            onConfirm={(input) => {
              const topicIds = skipDialog?.ids ?? [];
              setSkipDialog(null);
              void applyDecision(topicIds, { kind: "skip", ...input });
            }}
          />
          <DeclineDialog
            open={declineIds !== null}
            count={declineIds?.length ?? 0}
            onClose={() => {
              setDeclineIds(null);
              listRef.current?.focus();
            }}
            onConfirm={(reason) => {
              const topicIds = declineIds ?? [];
              setDeclineIds(null);
              void applyDecision(topicIds, { kind: "declined", reason });
            }}
          />
          <StartPortDialog
            open={portIds !== null}
            topicIds={portIds ?? []}
            models={portModels}
            defaultModel={projectSettings.data?.settings.upstreamPorts?.portModelSelection ?? null}
            defaultRuntimeMode={defaultRuntimeMode}
            overview={overview}
            busy={busy}
            onClose={() => setPortIds(null)}
            onRunFirst={() => {
              setPortIds(null);
              runNow("upstream", overview.triageModelAvailable ? "llm" : "rules-only");
            }}
            onStart={(input) => {
              const topicIds = portIds ?? [];
              void withBusy("Could not start the port", async () => {
                const result = await ensureNativeApi().upstreamPorts.startPort({
                  projectId,
                  topicIds: topicIds as never,
                  ...input,
                });
                setPortIds(null);
                const rejected = result.groups.filter((group) => group.status === "rejected");
                const pending = result.groups.filter((group) => group.status === "pending");
                toastManager.add({
                  type: rejected.length ? "warning" : "success",
                  title: `Started ${result.groups.length - rejected.length} port thread(s)`,
                  ...(rejected.length || pending.length
                    ? {
                        description: [
                          ...rejected.map((group) => `Rejected: ${group.reason ?? group.topicIds.join(", ")}`),
                          ...(pending.length ? [`${pending.length} will be retried automatically.`] : []),
                        ].join("\n"),
                      }
                    : {}),
                });
                await invalidateUpstreamPorts(queryClient);
              });
            }}
          />
        </>
      )}
    </main>
  );
}
