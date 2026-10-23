import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";
import type {
  NativeOperationCommand,
  NativeHistoryRecovery,
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ProviderSessionCapabilities,
  ThreadBackgroundWorkEntry,
  ThreadId,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  LightbulbIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { readNativeApi } from "../../nativeApi";
import {
  selectSurfaceHeaderState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COMPOSER_TRAY_PANEL_CLASS_NAME } from "./composer/ComposerTray";
import { StatusChip, useComposerStatusStripHost } from "./composer/ComposerStatusStrip";
import {
  describeBackgroundTask,
  describeBackgroundWorkChip,
  formatByteSize,
  isNativeOperationInFlight,
  nativeOperationLabel,
  readShellOutputPage,
  selectNativeRuntimeTrayRows,
  selectNewlyFailedOperations,
  utf8ByteLength,
  type BackgroundTaskDescription,
  type BackgroundTaskKind,
} from "./NativeRuntimeTray.logic";

const ROW_CLASS_NAME = `${COMPOSER_TRAY_PANEL_CLASS_NAME} flex items-center gap-2 text-xs`;

const TASK_KIND_ICONS: Record<BackgroundTaskKind, LucideIcon> = {
  shell: TerminalIcon,
  monitor: EyeIcon,
  agent: BotIcon,
  workflow: WorkflowIcon,
};

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const showError = (title: string, description: string) =>
  toastManager.add({ type: "error", title, description });

/** The Claude adapter waits up to 30s for a stop to settle. */
const STOP_SETTLEMENT_TIMEOUT_MS = 35_000;
const STOP_SETTLEMENT_POLL_MS = 250;

interface TaskInspection {
  readonly nativeId: string;
  readonly task: BackgroundTaskDescription;
  readonly page: unknown;
  readonly nextCursor: string | null;
}

/**
 * Native runtime rows in the composer tray: a prompt suggestion, operations
 * whose outcome needs recovery or is still running, and stoppable child
 * tasks. Renders nothing when none of those exist.
 */
interface NativeRuntimeTrayProps {
  threadId: ThreadId;
  capabilities: ProviderSessionCapabilities | null | undefined;
  activities: readonly OrchestrationThreadActivity[];
  prompt: string;
  latestMessageAt?: string | undefined;
  onSuggestion: (text: string) => void;
  onViewAgents?: (() => void) | undefined;
  /**
   * `chip` moves background tasks out of the tray into a status-strip chip
   * (portalled into the strip's slot); without a mounted strip they stay rows.
   */
  backgroundTasksPresentation?: "row" | "chip" | undefined;
}

export function NativeRuntimeTray(props: NativeRuntimeTrayProps) {
  // Per-thread state (records, open dialogs) must never leak into another thread.
  return <NativeRuntimeTrayContent key={props.threadId} {...props} />;
}

function NativeRuntimeTrayContent(props: NativeRuntimeTrayProps) {
  const { threadId, capabilities, activities, prompt } = props;
  const [records, setRecords] = useState<readonly NativeOperationRecord[]>([]);
  const [tasks, setTasks] = useState<readonly ThreadBackgroundWorkEntry[]>([]);
  const [historyRecovery, setHistoryRecovery] = useState<NativeHistoryRecovery | null>(null);
  const [reviewingHistory, setReviewingHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const mounted = useRef(true);
  const [usedSuggestionId, setUsedSuggestionId] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<NativeOperationRecord | null>(null);
  const [inspection, setInspection] = useState<TaskInspection | null>(null);
  const [reading, setReading] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [tasksChipOpen, setTasksChipOpen] = useState(false);
  const statusStripHost = useComposerStatusStripHost();
  const tasksAsChip = props.backgroundTasksPresentation === "chip" && statusStripHost !== null;
  // Elapsed times advance with the poll rather than a separate timer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [mountedAt] = useState(() => new Date().toISOString());
  const mutationVersion = useRef(0);
  const reportedFailures = useRef(new Set<string>());
  const previousRecords = useRef(records);
  const supported = (action: string) =>
    capabilities?.actions.some((entry) => entry.action === action && entry.supported) === true;
  const canInspectTasks = supported("childTaskInspection");
  const canStopTasks = supported("childTaskStop");
  // Hidden once the Agents surface is on screen; the link would point at nothing.
  const agentsOpen = useRightPanelStore(
    (store) =>
      selectSurfaceHeaderState(
        selectThreadRightPanelState(store.byThreadId, threadId),
        "agents",
      ) === "active",
  );
  const viewAgents =
    props.onViewAgents && !agentsOpen ? (
      <Button size="xs" variant="ghost" aria-label="View agents" onClick={props.onViewAgents}>
        View
      </Button>
    ) : null;
  // The server holds one native-operation reservation per thread until a stop
  // settles, so a second stop sent earlier is refused.
  const stopBlocked =
    busy ||
    stopping ||
    records.some(
      (record) => record.command.kind === "stopTask" && isNativeOperationInFlight(record),
    );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const rows = selectNativeRuntimeTrayRows({
    activities,
    prompt,
    latestMessageAt: props.latestMessageAt,
    usedSuggestionId,
    records,
    tasks,
    canInspectTasks,
    canStopTasks,
  });
  const shownSuggestionId = rows.find((row) => row.kind === "suggestion")?.id ?? null;
  const shownTaskCount = rows.find((row) => row.kind === "tasks")?.tasks.length ?? 0;
  useEffect(() => {
    // A group that shrinks to one row starts collapsed if it grows again.
    if (shownTaskCount < 2) setTasksExpanded(false);
    // A chip that disappears with its last task must not reopen with the next one.
    if (shownTaskCount === 0) setTasksChipOpen(false);
  }, [shownTaskCount]);
  const shownSuggestionBefore = useRef(shownSuggestionId);
  const promptBefore = useRef(prompt);
  useEffect(() => {
    // Typing passes on the suggestion that was on screen before the edit,
    // not one that arrived together with it.
    if (promptBefore.current !== prompt && shownSuggestionBefore.current) {
      setUsedSuggestionId(shownSuggestionBefore.current);
    }
    promptBefore.current = prompt;
  }, [prompt]);
  useEffect(() => {
    shownSuggestionBefore.current = shownSuggestionId;
  });
  useEffect(() => {
    for (const record of selectNewlyFailedOperations({
      previous: previousRecords.current,
      next: records,
      mountedAt,
      reported: reportedFailures.current,
    })) {
      reportedFailures.current.add(record.operationId);
      showError(
        `${nativeOperationLabel(record.command.kind)} failed`,
        record.error ?? "The provider reported a failure.",
      );
    }
    previousRecords.current = records;
  }, [records, mountedAt]);
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      const api = readNativeApi();
      if (!api?.nativeOperations) return;
      refreshing = true;
      try {
        const version = mutationVersion.current;
        const [next, snapshot, recovery] = await Promise.all([
          api.nativeOperations.list({ threadId }),
          api.agents.getSnapshot(),
          api.nativeOperations.historyRecovery?.({ threadId, action: "inspect" }) ??
            Promise.resolve(null),
        ]);
        if (alive) {
          // A poll that started before a local receipt is older than that
          // receipt; the next poll replaces the list authoritatively.
          if (version === mutationVersion.current) {
            setRecords(next);
            setHistoryRecovery(recovery);
          }
          setTasks(snapshot.entries.filter((entry) => entry.threadId === threadId));
          setNowMs(Date.now());
        }
      } catch {
        /* Connection and capability surfaces already report transport failures. */
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, capabilities?.generation]);

  const execute = async (
    command: NativeOperationCommand,
  ): Promise<NativeOperationRecord | null> => {
    const api = readNativeApi()?.nativeOperations;
    if (!api || !capabilities || busy) return null;
    setBusy(true);
    try {
      const record = await api.execute({
        threadId,
        operationId: crypto.randomUUID(),
        generation: capabilities.generation,
        command,
      });
      mutationVersion.current++;
      if (record.error) {
        reportedFailures.current.add(record.operationId);
        showError(`${nativeOperationLabel(command.kind)} failed`, record.error);
      }
      setRecords((current) => [
        record,
        ...current.filter((entry) => entry.operationId !== record.operationId),
      ]);
      return record;
    } catch (cause) {
      showError(
        `${nativeOperationLabel(command.kind)} failed`,
        errorMessage(cause, "The native operation failed."),
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  /**
   * `execute` returns once the server admits an operation; the stop itself
   * settles later. Polls until the record leaves the in-flight states, and
   * returns null if it disappears, the tray unmounts or settlement times out.
   */
  const waitForSettlement = async (operationId: string): Promise<NativeOperationRecord | null> => {
    const api = readNativeApi()?.nativeOperations;
    if (!api) return null;
    const deadline = Date.now() + STOP_SETTLEMENT_TIMEOUT_MS;
    while (mounted.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STOP_SETTLEMENT_POLL_MS));
      if (!mounted.current) return null;
      try {
        const next = await api.list({ threadId });
        mutationVersion.current++;
        setRecords(next);
        const record = next.find((entry) => entry.operationId === operationId);
        if (!record) return null;
        if (!isNativeOperationInFlight(record)) return record;
      } catch {
        /* A transient poll failure retries until the deadline. */
      }
    }
    return null;
  };
  const resolve = async (record: NativeOperationRecord, action: "reconcile" | "acknowledge") => {
    const api = readNativeApi()?.nativeOperations;
    if (!api?.resolve || !capabilities || busy) return;
    setBusy(true);
    try {
      const next = await api.resolve({
        threadId,
        operationId: record.operationId,
        generation: capabilities.generation,
        action,
      });
      mutationVersion.current++;
      setRecords((current) =>
        current.map((entry) => (entry.operationId === next.operationId ? next : entry)),
      );
    } catch (cause) {
      showError("Outcome resolution failed", errorMessage(cause, "Outcome resolution failed."));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (nativeId: string, task: BackgroundTaskDescription, cursor?: string) => {
    if (!capabilities) return;
    // The output dialog replaces the chip's popover rather than stacking on it.
    setTasksChipOpen(false);
    const api = readNativeApi()?.nativeOperations;
    if (!api?.inspect) {
      showError("Task output unavailable", "Native output API is unavailable.");
      return;
    }
    setReading(true);
    try {
      const identity = readNativeTaskIdentity(nativeId);
      const page = await api.inspect({
        threadId,
        generation: capabilities.generation,
        kind: "task",
        nativeId: identity.taskId,
        ...(identity.runId ? { runId: identity.runId } : {}),
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      const nextCursor =
        page && typeof page === "object" && "nextCursor" in page ? page.nextCursor : null;
      setInspection({
        nativeId,
        task,
        page,
        nextCursor: typeof nextCursor === "string" ? nextCursor : null,
      });
    } catch (cause) {
      showError("Task output unavailable", errorMessage(cause, "Native output is unavailable."));
    } finally {
      setReading(false);
    }
  };
  const stopTasks = async (entries: readonly ThreadBackgroundWorkEntry[]) => {
    if (stopBlocked) return;
    setStopping(true);
    try {
      for (const entry of entries) {
        const record = await execute({
          kind: "stopTask",
          ...readNativeTaskIdentity(entry.workItemId),
        });
        if (!record) return;
        const settled = isNativeOperationInFlight(record)
          ? await waitForSettlement(record.operationId)
          : record;
        // An unsettled or uncertain stop keeps the reservation; the recovery
        // row takes over and later stops would only be refused.
        if (!settled || settled.state === "indeterminate") return;
      }
    } finally {
      if (mounted.current) setStopping(false);
    }
  };
  const copyOutput = async (output: string) => {
    try {
      await navigator.clipboard.writeText(output);
      toastManager.add({ type: "success", title: "Output copied" });
    } catch (cause) {
      showError("Copy failed", errorMessage(cause, "The clipboard is unavailable."));
    }
  };

  const renderTaskRow = (task: ThreadBackgroundWorkEntry, indented: boolean) => {
    const description = describeBackgroundTask(task, nowMs);
    const KindIcon = TASK_KIND_ICONS[description.kind];
    return (
      <div key={`task:${task.workItemId}`} className={cn(ROW_CLASS_NAME, indented && "pl-8")}>
        <KindIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground" title={description.title}>
          {description.title}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {[
            description.kindLabel,
            description.agentName !== description.title ? description.agentName : null,
            description.elapsed,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {indented ? null : viewAgents}
        {canInspectTasks && (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`View output: ${description.title}`}
            disabled={reading}
            onClick={() => void inspect(task.workItemId, description)}
          >
            Output
          </Button>
        )}
        {canStopTasks && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Stop ${description.title}`}
                  disabled={stopBlocked}
                  onClick={() => void stopTasks([task])}
                />
              }
            >
              <SquareIcon className="fill-current" />
            </TooltipTrigger>
            <TooltipPopup>Stop</TooltipPopup>
          </Tooltip>
        )}
      </div>
    );
  };

  const liveInspectedTask = inspection
    ? tasks.find((entry) => entry.workItemId === inspection.nativeId)
    : undefined;
  const inspectedTask = liveInspectedTask
    ? describeBackgroundTask(liveInspectedTask, nowMs)
    : inspection?.task;
  const shellOutput = readShellOutputPage(inspection?.page);
  const inspectionSubtitle = inspectedTask
    ? [
        inspectedTask.kindLabel,
        liveInspectedTask?.active && inspectedTask.elapsed
          ? `running ${inspectedTask.elapsed}`
          : null,
        shellOutput?.omitted
          ? `last ${formatByteSize(utf8ByteLength(shellOutput.output))} of ${formatByteSize(shellOutput.totalBytes)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  if (!capabilities && !historyRecovery) return null;

  return (
    <>
      {historyRecovery ? (
        <div className={ROW_CLASS_NAME} role="status">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Provider history is incomplete</span>
          <Button size="xs" variant="outline" onClick={() => setReviewingHistory(true)}>
            Review recovery
          </Button>
        </div>
      ) : null}
      <AlertDialog open={reviewingHistory} onOpenChange={setReviewingHistory}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Accept incomplete provider history?</AlertDialogTitle>
            <AlertDialogDescription>
              Some provider output could not be saved, including reasoning, tools or images.
              Continuing accepts incomplete local history and stops the provider. It will not resend
              the interrupted turn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={busy || !historyRecovery}
              onClick={() => {
                const api = readNativeApi()?.nativeOperations;
                if (!api?.historyRecovery || !historyRecovery || busy) return;
                setBusy(true);
                mutationVersion.current++;
                void api
                  .historyRecovery({ threadId, action: "acknowledge", expected: historyRecovery })
                  .then((current) => {
                    if (mounted.current) {
                      setHistoryRecovery(current);
                      setReviewingHistory(false);
                    }
                  })
                  .catch((cause) =>
                    showError(
                      "History recovery failed",
                      errorMessage(cause, "Review the current provider history before retrying."),
                    ),
                  )
                  .finally(() => {
                    if (mounted.current) setBusy(false);
                  });
              }}
            >
              Stop provider and accept incomplete history
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {rows.map((row) => {
        switch (row.kind) {
          case "suggestion":
            return (
              <div key={`suggestion:${row.id}`} className={ROW_CLASS_NAME}>
                <LightbulbIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  Suggested: <span className="text-foreground">{row.summary}</span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setUsedSuggestionId(row.id);
                    props.onSuggestion(row.summary);
                  }}
                >
                  Use
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss suggestion"
                  onClick={() => setUsedSuggestionId(row.id)}
                >
                  <XIcon />
                </Button>
              </div>
            );
          case "recovery": {
            const { record } = row;
            return (
              <div key={`recovery:${record.operationId}`} className={ROW_CLASS_NAME}>
                <TriangleAlertIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-warning-foreground"
                />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">
                    {nativeOperationLabel(record.command.kind)} outcome is uncertain
                  </span>
                  <span className="text-muted-foreground">
                    {record.staleGeneration ? " · result belongs to an older session" : ""}
                    {record.error ? ` · ${record.error}` : ""}
                    {record.command.kind === "fork"
                      ? ` · Preserved workspace: ${record.command.cwd}`
                      : ""}
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resolve(record, "reconcile")}
                >
                  Recheck outcome
                </Button>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => setAcknowledging(record)}
                >
                  {row.finishAcknowledgement
                    ? "Finish acknowledgement"
                    : "Stop provider and acknowledge"}
                </Button>
              </div>
            );
          }
          case "running":
            return (
              <div
                key={`running:${row.record.operationId}`}
                className={`${ROW_CLASS_NAME} text-muted-foreground`}
              >
                <Spinner aria-hidden className="size-3.5 shrink-0" />
                {nativeOperationLabel(row.record.command.kind)} running…
              </div>
            );
          case "tasks": {
            const { tasks: shownTasks } = row;
            if (tasksAsChip) {
              const descriptions = shownTasks.map((task) => describeBackgroundTask(task, nowMs));
              const chip = describeBackgroundWorkChip(descriptions);
              const chipLabel = [chip.counts, chip.elapsed].filter(Boolean).join(" · ");
              return createPortal(
                <StatusChip
                  chipId="background-work"
                  icon={TerminalIcon}
                  ariaLabel={`Background work: ${chipLabel}`}
                  popupLabel="Background work"
                  label={<span className="tabular-nums">{chipLabel}</span>}
                  open={tasksChipOpen}
                  onOpenChange={setTasksChipOpen}
                >
                  <div className="flex items-center gap-2 px-3 pt-2.5 text-xs">
                    <span className="font-medium text-foreground">Background work</span>
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {shownTasks.length} running
                    </span>
                    {shownTasks.length > 1 && canStopTasks ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={stopBlocked}
                        onClick={() => void stopTasks(shownTasks)}
                      >
                        Stop all
                      </Button>
                    ) : null}
                  </div>
                  <div
                    role="group"
                    aria-label="Background tasks"
                    className="divide-y divide-border"
                  >
                    {shownTasks.map((task) => renderTaskRow(task, false))}
                  </div>
                </StatusChip>,
                statusStripHost,
                "tasks",
              );
            }
            if (shownTasks.length === 1) return renderTaskRow(shownTasks[0]!, false);
            const newest = describeBackgroundTask(shownTasks.at(-1)!, nowMs);
            const ToggleIcon = tasksExpanded ? ChevronDownIcon : ChevronRightIcon;
            return (
              <div
                key="tasks"
                role="group"
                aria-label="Background tasks"
                className="divide-y divide-border"
              >
                <div className={ROW_CLASS_NAME}>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-expanded={tasksExpanded}
                    onClick={() => setTasksExpanded((expanded) => !expanded)}
                  >
                    <Spinner aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {shownTasks.length} background tasks
                      {tasksExpanded ? null : (
                        <span className="text-muted-foreground">
                          {` · ${newest.title}, +${shownTasks.length - 1} more`}
                        </span>
                      )}
                    </span>
                    <ToggleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                  {viewAgents}
                  {tasksExpanded && canStopTasks && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={stopBlocked}
                      onClick={() => void stopTasks(shownTasks)}
                    >
                      Stop all
                    </Button>
                  )}
                </div>
                {tasksExpanded && shownTasks.map((task) => renderTaskRow(task, true))}
              </div>
            );
          }
        }
      })}
      <AlertDialog
        open={acknowledging !== null}
        onOpenChange={(open) => {
          if (!open) setAcknowledging(null);
        }}
      >
        <AlertDialogPopup className="sm:max-w-[460px]">
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle>Accept this uncertain outcome?</AlertDialogTitle>
            <AlertDialogDescription>
              Stop the provider and accept this uncertain outcome? Files, conversation or forks may
              already have changed. F5 will release the reservation without repeating the operation.
              Inspect any affected workspace before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const record = acknowledging;
                setAcknowledging(null);
                if (record) void resolve(record, "acknowledge");
              }}
            >
              Stop provider and acknowledge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={inspection !== null}
        onOpenChange={(open) => {
          if (!open) setInspection(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">{inspectedTask?.title}</DialogTitle>
            {inspectionSubtitle ? (
              <DialogDescription className="tabular-nums">{inspectionSubtitle}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">
              {shellOutput
                ? shellOutput.output || "No output yet."
                : JSON.stringify(inspection?.page ?? null, null, 2)}
            </pre>
          </DialogPanel>
          {inspection && shellOutput ? (
            <DialogFooter variant="bare">
              <Button
                size="sm"
                variant="outline"
                disabled={reading}
                onClick={() => void inspect(inspection.nativeId, inspection.task)}
              >
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!shellOutput.output}
                onClick={() => void copyOutput(shellOutput.output)}
              >
                Copy
              </Button>
            </DialogFooter>
          ) : inspection?.nextCursor ? (
            <DialogFooter variant="bare">
              <Button
                size="sm"
                variant="outline"
                disabled={reading}
                onClick={() =>
                  void inspect(inspection.nativeId, inspection.task, inspection.nextCursor!)
                }
              >
                Next page
              </Button>
            </DialogFooter>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
