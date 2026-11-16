/** Shelved workspace, not routed or mounted; retained for future work. See PR #148. */
import {
  BOT_TASK_INSTRUCTIONS_MAX_CHARS,
  BOT_TASK_TERMINAL_STATUSES,
  BOT_TASK_TITLE_MAX_CHARS,
  ProjectId,
  ThreadId,
  type AgentBridgeClient,
  type BotTask,
  type BotTaskActivity,
} from "@t3tools/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  agentBridgeStateQueryOptions,
  BOT_TASK_STATUS_LABELS,
  botTaskActivitiesQueryOptions,
  botTaskQueryOptions,
  botTasksQueryOptions,
  controlBotTask,
  createBotTask,
  describeContact,
  newOperationId,
  OPEN_TASK_STATUSES,
  replyToBotTask,
  useBotWorkspaceInvalidation,
} from "../../lib/botWorkspaceReactQuery";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { selectThreadById, useThreadSummary } from "../../threadSelectors";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const STATUS_VARIANT: Record<
  BotTask["status"],
  "outline" | "info" | "warning" | "success" | "error" | "secondary"
> = {
  queued: "outline",
  running: "info",
  "waiting-for-user": "warning",
  paused: "secondary",
  completed: "success",
  failed: "error",
  cancelled: "secondary",
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Bot-authored text: rendered with the restrictive external-bot policy. */
function BotText({ text }: { text: string }) {
  return (
    <div className="text-sm">
      <ChatMarkdown text={text} cwd={undefined} policy="external-bot" />
    </div>
  );
}

function TaskStatusBadge({ status }: { status: BotTask["status"] }) {
  return <Badge variant={STATUS_VARIANT[status]}>{BOT_TASK_STATUS_LABELS[status]}</Badge>;
}

const ACTIVITY_LABELS: Record<BotTaskActivity["type"], string> = {
  created: "Task created",
  claimed: "Claimed",
  progress: "Progress",
  question: "Question",
  reply: "Your reply",
  "question-withdrawn": "Question withdrawn",
  paused: "Paused",
  resumed: "Resumed",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
};

function TaskHistory({ taskId }: { taskId: string }) {
  const query = useInfiniteQuery(botTaskActivitiesQueryOptions(taskId));
  const pages = query.data?.pages ?? [];
  const activities = pages.flatMap((page) => page.activities);
  const prunedBefore = pages[0]?.progressPrunedBefore ?? null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">History</h3>
      <ol className="space-y-2">
        {activities.map((activity) => (
          <li key={activity.sequence} className="rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className="font-medium text-foreground">{ACTIVITY_LABELS[activity.type]}</span>
              <time dateTime={activity.createdAt}>
                {new Date(activity.createdAt).toLocaleString()}
              </time>
            </div>
            {activity.content ? (
              activity.actor === "bot" ? (
                <BotText text={activity.content} />
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-foreground">{activity.content}</p>
              )
            ) : null}
          </li>
        ))}
      </ol>
      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load older
        </Button>
      ) : null}
      {prunedBefore ? (
        <p className="text-2xs text-muted-foreground">
          Progress entries before {new Date(prunedBefore).toLocaleDateString()} are removed after 30
          days. Questions, replies, controls, and results are kept.
        </p>
      ) : null}
    </section>
  );
}

function ReplyBox({ task }: { task: BotTask }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const question = task.pendingQuestion;
  if (!question) return null;
  const submit = async () => {
    setPending(true);
    try {
      await replyToBotTask(queryClient, {
        taskId: task.id,
        questionId: question.questionId,
        expectedVersion: task.version,
        text,
      });
      setText("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Reply not sent",
        description: errorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-2 rounded-md border border-warning/40 bg-warning/4 p-3">
      <h3 className="text-sm font-medium text-foreground">{task.clientName} asks</h3>
      <BotText text={question.text} />
      <Textarea
        aria-label="Reply"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Your reply"
      />
      <p className="text-2xs text-muted-foreground">
        A reply is information for the agent, never approval for purchases, messages, or account
        changes.
      </p>
      <Button
        size="sm"
        disabled={pending || text.trim().length === 0}
        onClick={() => void submit()}
      >
        Send reply
      </Button>
    </section>
  );
}

function TaskControls({ task }: { task: BotTask }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  if (BOT_TASK_TERMINAL_STATUSES.has(task.status)) return null;
  const run = async (action: "pause" | "resume" | "cancel") => {
    setPending(true);
    try {
      await controlBotTask(queryClient, action, task);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Task not updated",
        description: errorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        {task.status === "paused" ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void run("resume")}>
            Resume
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void run("pause")}>
            Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={pending}
          onClick={() => void run("cancel")}
        >
          Cancel task
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground">
        Pause and cancel change only the F5 task. They don't stop the agent; use the agent's own app
        for that.
      </p>
    </div>
  );
}

function TaskDetail({ taskId }: { taskId: string }) {
  const query = useQuery(botTaskQueryOptions(taskId));
  const projects = useStore((state) => state.projects);
  const sourceThread = useThreadSummary(
    query.data?.sourceThreadId ? ThreadId.makeUnsafe(query.data.sourceThreadId) : null,
  );
  const now = useNow();
  const task = query.data;
  if (query.isError)
    return <p className="p-4 text-sm text-destructive">{errorMessage(query.error)}</p>;
  if (!task) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  const project = projects.find((entry) => entry.id === task.projectId);
  return (
    <div className="space-y-4 p-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            {task.title}
          </h2>
          <TaskStatusBadge status={task.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {task.clientName} · {project?.name ?? "Unknown project"}
          {sourceThread ? ` · from “${sourceThread.title}”` : ""} ·{" "}
          {describeContact(task.lastContactAt, now)}
        </p>
      </header>
      <TaskControls task={task} />
      <section className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">Instructions</h3>
        <p className="whitespace-pre-wrap text-sm text-foreground">{task.instructions}</p>
      </section>
      {task.latestProgress ? (
        <section className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Latest progress</h3>
          <BotText text={task.latestProgress} />
        </section>
      ) : null}
      <ReplyBox task={task} />
      {task.result ? (
        <section className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Result</h3>
          <p className="text-2xs text-muted-foreground">Reported by {task.clientName}.</p>
          <BotText text={task.result} />
        </section>
      ) : null}
      {task.failure ? (
        <section className="space-y-1">
          <h3 className="text-sm font-medium text-destructive">Failure</h3>
          <BotText text={task.failure} />
        </section>
      ) : null}
      <TaskHistory taskId={task.id} />
    </div>
  );
}

export function NewBotTaskDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: ReadonlyArray<AgentBridgeClient>;
  sourceThreadId: string | null;
  onCreated: (task: BotTask) => void;
}) {
  const queryClient = useQueryClient();
  const projects = useStore((state) => state.projects);
  const sourceThread = useThreadSummary(
    props.sourceThreadId ? ThreadId.makeUnsafe(props.sourceThreadId) : null,
  );
  const eligibleClients = props.clients.filter(
    (client) => client.revokedAt === null && client.scopes.includes("f5.tasks"),
  );
  const [clientId, setClientId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  // One operation id per dialog submission; a retry after an error reuses it.
  const [operationId, setOperationId] = useState(newOperationId);
  const [pending, setPending] = useState(false);
  const client = eligibleClients.find((entry) => entry.id === clientId) ?? eligibleClients[0];
  const clientProjects = projects.filter((project) =>
    client?.projectIds.some((id) => id === project.id),
  );
  const effectiveProjectId =
    (sourceThread?.projectId as string | undefined) ??
    (clientProjects.some((project) => project.id === projectId) ? projectId : null) ??
    clientProjects[0]?.id ??
    null;

  // Reset only when the dialog opens or its source changes: the store replaces
  // the thread object on every message, which must not clear the user's text.
  useEffect(() => {
    if (!props.open) return;
    const thread = props.sourceThreadId
      ? selectThreadById(useStore.getState(), ThreadId.makeUnsafe(props.sourceThreadId))
      : undefined;
    setTitle(thread ? thread.title : "");
    setInstructions("");
    setOperationId(newOperationId());
  }, [props.open, props.sourceThreadId]);

  const submit = async () => {
    if (!client || !effectiveProjectId) return;
    setPending(true);
    try {
      const task = await createBotTask(queryClient, {
        operationId,
        clientId: client.id,
        projectId: ProjectId.makeUnsafe(effectiveProjectId),
        title: title.trim(),
        instructions,
        ...(sourceThread ? { sourceThreadId: ThreadId.makeUnsafe(sourceThread.id) } : {}),
      });
      // Close first: closing clears the "from thread" search, then selection sets the task.
      props.onOpenChange(false);
      props.onCreated(task);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Task not created",
        description: errorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };

  const projectName = (id: string | null) =>
    projects.find((project) => project.id === id)?.name ?? "Choose a project";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Assign a task to a connected agent. It sees only the title, instructions, and project
            name, never your files.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {eligibleClients.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No connected client can take tasks. Enable Agent Bridge in Settings → Integrations.
            </p>
          ) : (
            <>
              <label className="block space-y-1 text-xs font-medium text-foreground">
                <span>Assign to</span>
                <Select
                  value={client?.id ?? null}
                  onValueChange={(value) => value && setClientId(value)}
                >
                  <SelectTrigger aria-label="Assign to">
                    <SelectValue>{client?.name ?? "Choose a client"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start">
                    {eligibleClients.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="block space-y-1 text-xs font-medium text-foreground">
                <span>Project</span>
                <Select
                  value={effectiveProjectId}
                  disabled={sourceThread !== undefined}
                  onValueChange={(value) => value && setProjectId(value)}
                >
                  <SelectTrigger aria-label="Project">
                    <SelectValue>{projectName(effectiveProjectId)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start">
                    {clientProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {clientProjects.length === 0 ? (
                  <span className="block font-normal text-muted-foreground">
                    Share a project with Agent Bridge first.
                  </span>
                ) : null}
              </label>
              {sourceThread ? (
                <p className="text-xs text-muted-foreground">From thread “{sourceThread.title}”.</p>
              ) : null}
              <label className="block space-y-1 text-xs font-medium text-foreground">
                <span>Title</span>
                <Input
                  value={title}
                  maxLength={BOT_TASK_TITLE_MAX_CHARS}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="block space-y-1 text-xs font-medium text-foreground">
                <span>Instructions</span>
                <Textarea
                  value={instructions}
                  maxLength={BOT_TASK_INSTRUCTIONS_MAX_CHARS}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={
              pending ||
              !client ||
              !effectiveProjectId ||
              title.trim().length === 0 ||
              instructions.trim().length === 0
            }
            onClick={() => void submit()}
          >
            Assign task
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BotsWorkspace(props: {
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  newTaskFromThread: string | null;
  onNewTaskDialogClosed: () => void;
}) {
  useBotWorkspaceInvalidation();
  const stateQuery = useQuery(agentBridgeStateQueryOptions());
  const clients = stateQuery.data?.clients ?? [];
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [showOpenOnly, setShowOpenOnly] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(props.newTaskFromThread !== null);
  useEffect(() => {
    if (props.newTaskFromThread !== null) setDialogOpen(true);
  }, [props.newTaskFromThread]);
  const tasksQuery = useInfiniteQuery(
    botTasksQueryOptions({
      clientId: clientFilter,
      statuses: showOpenOnly ? OPEN_TASK_STATUSES : null,
    }),
  );
  const tasks = useMemo(
    () => tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [],
    [tasksQuery.data],
  );
  const now = useNow();

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold text-foreground">Bot tasks</h1>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              New task
            </Button>
          </div>
          <div className="flex gap-2">
            <Select
              value={clientFilter ?? "all"}
              onValueChange={(value) => setClientFilter(!value || value === "all" ? null : value)}
            >
              <SelectTrigger aria-label="Client" size="sm">
                <SelectValue>
                  {clients.find((client) => client.id === clientFilter)?.name ?? "All clients"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                <SelectItem value="all">All clients</SelectItem>
                {clients.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="sm" variant="outline" onClick={() => setShowOpenOnly((value) => !value)}>
              {showOpenOnly ? "Open" : "All"}
            </Button>
          </div>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {tasks.length === 0 && !tasksQuery.isPending ? (
            <li className="p-3 text-xs text-muted-foreground">No tasks.</li>
          ) : null}
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                className={cn(
                  "w-full space-y-1 border-b border-border px-3 py-2 text-left hover:bg-accent/50",
                  props.selectedTaskId === task.id && "bg-accent",
                )}
                onClick={() => props.onSelectTask(task.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {task.title}
                  </span>
                  <TaskStatusBadge status={task.status} />
                </div>
                <p className="truncate text-2xs text-muted-foreground">
                  {task.clientName} · {describeContact(task.lastContactAt, now)}
                </p>
              </button>
            </li>
          ))}
          {tasksQuery.hasNextPage ? (
            <li className="p-3">
              <Button
                size="sm"
                variant="outline"
                disabled={tasksQuery.isFetchingNextPage}
                onClick={() => void tasksQuery.fetchNextPage()}
              >
                Load more
              </Button>
            </li>
          ) : null}
        </ul>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {props.selectedTaskId ? (
          <TaskDetail key={props.selectedTaskId} taskId={props.selectedTaskId} />
        ) : (
          <div className="space-y-2 p-6 text-sm text-muted-foreground">
            <p>Assign work to an agent connected through Agent Bridge, such as a ChatGPT Dot.</p>
            <p>
              Agents claim tasks, report progress, and can ask you questions here. Results are
              reported by the agent.
            </p>
          </div>
        )}
      </div>
      <NewBotTaskDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) props.onNewTaskDialogClosed();
        }}
        clients={clients}
        sourceThreadId={props.newTaskFromThread}
        onCreated={(task) => props.onSelectTask(task.id)}
      />
    </div>
  );
}
