import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Process-local activity, independent of task metadata/tool rendering. A result
 * can end a model segment while the SDK continues the same request in the
 * background. Only the reducer's returned result may settle the F5 turn.
 */
export interface ClaudeTurnLifecycle {
  backgroundTasks: Set<string>;
  hasBackgroundSnapshot: boolean;
  hasSessionState: boolean;
  awaitingAction: boolean;
  pendingResult: SDKResultMessage | undefined;
  latestResult: SDKResultMessage | undefined;
  usage: SDKResultMessage["usage"] | undefined;
  readonly seenResults: Set<string>;
  readonly terminalTasks: Set<string>;
}

export function createClaudeTurnLifecycle(): ClaudeTurnLifecycle {
  return {
    backgroundTasks: new Set(),
    hasBackgroundSnapshot: false,
    hasSessionState: false,
    awaitingAction: false,
    pendingResult: undefined,
    latestResult: undefined,
    usage: undefined,
    seenResults: new Set(),
    terminalTasks: new Set(),
  };
}

type LifecycleEvent =
  | {
      type: "background";
      tasks: ReadonlyArray<{ task_id: string; task_type?: string; ambient?: boolean }>;
    }
  | { type: "task-started"; taskId: string }
  | { type: "task-completed"; taskId: string }
  | { type: "session"; state: "idle" | "running" | "requires_action" }
  | { type: "result"; result: SDKResultMessage }
  | { type: "parent-activity" | "turn-boundary" };

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > 256) set.delete(set.values().next().value!);
}

/** Only delegated agents hold the parent request open; shells may run indefinitely. */
export function isClaudeAgentTask(taskType: string | undefined): boolean {
  return taskType === "local_agent" || taskType === "remote_agent";
}

/** Aggregate per-segment main-loop usage, never the cumulative modelUsage/cost fields. */
export function recordClaudeResult(state: ClaudeTurnLifecycle, result: SDKResultMessage): boolean {
  if (state.seenResults.has(result.uuid)) return false;
  remember(state.seenResults, result.uuid);
  if (result.usage) {
    const sum = (previous: unknown, current: unknown): unknown => {
      if (typeof current === "number")
        return (typeof previous === "number" ? previous : 0) + current;
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const before =
          previous && typeof previous === "object" ? (previous as Record<string, unknown>) : {};
        return {
          ...before,
          ...Object.fromEntries(
            Object.entries(current).map(([key, value]) => [key, sum(before[key], value)]),
          ),
        };
      }
      return current;
    };
    state.usage = sum(state.usage, result.usage) as SDKResultMessage["usage"];
  }
  return true;
}

export function reduceClaudeTurnLifecycle(
  state: ClaudeTurnLifecycle,
  event: LifecycleEvent,
): SDKResultMessage | undefined {
  switch (event.type) {
    case "background":
      state.hasBackgroundSnapshot = true;
      state.backgroundTasks = new Set(
        event.tasks
          .filter((task) => !task.ambient && isClaudeAgentTask(task.task_type))
          .map((task) => task.task_id),
      );
      return;
    case "task-started":
      if (!state.hasBackgroundSnapshot && !state.terminalTasks.has(event.taskId)) {
        state.backgroundTasks.add(event.taskId);
      }
      return;
    case "task-completed":
      remember(state.terminalTasks, event.taskId);
      if (!state.hasBackgroundSnapshot) state.backgroundTasks.delete(event.taskId);
      return;
    case "parent-activity":
      state.pendingResult = undefined;
      return;
    case "turn-boundary":
      state.pendingResult = undefined;
      state.latestResult = undefined;
      state.usage = undefined;
      state.awaitingAction = false;
      // Edge-only state cannot outlive its owning turn. Snapshots remain
      // process-wide and are replaced by the next SDK level signal.
      if (!state.hasBackgroundSnapshot) state.backgroundTasks.clear();
      return;
    case "session": {
      state.hasSessionState = true;
      state.awaitingAction = event.state === "requires_action";
      if (event.state !== "idle") return;
      // Idle is authoritative even if a task bookend/snapshot was missed.
      const result = state.pendingResult;
      state.pendingResult = undefined;
      return result;
    }
    case "result":
      if (!recordClaudeResult(state, event.result)) return;
      state.latestResult = event.result;
      state.pendingResult = event.result;
      if (state.hasSessionState || state.backgroundTasks.size > 0) return;
      state.pendingResult = undefined;
      return event.result;
  }
}
