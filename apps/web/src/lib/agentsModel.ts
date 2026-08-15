import type {
  AgentsSnapshot,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";

type UnknownRecord = Record<string, unknown>;

export interface AgentActivityThreadSource {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly hasOlderActivities: boolean;
}

export interface AgentActivityDetail {
  readonly key: string;
  readonly parentActivityId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly workItemIds: ReadonlyArray<string>;
  readonly subagentThreadId: string | null;
  readonly path: string | null;
  readonly type: string | null;
  readonly description: string | null;
  readonly prompt: string | null;
  readonly result: string | null;
  readonly model: string | null;
  readonly updatedAt: string;
}

export interface AgentActivityIndex {
  readonly entries: ReadonlyArray<AgentActivityDetail>;
  readonly byScopedWorkItemId: ReadonlyMap<string, AgentActivityDetail>;
  readonly coverageWindowLimited: boolean;
}

export interface AgentsPanelEntry {
  readonly id: string;
  readonly workItemIds: ReadonlyArray<string>;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly turnId: TurnId | null;
  readonly focusActivityId: string | null;
  readonly ownership: ThreadBackgroundWorkEntry["ownership"];
  readonly classification: ThreadBackgroundWorkEntry["classification"];
  readonly status: ThreadBackgroundWorkEntry["status"];
  readonly active: boolean;
  readonly provider: ThreadBackgroundWorkEntry["provider"];
  readonly model: string | null;
  readonly phase: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly outputTruncated: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AgentsPanelModel {
  readonly directEntries: ReadonlyArray<AgentsPanelEntry>;
  readonly workflowEntries: ReadonlyArray<AgentsPanelEntry>;
  readonly liveCount: number;
  readonly settledCount: number;
  readonly coverageWindowLimited: boolean;
  readonly generatedAt: string | null;
}

export const EMPTY_AGENTS_PANEL_MODEL: AgentsPanelModel = Object.freeze({
  directEntries: [],
  workflowEntries: [],
  liveCount: 0,
  settledCount: 0,
  coverageWindowLimited: false,
  generatedAt: null,
});

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function scopedWorkItemId(threadId: ThreadId, workItemId: string): string {
  return `${threadId}\u0000${workItemId}`;
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }
  if (left.sequence === undefined && right.sequence !== undefined) return -1;
  if (left.sequence !== undefined && right.sequence === undefined) return 1;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function newerValue<T>(
  current: AgentActivityDetail | undefined,
  updatedAt: string,
  value: T | null,
  select: (entry: AgentActivityDetail) => T | null,
): T | null {
  if (value !== null && (!current || updatedAt >= current.updatedAt)) return value;
  return current ? select(current) : null;
}

function mergeActivityDetail(
  current: AgentActivityDetail | undefined,
  input: Omit<AgentActivityDetail, "workItemIds"> & { readonly workItemIds: ReadonlyArray<string> },
): AgentActivityDetail {
  const workItemIds = [...new Set([...(current?.workItemIds ?? []), ...input.workItemIds])];
  const updatedAt =
    current && current.updatedAt > input.updatedAt ? current.updatedAt : input.updatedAt;
  return {
    key: input.key,
    parentActivityId: current?.parentActivityId ?? input.parentActivityId,
    threadId: input.threadId,
    turnId: newerValue(current, input.updatedAt, input.turnId, (entry) => entry.turnId),
    workItemIds,
    subagentThreadId: newerValue(
      current,
      input.updatedAt,
      input.subagentThreadId,
      (entry) => entry.subagentThreadId,
    ),
    path: newerValue(current, input.updatedAt, input.path, (entry) => entry.path),
    type: newerValue(current, input.updatedAt, input.type, (entry) => entry.type),
    description: newerValue(
      current,
      input.updatedAt,
      input.description,
      (entry) => entry.description,
    ),
    prompt: newerValue(current, input.updatedAt, input.prompt, (entry) => entry.prompt),
    result: newerValue(current, input.updatedAt, input.result, (entry) => entry.result),
    model: newerValue(current, input.updatedAt, input.model, (entry) => entry.model),
    updatedAt,
  };
}

export function buildAgentActivityIndex(
  threads: ReadonlyArray<AgentActivityThreadSource>,
): AgentActivityIndex {
  const detailsByKey = new Map<string, AgentActivityDetail>();
  const byScopedWorkItemId = new Map<string, AgentActivityDetail>();

  for (const thread of threads) {
    const parentActivityIdByWorkItemId = new Map<string, string>();
    const parentActivityIdBySubagentThreadId = new Map<string, string>();
    const ordered = [...thread.activities].toSorted(compareActivities);

    const upsert = (input: {
      readonly activity: OrchestrationThreadActivity;
      readonly parentActivityId: string;
      readonly workItemIds: ReadonlyArray<string>;
      readonly subagentThreadId: string | null;
      readonly path: string | null;
      readonly type: string | null;
      readonly description: string | null;
      readonly prompt: string | null;
      readonly result: string | null;
      readonly model: string | null;
    }) => {
      const key = `${thread.threadId}:${input.parentActivityId}:${input.subagentThreadId ?? 0}`;
      const detail = mergeActivityDetail(detailsByKey.get(key), {
        key,
        parentActivityId: input.parentActivityId,
        threadId: thread.threadId,
        turnId: input.activity.turnId ?? null,
        workItemIds: input.workItemIds,
        subagentThreadId: input.subagentThreadId,
        path: input.path,
        type: input.type,
        description: input.description,
        prompt: input.prompt,
        result: input.result,
        model: input.model,
        updatedAt: input.activity.createdAt,
      });
      detailsByKey.set(key, detail);
      for (const workItemId of detail.workItemIds) {
        byScopedWorkItemId.set(scopedWorkItemId(thread.threadId, workItemId), detail);
      }
    };

    for (const activity of ordered) {
      const payload = asRecord(activity.payload);
      const tool = readToolActivityPayload(activity.payload);
      const taskId = asTrimmedString(payload?.taskId);
      const providerItemId = tool?.providerItemId ?? null;
      const subagentThreadId = tool?.subagentThreadId ?? null;
      const receiverThreadIds = tool?.subagentReceiverThreadIds ?? [];

      if (activity.kind !== "subagent.activity") {
        const parentWorkItemId = taskId ?? providerItemId;
        if (parentWorkItemId) {
          parentActivityIdByWorkItemId.set(
            parentWorkItemId,
            parentActivityIdByWorkItemId.get(parentWorkItemId) ?? activity.id,
          );
        }
        for (const receiverThreadId of receiverThreadIds) {
          parentActivityIdBySubagentThreadId.set(receiverThreadId, activity.id);
        }
      }

      const isTaskActivity = activity.kind.startsWith("task.") && taskId !== null;
      const isSubagentActivity = activity.kind === "subagent.activity";
      const isCollaborationActivity = tool?.itemType === "collab_agent_tool_call";
      if (!isTaskActivity && !isSubagentActivity && !isCollaborationActivity) continue;

      if (receiverThreadIds.length > 1 && activity.kind !== "subagent.activity") {
        for (const receiverThreadId of receiverThreadIds) {
          const parentActivityId =
            parentActivityIdByWorkItemId.get(taskId ?? providerItemId ?? "") ?? activity.id;
          upsert({
            activity,
            parentActivityId,
            workItemIds: [...(taskId ? [taskId] : []), `subagent:${receiverThreadId}`],
            subagentThreadId: receiverThreadId,
            path: tool?.subagentPath ?? null,
            type: tool?.subagentType ?? null,
            description: tool?.subagentDescription ?? null,
            prompt: tool?.subagentPrompt ?? null,
            result: tool?.subagentResult ?? null,
            model: tool?.subagentModel ?? null,
          });
        }
        continue;
      }

      const resolvedSubagentThreadId = subagentThreadId ?? receiverThreadIds[0] ?? null;
      const primaryWorkItemId = taskId ?? providerItemId;
      const parentActivityId =
        (resolvedSubagentThreadId
          ? parentActivityIdBySubagentThreadId.get(resolvedSubagentThreadId)
          : undefined) ??
        (primaryWorkItemId ? parentActivityIdByWorkItemId.get(primaryWorkItemId) : undefined) ??
        activity.id;
      const aliases = [
        ...(taskId ? [taskId] : []),
        ...(providerItemId ? [providerItemId] : []),
        ...(resolvedSubagentThreadId ? [`subagent:${resolvedSubagentThreadId}`] : []),
      ];
      upsert({
        activity,
        parentActivityId,
        workItemIds: aliases.length > 0 ? aliases : [activity.id],
        subagentThreadId: resolvedSubagentThreadId,
        path: tool?.subagentPath ?? null,
        type: tool?.subagentType ?? asTrimmedString(payload?.taskType),
        description: tool?.subagentDescription ?? asTrimmedString(payload?.detail),
        prompt: tool?.subagentPrompt ?? null,
        result:
          tool?.subagentResult ??
          (activity.kind === "task.completed" ? asTrimmedString(payload?.detail) : null),
        model: tool?.subagentModel ?? null,
      });
    }
  }

  return {
    entries: [...detailsByKey.values()],
    byScopedWorkItemId,
    coverageWindowLimited: threads.some((thread) => thread.hasOlderActivities),
  };
}

function chooseSnapshotEntry(
  current: ThreadBackgroundWorkEntry | undefined,
  next: ThreadBackgroundWorkEntry,
): ThreadBackgroundWorkEntry {
  if (!current) return next;
  const preferred =
    current.active !== next.active
      ? next.active
        ? next
        : current
      : next.updatedAt >= current.updatedAt
        ? next
        : current;
  const fallback = preferred === next ? current : next;
  return {
    ...preferred,
    active: current.active || next.active,
    ownership:
      current.ownership === "workflow" || next.ownership === "workflow"
        ? "workflow"
        : "direct-subagent",
    classification:
      preferred.classification === "inert" && fallback.classification !== "inert"
        ? fallback.classification
        : preferred.classification,
    turnId: preferred.turnId ?? fallback.turnId,
    providerInstanceId: preferred.providerInstanceId ?? fallback.providerInstanceId,
    providerSessionIdentity: preferred.providerSessionIdentity ?? fallback.providerSessionIdentity,
    model: preferred.model ?? fallback.model,
    phase: preferred.phase ?? fallback.phase,
    latestOutput: preferred.latestOutput ?? fallback.latestOutput,
    outputTruncated: preferred.outputTruncated || fallback.outputTruncated,
  };
}

function isLiveEntry(entry: Pick<AgentsPanelEntry, "active" | "classification" | "status">) {
  return (
    entry.active &&
    entry.classification !== "inert" &&
    (entry.status === "running" || entry.status === "monitoring")
  );
}

function panelEntryTitle(
  entry: ThreadBackgroundWorkEntry,
  detail: AgentActivityDetail | undefined,
): string {
  return (
    detail?.description ??
    detail?.path ??
    detail?.type ??
    entry.phase ??
    (entry.ownership === "workflow" ? "Workflow work" : "Subagent")
  );
}

export function deriveAgentsPanelModel(input: {
  readonly snapshot: AgentsSnapshot | null;
  readonly activityIndex: AgentActivityIndex;
  readonly threads: ReadonlyArray<AgentActivityThreadSource>;
}): AgentsPanelModel {
  if (!input.snapshot) {
    return input.activityIndex.coverageWindowLimited
      ? { ...EMPTY_AGENTS_PANEL_MODEL, coverageWindowLimited: true }
      : EMPTY_AGENTS_PANEL_MODEL;
  }

  const threadById = new Map(input.threads.map((thread) => [thread.threadId, thread] as const));
  const grouped = new Map<
    string,
    {
      entry: ThreadBackgroundWorkEntry;
      detail: AgentActivityDetail | undefined;
      workItemIds: Set<string>;
      outputTruncated: boolean;
      startedAt: string;
      completedAt: string | null;
    }
  >();

  for (const entry of input.snapshot.entries) {
    const detail = input.activityIndex.byScopedWorkItemId.get(
      scopedWorkItemId(entry.threadId, entry.workItemId),
    );
    const id = detail?.key ?? scopedWorkItemId(entry.threadId, entry.workItemId);
    const current = grouped.get(id);
    const selected = chooseSnapshotEntry(current?.entry, entry);
    grouped.set(id, {
      entry: selected,
      detail: detail ?? current?.detail,
      workItemIds: new Set([...(current?.workItemIds ?? []), entry.workItemId]),
      outputTruncated: (current?.outputTruncated ?? false) || entry.outputTruncated,
      startedAt:
        current && current.startedAt < entry.startedAt ? current.startedAt : entry.startedAt,
      completedAt:
        current?.completedAt && entry.completedAt
          ? current.completedAt > entry.completedAt
            ? current.completedAt
            : entry.completedAt
          : (current?.completedAt ?? entry.completedAt),
    });
  }

  const entries = [...grouped.entries()]
    .map(([id, group]): AgentsPanelEntry => {
      const thread = threadById.get(group.entry.threadId);
      return {
        id,
        workItemIds: [...group.workItemIds],
        threadId: group.entry.threadId,
        threadTitle: thread?.threadTitle ?? "Unknown thread",
        projectName: thread?.projectName ?? null,
        turnId: group.entry.turnId ?? group.detail?.turnId ?? null,
        focusActivityId: group.detail?.parentActivityId ?? null,
        ownership: group.entry.ownership,
        classification: group.entry.classification,
        status: group.entry.status,
        active: group.entry.active,
        provider: group.entry.provider,
        model: group.entry.model ?? group.detail?.model ?? null,
        phase: group.entry.phase ?? group.detail?.type ?? null,
        title: panelEntryTitle(group.entry, group.detail),
        detail: group.entry.latestOutput ?? group.detail?.result ?? group.detail?.prompt ?? null,
        outputTruncated: group.outputTruncated,
        startedAt: group.startedAt,
        updatedAt: group.entry.updatedAt,
        completedAt: group.completedAt,
      };
    })
    .toSorted((left, right) => {
      const liveOrder = Number(isLiveEntry(right)) - Number(isLiveEntry(left));
      return (
        liveOrder ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id)
      );
    });

  return {
    directEntries: entries.filter((entry) => entry.ownership === "direct-subagent"),
    workflowEntries: entries.filter((entry) => entry.ownership === "workflow"),
    liveCount: entries.filter(isLiveEntry).length,
    settledCount: entries.filter((entry) => !isLiveEntry(entry)).length,
    coverageWindowLimited: input.activityIndex.coverageWindowLimited,
    generatedAt: input.snapshot.generatedAt,
  };
}
