import type { ThreadId } from "@t3tools/contracts";
import type { TaskItem as ThreadTaskItem } from "~/types";
import { ChevronDownIcon, ChevronRightIcon, ListTodoIcon } from "lucide-react";
import { cn } from "~/lib/utils";

const TASK_STATUS_META = {
  pending: {
    label: "Pending",
    accentClass: "border-amber-500/30 bg-amber-500/6 text-amber-700 dark:text-amber-300",
    dotClass: "bg-amber-500/80",
  },
  in_progress: {
    label: "In progress",
    accentClass: "border-sky-500/30 bg-sky-500/8 text-sky-700 dark:text-sky-300",
    dotClass: "bg-sky-500",
  },
  completed: {
    label: "Completed",
    accentClass: "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
  },
} as const satisfies Record<
  ThreadTaskItem["status"],
  { label: string; accentClass: string; dotClass: string }
>;

export function ThreadTasksPanel(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<ThreadTaskItem>;
  readonly open: boolean;
  readonly summary: string;
  readonly onToggle: () => void;
  readonly attached?: boolean;
}) {
  const panelId = `thread-task-panel-${input.threadId}`;

  return (
    <section
      data-composer-task-drawer={input.attached || undefined}
      className="overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm backdrop-blur-sm"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35"
        onClick={input.onToggle}
        aria-controls={panelId}
        aria-expanded={input.open}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ListTodoIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-foreground text-sm">Task list</span>
          </div>
          <p className="truncate pt-0.5 text-muted-foreground text-xs">{input.summary}</p>
        </div>
        {input.open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          input.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-70",
        )}
      >
        <div id={panelId} className="overflow-hidden" inert={!input.open}>
          <div
            role={input.attached ? "region" : undefined}
            aria-label={input.attached ? "Task list details" : undefined}
            tabIndex={input.attached && input.open ? 0 : undefined}
            className={cn(
              "space-y-2 border-t border-border/60 px-4 py-3",
              input.attached && "max-h-[min(35dvh,20rem)] overflow-y-auto overscroll-contain",
            )}
          >
            {input.tasks.map((task) => {
              const meta = TASK_STATUS_META[task.status];
              return (
                <div
                  key={task.id}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border px-3 py-2 transition-colors duration-200",
                    meta.accentClass,
                  )}
                >
                  <span
                    className={cn(
                      "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-200",
                      meta.dotClass,
                      task.status === "in_progress" ? "animate-pulse" : "",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">{task.activeForm}</p>
                    {task.content !== task.activeForm ? (
                      <p className="truncate pt-0.5 text-muted-foreground text-xs">
                        {task.content}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-full border border-current/15 px-2 py-0.5 font-medium text-[11px] uppercase tracking-[0.08em]">
                    {meta.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
