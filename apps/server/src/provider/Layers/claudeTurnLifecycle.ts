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
  pendingResult: SDKResultMessage | undefined;
  latestResult: SDKResultMessage | undefined;
  readonly seenResults: Set<string>;
  readonly terminalTasks: Set<string>;
}

export function createClaudeTurnLifecycle(): ClaudeTurnLifecycle {
  return {
    backgroundTasks: new Set(),
    hasBackgroundSnapshot: false,
    hasSessionState: false,
    pendingResult: undefined,
    latestResult: undefined,
    seenResults: new Set(),
    terminalTasks: new Set(),
  };
}

type LifecycleEvent =
  | { type: "background"; tasks: ReadonlyArray<{ task_id: string; ambient?: boolean }> }
  | { type: "task-started"; taskId: string }
  | { type: "task-completed"; taskId: string }
  | { type: "session"; state: "idle" | "running" | "requires_action" }
  | { type: "result"; result: SDKResultMessage }
  | { type: "parent-activity" | "turn-boundary" };

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > 256) set.delete(set.values().next().value!);
}

export function reduceClaudeTurnLifecycle(
  state: ClaudeTurnLifecycle,
  event: LifecycleEvent,
): SDKResultMessage | undefined {
  switch (event.type) {
    case "background":
      state.hasBackgroundSnapshot = true;
      state.backgroundTasks = new Set(
        event.tasks.filter((task) => !task.ambient).map((task) => task.task_id),
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
      return;
    case "session": {
      state.hasSessionState = true;
      if (event.state !== "idle") return;
      // Idle is authoritative even if a task bookend/snapshot was missed.
      const result = state.pendingResult;
      state.pendingResult = undefined;
      return result;
    }
    case "result":
      if (state.seenResults.has(event.result.uuid)) return;
      remember(state.seenResults, event.result.uuid);
      state.latestResult = event.result;
      state.pendingResult = event.result;
      if (state.hasSessionState || state.backgroundTasks.size > 0) return;
      state.pendingResult = undefined;
      return event.result;
  }
}
