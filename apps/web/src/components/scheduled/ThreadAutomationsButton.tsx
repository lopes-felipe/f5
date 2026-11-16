import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScheduledTaskRunId, type ScheduledTask, type ThreadId } from "@t3tools/contracts";
import { describeSchedule } from "@t3tools/shared/cronSchedule";
import { CalendarClockIcon } from "lucide-react";
import { ensureNativeApi } from "../../nativeApi";
import { scheduledQueryKey, scheduledTasksQueryOptions } from "../../lib/scheduledTasksQuery";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

function scheduleLabel(task: ScheduledTask) {
  try {
    return describeSchedule(task.cron, task.timezone);
  } catch {
    return `${task.cron} (${task.timezone})`;
  }
}

/** Tasks that send their runs into this conversation. Uses the shared task list; renders nothing when there are none. */
export function ThreadAutomationsButton({ threadId }: { threadId: ThreadId }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery(scheduledTasksQueryOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = (list.data?.tasks ?? []).filter(
    ({ task }) => task.workspace.kind === "thread" && task.workspace.threadId === threadId,
  );
  if (!tasks.length) return null;
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
  const label = `${tasks.length} automation${tasks.length === 1 ? "" : "s"}`;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Automations: ${label}`}
        className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 px-1.5 text-2xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
      >
        <CalendarClockIcon className="size-3.5" aria-hidden />
        {tasks.length}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-80" aria-label="Automations">
        <PopoverTitle className="text-sm">Automations</PopoverTitle>
        <ul className="mt-2 space-y-3">
          {tasks.map(({ task }) => {
            const schedule = scheduleLabel(task);
            return (
              <li key={task.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="min-w-0 truncate text-sm font-medium"
                    title={`${task.name} · ${schedule}`}
                  >
                    {task.name}
                  </span>
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
                <p className="truncate text-xs text-muted-foreground" title={schedule}>
                  {schedule} ·{" "}
                  {task.enabled && task.nextRunAt
                    ? `Next ${new Date(task.nextRunAt).toLocaleString()}`
                    : "Paused"}
                </p>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
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
                    size="xs"
                    variant="ghost"
                    onClick={() => void navigate({ to: "/scheduled", search: { taskId: task.id } })}
                  >
                    Manage
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
}
