/**
 * Projection of Claude's native Task tools (TaskCreate, TaskUpdate, TaskList,
 * TaskGet) onto F5's canonical thread task list.
 *
 * The harness owns task execution and storage; F5 only projects successful,
 * correlated results. Everything here is pure so server ingestion, the
 * projector, the projection pipeline and the web store share one implementation. Symbols use the `TaskTool`
 * prefix to stay distinct from background-task state (`ClaudeTaskState`).
 */
import {
  MAX_TASK_TOOL_HANDLED_CALL_IDS,
  MAX_TASK_TOOL_PENDING_CALLS,
  MAX_THREAD_TASKS,
  type TaskItem,
  type TaskItemStatus,
  type ThreadTaskTracking,
  type ToolCompletionEnvelope,
  type TurnId,
} from "@t3tools/contracts";

/**
 * Claude's native task-tracking tools (the `CLAUDE_CODE_ENABLE_TASKS` surface).
 * Not to be confused with the legacy `Task` sub-agent delegation tool.
 */
export const TASK_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];
const TASK_TOOL_NAME_SET: ReadonlySet<string> = new Set(TASK_TOOL_NAMES);

export function isTaskToolName(value: unknown): value is TaskToolName {
  return typeof value === "string" && TASK_TOOL_NAME_SET.has(value);
}

const MAX_TASK_DESCRIPTION_CHARS = 4_000;
const MAX_INVALIDATED_CALL_IDS = MAX_TASK_TOOL_PENDING_CALLS;

export interface TaskToolState {
  readonly tasks: ReadonlyArray<TaskItem>;
  readonly tracking: ThreadTaskTracking | null;
}

export type TaskToolLifecycleInput =
  | {
      readonly phase: "started";
      readonly nativeCallId: string;
      readonly toolName: TaskToolName;
      readonly turnId: TurnId | null;
    }
  | {
      readonly phase: "completed";
      readonly nativeCallId: string;
      readonly toolName: TaskToolName;
      readonly turnId: TurnId | null;
      readonly completion: ToolCompletionEnvelope;
    }
  | {
      /** The call ended (interrupt, stream failure, stop) without a result. */
      readonly phase: "abandoned";
      readonly nativeCallId: string;
      readonly toolName: TaskToolName;
      readonly turnId: TurnId | null;
    };

export function emptyTaskToolTracking(): ThreadTaskTracking {
  return {
    version: 1,
    source: "claude-task-tools",
    nativeSessionId: null,
    generation: 0,
    syncState: "synced",
    pendingCalls: [],
    invalidatedCallIds: [],
    handledCallIds: [],
    provenance: [],
    suppressedTaskIds: [],
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTaskStatus(value: unknown): TaskItemStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

function asIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.map(asNonEmptyString).filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

function boundedDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > MAX_TASK_DESCRIPTION_CHARS
    ? value.slice(0, MAX_TASK_DESCRIPTION_CHARS)
    : value;
}

function keepNewest<T>(values: ReadonlyArray<T>, limit: number): T[] {
  return values.length > limit ? values.slice(values.length - limit) : [...values];
}

function withSync(
  tracking: ThreadTaskTracking,
  syncState: ThreadTaskTracking["syncState"],
  syncDetail?: string,
): ThreadTaskTracking {
  const { syncDetail: _previous, ...rest } = tracking;
  return { ...rest, syncState, ...(syncDetail ? { syncDetail } : {}) };
}

/** Escalate only: a result never downgrades overflow to sync-required. */
function markSyncRequired(tracking: ThreadTaskTracking, detail: string): ThreadTaskTracking {
  return tracking.syncState === "overflow" ? tracking : withSync(tracking, "sync-required", detail);
}

function resolveCall(tracking: ThreadTaskTracking, nativeCallId: string): ThreadTaskTracking {
  return {
    ...tracking,
    pendingCalls: tracking.pendingCalls.filter((call) => call.nativeCallId !== nativeCallId),
    handledCallIds: keepNewest(
      [...tracking.handledCallIds.filter((id) => id !== nativeCallId), nativeCallId],
      MAX_TASK_TOOL_HANDLED_CALL_IDS,
    ),
  };
}

interface ReduceResult {
  readonly tasks: TaskItem[];
  readonly tracking: ThreadTaskTracking;
}

function applyTaskCreate(
  tasks: TaskItem[],
  tracking: ThreadTaskTracking,
  input: UnknownRecord | undefined,
  output: UnknownRecord | undefined,
  nativeCallId: string,
  turnId: TurnId | null,
): ReduceResult {
  const task = asRecord(output?.task);
  const id = asNonEmptyString(task?.id);
  const subject = asNonEmptyString(input?.subject) ?? asNonEmptyString(task?.subject);
  if (!id || !subject) {
    return { tasks, tracking: markSyncRequired(tracking, "A created task had no id or subject.") };
  }
  if (tasks.some((existing) => existing.id === id)) {
    return {
      tasks,
      tracking: markSyncRequired(tracking, `Task ${id} was created twice.`),
    };
  }
  if (tasks.length >= MAX_THREAD_TASKS) {
    return {
      tasks,
      tracking: withSync(tracking, "overflow", `More than ${MAX_THREAD_TASKS} tasks.`),
    };
  }
  const description = boundedDescription(input?.description);
  const created: TaskItem = {
    id,
    content: subject,
    activeForm: asNonEmptyString(input?.activeForm) ?? subject,
    status: "pending",
    ...(description ? { description } : {}),
  };
  return {
    tasks: [...tasks, created],
    tracking: {
      ...tracking,
      provenance: keepNewest(
        [
          ...tracking.provenance.filter((entry) => entry.taskId !== id),
          { taskId: id, nativeCallId, turnId },
        ],
        MAX_THREAD_TASKS,
      ),
    },
  };
}

function applyTaskUpdate(
  tasks: TaskItem[],
  tracking: ThreadTaskTracking,
  input: UnknownRecord | undefined,
  output: UnknownRecord | undefined,
): ReduceResult {
  const id = asNonEmptyString(input?.taskId) ?? asNonEmptyString(output?.taskId);
  if (!id) {
    return { tasks, tracking: markSyncRequired(tracking, "A task update had no task id.") };
  }
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) {
    // Tasks from reverted turns still exist natively; updates to them are expected noise.
    if (tracking.suppressedTaskIds.includes(id)) return { tasks, tracking };
    return { tasks, tracking: markSyncRequired(tracking, `Task ${id} is not in F5's list.`) };
  }
  if (input?.status === "deleted") {
    return {
      tasks: tasks.filter((task) => task.id !== id),
      tracking: {
        ...tracking,
        provenance: tracking.provenance.filter((entry) => entry.taskId !== id),
      },
    };
  }
  const current = tasks[index]!;
  const subject = asNonEmptyString(input?.subject);
  const activeForm = asNonEmptyString(input?.activeForm);
  const status = asTaskStatus(input?.status);
  const description = boundedDescription(input?.description);
  const owner = asNonEmptyString(input?.owner);
  const addBlocks = asIdList(input?.addBlocks);
  const addBlockedBy = asIdList(input?.addBlockedBy);
  const updated: TaskItem = {
    ...current,
    ...(subject ? { content: subject } : {}),
    ...(activeForm ? { activeForm } : {}),
    ...(status ? { status } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(owner ? { owner } : {}),
    ...(addBlocks?.length
      ? { blocks: [...new Set([...(current.blocks ?? []), ...addBlocks])] }
      : {}),
    ...(addBlockedBy?.length
      ? { blockedBy: [...new Set([...(current.blockedBy ?? []), ...addBlockedBy])] }
      : {}),
  };
  const next = [...tasks];
  next[index] = updated;
  return { tasks: next, tracking };
}

/**
 * TaskList is the authoritative full list: tasks missing from it were deleted
 * natively. Fields the read omits (description, activeForm, blocks, and owner
 * when absent) are preserved from the previous snapshot.
 */
function applyTaskList(
  tasks: TaskItem[],
  tracking: ThreadTaskTracking,
  output: UnknownRecord | undefined,
): ReduceResult {
  if (!Array.isArray(output?.tasks)) {
    return { tasks, tracking: markSyncRequired(tracking, "A task list result was malformed.") };
  }
  const previous = new Map(tasks.map((task) => [task.id, task]));
  const suppressed = new Set(tracking.suppressedTaskIds);
  const next: TaskItem[] = [];
  const seen = new Set<string>();
  for (const value of output.tasks) {
    const entry = asRecord(value);
    const id = asNonEmptyString(entry?.id);
    const subject = asNonEmptyString(entry?.subject);
    const status = asTaskStatus(entry?.status);
    if (!id || !subject || !status) {
      return { tasks, tracking: markSyncRequired(tracking, "A task list entry was malformed.") };
    }
    if (suppressed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const owner = asNonEmptyString(entry?.owner);
    const blockedBy = asIdList(entry?.blockedBy);
    const existing: TaskItem = previous.get(id) ?? {
      id,
      content: subject,
      activeForm: subject,
      status,
    };
    next.push({
      ...existing,
      content: subject,
      status,
      ...(owner ? { owner } : {}),
      ...(blockedBy ? { blockedBy } : {}),
    });
  }
  if (next.length > MAX_THREAD_TASKS) {
    return {
      tasks,
      tracking: withSync(tracking, "overflow", `More than ${MAX_THREAD_TASKS} tasks.`),
    };
  }
  const retained = new Set(next.map((task) => task.id));
  return {
    tasks: next,
    tracking: withSync(
      {
        ...tracking,
        provenance: tracking.provenance.filter((entry) => retained.has(entry.taskId)),
      },
      "synced",
    ),
  };
}

function applyTaskGet(
  tasks: TaskItem[],
  tracking: ThreadTaskTracking,
  input: UnknownRecord | undefined,
  output: UnknownRecord | undefined,
): ReduceResult {
  const requestedId = asNonEmptyString(input?.taskId);
  if (output?.task === null) {
    if (!requestedId) return { tasks, tracking };
    return {
      tasks: tasks.filter((task) => task.id !== requestedId),
      tracking: {
        ...tracking,
        provenance: tracking.provenance.filter((entry) => entry.taskId !== requestedId),
      },
    };
  }
  const task = asRecord(output?.task);
  const id = asNonEmptyString(task?.id);
  const subject = asNonEmptyString(task?.subject);
  const status = asTaskStatus(task?.status);
  if (!id || !subject || !status) {
    return { tasks, tracking: markSyncRequired(tracking, "A task read result was malformed.") };
  }
  if (tracking.suppressedTaskIds.includes(id)) return { tasks, tracking };
  const index = tasks.findIndex((existing) => existing.id === id);
  const description = boundedDescription(task?.description);
  const blocks = asIdList(task?.blocks);
  const blockedBy = asIdList(task?.blockedBy);
  const fields = {
    content: subject,
    status,
    ...(description !== undefined ? { description } : {}),
    ...(blocks ? { blocks } : {}),
    ...(blockedBy ? { blockedBy } : {}),
  };
  if (index >= 0) {
    const next = [...tasks];
    next[index] = { ...tasks[index]!, ...fields };
    return { tasks: next, tracking };
  }
  if (tasks.length >= MAX_THREAD_TASKS) {
    return {
      tasks,
      tracking: withSync(tracking, "overflow", `More than ${MAX_THREAD_TASKS} tasks.`),
    };
  }
  // The task exists natively but F5 missed its creation: add it from the read.
  return {
    tasks: [...tasks, { id, activeForm: subject, ...fields }],
    tracking: markSyncRequired(tracking, `Task ${id} was missing from F5's list.`),
  };
}

/**
 * Reduce one Task tool lifecycle event. Returns `undefined` when nothing
 * changes, so callers dispatch only real updates. Idempotent per native call
 * id: duplicates and replays are ignored.
 */
export function reduceTaskToolLifecycle(
  state: TaskToolState,
  input: TaskToolLifecycleInput,
): ReduceResult | undefined {
  const base = state.tracking ?? emptyTaskToolTracking();
  const { nativeCallId } = input;
  if (base.handledCallIds.includes(nativeCallId)) return undefined;

  if (input.phase === "started") {
    if (base.pendingCalls.some((call) => call.nativeCallId === nativeCallId)) return undefined;
    if (base.invalidatedCallIds.includes(nativeCallId)) return undefined;
    if (base.pendingCalls.length >= MAX_TASK_TOOL_PENDING_CALLS) {
      if (base.syncState === "overflow") return undefined;
      return {
        tasks: [...state.tasks],
        tracking: withSync(
          base,
          "overflow",
          `More than ${MAX_TASK_TOOL_PENDING_CALLS} task tool calls are unresolved.`,
        ),
      };
    }
    return {
      tasks: [...state.tasks],
      tracking: {
        ...base,
        pendingCalls: [
          ...base.pendingCalls,
          {
            nativeCallId,
            toolName: input.toolName,
            generation: base.generation,
            turnId: input.turnId,
          },
        ],
      },
    };
  }

  // A result for a call invalidated by revert belongs to discarded work.
  if (base.invalidatedCallIds.includes(nativeCallId)) {
    return {
      tasks: [...state.tasks],
      tracking: resolveCall(
        {
          ...base,
          invalidatedCallIds: base.invalidatedCallIds.filter((id) => id !== nativeCallId),
        },
        nativeCallId,
      ),
    };
  }

  const pending = base.pendingCalls.find((call) => call.nativeCallId === nativeCallId);
  if (input.phase === "abandoned") {
    if (!pending) return undefined;
    // Release the pending slot; the call may still have run natively.
    return {
      tasks: [...state.tasks],
      tracking: markSyncRequired(
        resolveCall(base, nativeCallId),
        `A ${input.toolName} call ended without a result.`,
      ),
    };
  }

  const { completion } = input;
  let tracking = base;
  if (pending && pending.generation !== base.generation) {
    return { tasks: [...state.tasks], tracking: resolveCall(base, nativeCallId) };
  }
  if (!pending) {
    tracking = markSyncRequired(tracking, "A task tool result arrived without its call.");
  }
  const sessionId = completion.nativeSessionId ?? null;
  if (sessionId && tracking.nativeSessionId && tracking.nativeSessionId !== sessionId) {
    // A new native session has its own task list; F5's snapshot may be stale.
    tracking = markSyncRequired(tracking, "The provider session changed.");
  }
  if (sessionId) tracking = { ...tracking, nativeSessionId: sessionId };
  tracking = resolveCall(tracking, nativeCallId);

  if (!completion.semanticSuccess) {
    return { tasks: [...state.tasks], tracking };
  }
  if (completion.outputOmission || completion.inputOmission) {
    return {
      tasks: [...state.tasks],
      tracking: markSyncRequired(
        tracking,
        `A ${input.toolName} result was not retained (${completion.outputOmission?.reason ?? completion.inputOmission?.reason}).`,
      ),
    };
  }

  const toolInput = asRecord(completion.input);
  const output = asRecord(completion.structuredOutput);
  const tasks = [...state.tasks];
  switch (input.toolName) {
    case "TaskCreate":
      return applyTaskCreate(
        tasks,
        tracking,
        toolInput,
        output,
        nativeCallId,
        pending?.turnId ?? input.turnId,
      );
    case "TaskUpdate":
      return applyTaskUpdate(tasks, tracking, toolInput, output);
    case "TaskList":
      return applyTaskList(tasks, tracking, output);
    case "TaskGet":
      return applyTaskGet(tasks, tracking, toolInput, output);
  }
}

/**
 * Apply a revert or checkpoint restore atomically: bump the generation,
 * invalidate unresolved calls, drop and suppress tasks created in discarded
 * turns so a later TaskList cannot resurrect them. `retainedTurnIds`
 * undefined means unknown, so every attributed task is treated as discarded.
 * Threads without tracking (TodoWrite) keep the previous behavior: clear.
 */
export function revertTaskToolState(
  state: TaskToolState,
  retainedTurnIds: ReadonlySet<string> | undefined,
): TaskToolState {
  const tracking = state.tracking;
  if (!tracking) return { tasks: [], tracking: null };
  const isRetained = (turnId: string | null) =>
    turnId !== null && retainedTurnIds !== undefined && retainedTurnIds.has(turnId);
  const discarded = new Set(
    tracking.provenance.filter((entry) => !isRetained(entry.turnId)).map((entry) => entry.taskId),
  );
  const tasks = state.tasks.filter((task) => !discarded.has(task.id));
  const next: ThreadTaskTracking = {
    ...tracking,
    generation: tracking.generation + 1,
    pendingCalls: [],
    invalidatedCallIds: keepNewest(
      [...tracking.invalidatedCallIds, ...tracking.pendingCalls.map((call) => call.nativeCallId)],
      MAX_INVALIDATED_CALL_IDS,
    ),
    provenance: tracking.provenance.filter((entry) => !discarded.has(entry.taskId)),
    suppressedTaskIds: keepNewest(
      [...new Set([...tracking.suppressedTaskIds, ...discarded])],
      MAX_THREAD_TASKS,
    ),
  };
  // Statuses of retained tasks may have changed in discarded turns.
  return {
    tasks,
    tracking:
      tasks.length > 0 || state.tasks.length > 0
        ? markSyncRequired(next, "Tasks were reverted; they resync on the next task list read.")
        : next,
  };
}
