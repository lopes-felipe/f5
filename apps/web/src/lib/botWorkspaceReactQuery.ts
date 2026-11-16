/** Data helpers for the shelved Bots workspace; no active UI consumer. See PR #148. */
import {
  AgentBridgeGetTaskActivitiesResult as AgentBridgeGetTaskActivitiesResultSchema,
  AgentBridgeGetTasksResult as AgentBridgeGetTasksResultSchema,
  AgentBridgeState as AgentBridgeStateSchema,
  BotTask as BotTaskSchema,
  type AgentBridgeCreateTaskInput,
  type BotTask,
  type BotTaskStatus,
} from "@t3tools/contracts";
import {
  infiniteQueryOptions,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect } from "react";

import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { onServerWelcome } from "../wsNativeApi";

export const botWorkspaceQueryKeys = {
  all: ["bots"] as const,
  state: ["bots", "state"] as const,
  tasks: ["bots", "tasks"] as const,
  taskList: (clientId: string | null, statuses: ReadonlyArray<BotTaskStatus> | null) =>
    ["bots", "tasks", "list", clientId, statuses?.join(",") ?? "all"] as const,
  task: (taskId: string) => ["bots", "tasks", "detail", taskId] as const,
  activities: (taskId: string) => ["bots", "tasks", "activities", taskId] as const,
};

export const OPEN_TASK_STATUSES: ReadonlyArray<BotTaskStatus> = [
  "queued",
  "running",
  "waiting-for-user",
  "paused",
];

const decodeState = Schema.decodeUnknownSync(AgentBridgeStateSchema);
const decodeTasks = Schema.decodeUnknownSync(AgentBridgeGetTasksResultSchema);
const decodeTask = Schema.decodeUnknownSync(BotTaskSchema);
const decodeActivities = Schema.decodeUnknownSync(AgentBridgeGetTaskActivitiesResultSchema);

export function agentBridgeStateQueryOptions() {
  return queryOptions({
    queryKey: botWorkspaceQueryKeys.state,
    queryFn: async () => decodeState(await ensureNativeApi().agentBridge.getState()),
    staleTime: 30_000,
  });
}

export function botTasksQueryOptions(input: {
  readonly clientId: string | null;
  readonly statuses: ReadonlyArray<BotTaskStatus> | null;
}) {
  return infiniteQueryOptions({
    queryKey: botWorkspaceQueryKeys.taskList(input.clientId, input.statuses),
    queryFn: async ({ pageParam }) =>
      decodeTasks(
        await ensureNativeApi().agentBridge.getTasks({
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.statuses ? { statuses: [...input.statuses] } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30_000,
  });
}

export function botTaskQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: botWorkspaceQueryKeys.task(taskId),
    queryFn: async () => decodeTask(await ensureNativeApi().agentBridge.getTask(taskId)),
    staleTime: 30_000,
  });
}

export function botTaskActivitiesQueryOptions(taskId: string) {
  return infiniteQueryOptions({
    queryKey: botWorkspaceQueryKeys.activities(taskId),
    queryFn: async ({ pageParam }) =>
      decodeActivities(
        await ensureNativeApi().agentBridge.getTaskActivities({
          taskId,
          limit: 50,
          ...(pageParam !== null ? { beforeSequence: pageParam } : {}),
        }),
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (page) =>
      page.hasOlder && page.activities.length > 0
        ? (page.activities.at(-1)?.sequence ?? null)
        : null,
    staleTime: 30_000,
  });
}

/**
 * Refetches the workspace. A refetch reuses a first load that is still in
 * flight, and that load may predate the change, so cancel it first.
 */
export async function refreshBotWorkspace(queryClient: QueryClient) {
  await queryClient.cancelQueries({
    queryKey: botWorkspaceQueryKeys.all,
    predicate: (query) => query.state.data === undefined && query.state.fetchStatus === "fetching",
  });
  await queryClient.invalidateQueries({
    queryKey: botWorkspaceQueryKeys.all,
    refetchType: "active",
  });
}

/** Keeps the workspace fresh: on every bridge invalidation and after reconnecting. */
export function useBotWorkspaceInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.agentBridge) return;
    return api.agentBridge.onStateChanged(() => {
      void refreshBotWorkspace(queryClient);
    });
  }, [queryClient]);
  useEffect(
    () =>
      onServerWelcome(() => {
        void refreshBotWorkspace(queryClient);
      }),
    [queryClient],
  );
}

/** A fresh idempotency key per user action; a retry of the same action reuses it. */
export const newOperationId = () => `ui-${crypto.randomUUID()}`;

export async function createBotTask(
  queryClient: QueryClient,
  input: AgentBridgeCreateTaskInput,
): Promise<BotTask> {
  const task = decodeTask(await ensureNativeApi().agentBridge.createTask(input));
  await refreshBotWorkspace(queryClient);
  return task;
}

export async function replyToBotTask(
  queryClient: QueryClient,
  input: { taskId: string; questionId: string; expectedVersion: number; text: string },
): Promise<BotTask> {
  const task = decodeTask(
    await ensureNativeApi().agentBridge.replyToTask({ ...input, operationId: newOperationId() }),
  );
  await refreshBotWorkspace(queryClient);
  return task;
}

export async function controlBotTask(
  queryClient: QueryClient,
  action: "pause" | "resume" | "cancel",
  task: Pick<BotTask, "id" | "version">,
): Promise<BotTask> {
  const api = ensureNativeApi().agentBridge;
  const input = { operationId: newOperationId(), taskId: task.id, expectedVersion: task.version };
  const next = decodeTask(
    await (action === "pause"
      ? api.pauseTask(input)
      : action === "resume"
        ? api.resumeTask(input)
        : api.cancelTask(input)),
  );
  await refreshBotWorkspace(queryClient);
  return next;
}

/** "Last contact" freshness. Lost contact never changes a task's status. */
export function describeContact(lastContactAt: string | null, now: number): string {
  if (!lastContactAt) return "No contact yet";
  const minutes = Math.floor((now - Date.parse(lastContactAt)) / 60_000);
  if (minutes < 1) return "Last contact just now";
  if (minutes < 60) return `Last contact ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last contact ${hours} h ago`;
  return `Last contact ${Math.floor(hours / 24)} d ago`;
}

export const BOT_TASK_STATUS_LABELS: Record<BotTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  "waiting-for-user": "Needs your reply",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
