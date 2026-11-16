import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ScheduledTaskRunId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { NativeSelect } from "../ui/select";
import { describeSchedule } from "@t3tools/shared/cronSchedule";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { scheduledQueryKey, scheduledTasksQueryOptions } from "../../lib/scheduledTasksQuery";
import { Button } from "../ui/button";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { SettingsCard, SettingsRow } from "../settings/SettingsCard";
import { isElectron } from "../../env";
import { requestNotificationPermission, useNotificationPermissionState } from "../../notifications";

function scheduleSummary(task: ScheduledTask) {
  try {
    return describeSchedule(task.cron, task.timezone);
  } catch {
    return `${task.cron} (${task.timezone})`;
  }
}
const disabledReasonLabels: Record<NonNullable<ScheduledTask["disabledReason"]>, string> = {
  authority_revoked: "Scheduling permission was revoked",
  project_missing: "Project unavailable",
  invalid_schedule: "Invalid schedule",
  invalid_state: "Stored data needs recovery",
  thread_unavailable: "Conversation archived or deleted",
};
type Editing =
  | { kind: "edit"; task: ScheduledTask }
  | { kind: "new"; projectId: ProjectId; boundThreadId?: ThreadId };
export function ScheduledPage({
  projectFilter,
  selectedTaskId,
  editTaskId,
  newTaskThreadId,
  onProjectFilterChange,
  onEditRequestHandled,
  onThreadRequestHandled,
}: {
  /** Shows only this project's tasks. Lookups always use the full list. */
  projectFilter?: ProjectId;
  selectedTaskId?: ScheduledTaskId;
  editTaskId?: ScheduledTaskId;
  /** Opens a new task bound to this conversation. */
  newTaskThreadId?: ThreadId;
  onProjectFilterChange?: (projectId: ProjectId | undefined) => void;
  onEditRequestHandled?: () => void;
  onThreadRequestHandled?: () => void;
}) {
  const client = useQueryClient();
  const projects = useStore((s) => s.projects);
  const requestedThreadProjectId = useStore((s) =>
    newTaskThreadId ? s.threads.find((t) => t.id === newTaskThreadId)?.projectId : undefined,
  );
  const threadsHydrated = useStore((s) => s.threadsHydrated);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [history, setHistory] = useState<ScheduledTaskId | undefined>(selectedTaskId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery(scheduledTasksQueryOptions());
  const filterProject = projectFilter ? projects.find((p) => p.id === projectFilter) : undefined;
  const unknownFilter = !!projectFilter && !filterProject;
  const visible = useMemo(
    () =>
      projectFilter
        ? (list.data?.tasks ?? []).filter((entry) => entry.task.projectId === projectFilter)
        : (list.data?.tasks ?? []),
    [list.data, projectFilter],
  );
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const { task } of list.data?.tasks ?? [])
      result.set(task.projectId, (result.get(task.projectId) ?? 0) + 1);
    return result;
  }, [list.data]);
  useEffect(() => setHistory(selectedTaskId), [selectedTaskId]);
  useEffect(() => {
    if (!editTaskId || !list.data) return;
    const task = list.data.tasks.find((entry) => entry.task.id === editTaskId)?.task;
    if (task) setEditing({ kind: "edit", task });
    onEditRequestHandled?.();
  }, [editTaskId, list.data, onEditRequestHandled]);
  useEffect(() => {
    if (!newTaskThreadId || !threadsHydrated) return;
    if (requestedThreadProjectId)
      setEditing({
        kind: "new",
        projectId: requestedThreadProjectId,
        boundThreadId: newTaskThreadId,
      });
    else setError("That conversation is no longer available.");
    onThreadRequestHandled?.();
  }, [newTaskThreadId, threadsHydrated, requestedThreadProjectId, onThreadRequestHandled]);
  const creationProjectId = filterProject?.id ?? (unknownFilter ? undefined : projects[0]?.id);
  const permission = useNotificationPermissionState();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await client.invalidateQueries({ queryKey: scheduledQueryKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Scheduled tasks</h1>
          <p className="text-sm text-muted-foreground">
            Local agent runs in a new conversation each time, or in a conversation you choose. F5
            must be running.
          </p>
        </div>
        <Button
          disabled={!creationProjectId || busy}
          onClick={() => {
            if (creationProjectId) setEditing({ kind: "new", projectId: creationProjectId });
          }}
        >
          New task
        </Button>
      </div>
      <SettingsCard title="Scheduler">
        <SettingsRow
          title="Scheduler enabled"
          description="Allow scheduled runs while this F5 server is running."
          control={
            <Switch
              aria-label="Scheduler enabled"
              checked={settings.scheduledTasks.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void run(() =>
                  updateSettings({ scheduledTasks: { ...settings.scheduledTasks, enabled } }),
                )
              }
            />
          }
        />
        <SettingsRow
          title="Concurrent runs"
          description="Maximum scheduled runs preparing or running at the same time."
          control={
            <Input
              aria-label="Concurrent scheduled runs"
              className="w-20"
              type="number"
              min={1}
              max={10}
              value={settings.scheduledTasks.maxConcurrentRuns}
              disabled={busy}
              onChange={(e) => {
                const cap = Number(e.target.value);
                if (Number.isInteger(cap) && cap >= 1 && cap <= 10)
                  void run(() =>
                    updateSettings({
                      scheduledTasks: { ...settings.scheduledTasks, maxConcurrentRuns: cap },
                    }),
                  );
              }}
            />
          }
        />
        {!isElectron && (
          <SettingsRow
            title="Browser notifications"
            description={
              permission === "denied"
                ? "Notifications are blocked. Allow them in your browser’s site settings."
                : permission === "unsupported"
                  ? "System notifications are unavailable in this browser."
                  : "Receive system notifications when runs finish, fail or need your attention. Each task has its own notification preference."
            }
            control={
              permission === "default" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(requestNotificationPermission)}
                >
                  Allow notifications
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {permission === "granted"
                    ? "Allowed"
                    : permission === "denied"
                      ? "Blocked"
                      : "Unavailable"}
                </span>
              )
            }
          />
        )}
      </SettingsCard>
      {error && <p role="alert">{error}</p>}
      <label className="flex items-center gap-2 text-sm">
        Project
        <NativeSelect
          aria-label="Project filter"
          className="w-auto"
          value={projectFilter ?? ""}
          onChange={(e) =>
            onProjectFilterChange?.(e.target.value ? (e.target.value as ProjectId) : undefined)
          }
        >
          <option value="">All projects ({list.data?.tasks.length ?? 0})</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({counts.get(p.id) ?? 0})
            </option>
          ))}
          {unknownFilter && <option value={projectFilter}>Unknown project</option>}
        </NativeSelect>
      </label>
      {unknownFilter &&
        (threadsHydrated ? (
          <div role="status" className="flex items-center gap-2 text-sm">
            This project is no longer available.
            <Button size="sm" variant="outline" onClick={() => onProjectFilterChange?.(undefined)}>
              Show all projects
            </Button>
          </div>
        ) : (
          <p role="status">Loading projects…</p>
        ))}
      {list.isError && <p role="alert">Unable to load scheduled tasks. {list.error.message}</p>}
      {list.isPending && <p role="status">Loading tasks…</p>}
      {list.data?.tasks.length === 0 && <p>No scheduled tasks yet.</p>}
      {!!list.data?.tasks.length && projectFilter && !unknownFilter && visible.length === 0 && (
        <p>No scheduled tasks in this project.</p>
      )}
      <div className="space-y-3">
        {visible.map(({ task, latestRun, activeRun }) => (
          <article key={task.id} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium">{task.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {projects.find((p) => p.id === task.projectId)?.name ?? "Missing project"} ·{" "}
                  {scheduleSummary(task)}
                </p>
                {task.workspace.kind === "thread" && (
                  <BoundConversationLabel threadId={task.workspace.threadId} />
                )}
                {!task.enabled && task.disabledReason && (
                  <p className="text-sm text-muted-foreground">
                    Disabled: {disabledReasonLabels[task.disabledReason]}
                  </p>
                )}
                <p className="text-sm">
                  Next:{" "}
                  {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "No next fire"}
                </p>
                {activeRun && (
                  <p className="text-sm font-medium">
                    Active: {activeRun.status.replaceAll("_", " ")}
                    {activeRun.reason ? ` · ${activeRun.reason.replaceAll("_", " ")}` : ""}
                  </p>
                )}
                {latestRun && (
                  <p className="text-sm">
                    Last: {latestRun.status}
                    {latestRun.reason ? ` · ${latestRun.reason.replaceAll("_", " ")}` : ""}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Enabled</span>
                <Switch
                  aria-label={`Enable ${task.name}`}
                  checked={task.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void run(() =>
                      ensureNativeApi().scheduledTasks.setEnabled({
                        id: task.id,
                        expectedVersion: task.version,
                        enabled,
                      }),
                    )
                  }
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !settings.scheduledTasks.enabled}
                onClick={() =>
                  void run(() =>
                    ensureNativeApi().scheduledTasks.runNow({
                      taskId: task.id,
                      runId: ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
                      requestedAt: new Date().toISOString(),
                    }),
                  )
                }
              >
                Run now
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing({ kind: "edit", task })}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setHistory(history === task.id ? undefined : task.id)}
              >
                Run history
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      await ensureNativeApi().dialogs.confirm(
                        `Delete “${task.name}”? Existing conversations and worktrees are kept.`,
                      )
                    )
                      await ensureNativeApi().scheduledTasks.delete({
                        id: task.id,
                        expectedVersion: task.version,
                      });
                  })
                }
              >
                Delete
              </Button>
            </div>
            {history === task.id && <RunHistory taskId={task.id} />}
          </article>
        ))}
      </div>
      {selectedTaskId &&
        list.data &&
        !list.data.tasks.some((r) => r.task.id === selectedTaskId) && (
          <div>
            <p>This task is no longer available. Its existing conversations are preserved.</p>
            <RunHistory taskId={selectedTaskId} />
          </div>
        )}
      {editing && (
        // The draft owns its project, so switching projects never remounts it.
        <ScheduledTaskDialog
          key={editing.kind === "new" ? `new:${editing.boundThreadId ?? ""}` : editing.task.id}
          projectId={editing.kind === "new" ? editing.projectId : editing.task.projectId}
          {...(editing.kind === "edit"
            ? { task: editing.task }
            : editing.boundThreadId
              ? { boundThreadId: editing.boundThreadId }
              : { allowProjectChange: true })}
          onClose={() => setEditing(null)}
          onSaved={(savedProjectId) => {
            void client.invalidateQueries({ queryKey: scheduledQueryKey });
            if (projectFilter && savedProjectId !== projectFilter)
              onProjectFilterChange?.(savedProjectId);
          }}
        />
      )}
    </main>
  );
}
function BoundConversationLabel({ threadId }: { threadId: ThreadId }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId && !t.archivedAt));
  return (
    <p className="text-sm">
      {thread ? (
        <>
          Conversation:{" "}
          <Link className="underline" to="/$threadId" params={{ threadId }}>
            {thread.title}
          </Link>
        </>
      ) : (
        "Conversation removed"
      )}
    </p>
  );
}
function RunHistory({ taskId }: { taskId: ScheduledTaskId }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: [...scheduledQueryKey, taskId, "runs"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().scheduledTasks.listRuns({
        taskId,
        ...(pageParam ? { before: pageParam } : {}),
        limit: 50,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <div className="mt-4 space-y-2 border-t pt-3">
      <h3 className="font-medium">Run history</h3>
      {history.isPending && <p>Loading runs…</p>}
      {history.error && <p role="alert">{history.error.message}</p>}
      {error && <p role="alert">{error}</p>}
      {history.data?.pages
        .flatMap((page) => page.runs)
        .map((run) => (
          <div key={run.id} className="flex flex-wrap items-center gap-2 text-sm">
            <time>{new Date(run.scheduledFor).toLocaleString()}</time>
            <span>
              {run.trigger} · {run.status.replaceAll("_", " ")}
              {run.reason ? ` · ${run.reason.replaceAll("_", " ")}` : ""}
            </span>
            {run.suppressedCount > 1 && (
              <span>
                {run.suppressedCount} suppressed fires through {run.evaluatedThrough}
              </span>
            )}
            {run.error && <span>{run.error}</span>}
            {run.threadId && (
              <Link className="underline" to="/$threadId" params={{ threadId: run.threadId }}>
                Open conversation
              </Link>
            )}
            {run.status === "needs_attention" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void (async () => {
                    try {
                      if (
                        await ensureNativeApi().dialogs.confirm(
                          "Stop any active work in the conversation first. Resolve this run without resending its prompt? This acknowledges that an uncertain delivery may have reached the provider.",
                        )
                      ) {
                        await ensureNativeApi().scheduledTasks.resolveRun({
                          runId: run.id,
                          acknowledgeUnknownDelivery: true,
                        });
                        await client.invalidateQueries({ queryKey: scheduledQueryKey });
                      }
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Resolution failed.");
                    }
                  })();
                }}
              >
                Resolve
              </Button>
            )}
          </div>
        ))}
      {history.hasNextPage && (
        <Button
          variant="outline"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Load older runs
        </Button>
      )}
    </div>
  );
}
