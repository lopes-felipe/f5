import { formatSubagentDisplayTitle } from "@t3tools/shared/subagentDisplay";
import type {
  AgentsSnapshot,
  ProviderInstanceId,
  BackgroundWorkKind,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  readToolActivityPayload,
  REASONING_STATUS_ACTIVITY_KIND,
} from "@t3tools/shared/orchestrationActivityPayload";

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
  readonly parentActivityId: string | null;
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
  readonly kind: BackgroundWorkKind;
  readonly classification: ThreadBackgroundWorkEntry["classification"];
  readonly status: ThreadBackgroundWorkEntry["status"];
  readonly active: boolean;
  /** Running or monitoring work that is still alive. */
  readonly live: boolean;
  readonly provider: ThreadBackgroundWorkEntry["provider"];
  readonly providerInstanceId?: ProviderInstanceId | null;
  readonly model: string | null;
  /** Effective effort reported by this agent, independent of its parent's current selection. */
  readonly effort?: string | null;
  /** Task or subagent type recorded at start. */
  readonly phase: string | null;
  readonly title: string;
  readonly prompt: string | null;
  readonly lastTool: string | null;
  /** Latest output, or the result once settled. */
  readonly detail: string | null;
  readonly outputTruncated: boolean;
  /** Durable work item addressed by native stop and inspect operations. */
  readonly nativeWorkItemId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AgentsPanelThreadGroup {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly agents: ReadonlyArray<AgentsPanelEntry>;
  readonly backgroundTasks: ReadonlyArray<AgentsPanelEntry>;
  readonly liveCount: number;
  readonly updatedAt: string;
}

export interface AgentsPanelModel {
  /** Delegated agents and workflow work. */
  readonly agents: ReadonlyArray<AgentsPanelEntry>;
  /** Background shells and monitors. */
  readonly backgroundTasks: ReadonlyArray<AgentsPanelEntry>;
  /** Entries grouped by thread, threads with live work first. */
  readonly threads: ReadonlyArray<AgentsPanelThreadGroup>;
  readonly liveCount: number;
  readonly settledCount: number;
  readonly generatedAt: string | null;
}

export const EMPTY_AGENTS_PANEL_MODEL: AgentsPanelModel = Object.freeze({
  agents: [],
  backgroundTasks: [],
  threads: [],
  liveCount: 0,
  settledCount: 0,
  generatedAt: null,
});

export type AgentsStatusFilter = "all" | "running" | "failed" | "done";

export interface AgentsPanelFilter {
  readonly query: string;
  readonly status: AgentsStatusFilter;
}

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

function isTimelineFocusableActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind !== "tool.started" &&
    activity.kind !== "task.started" &&
    activity.kind !== "task.completed" &&
    activity.kind !== "runtime.configured" &&
    activity.kind !== REASONING_STATUS_ACTIVITY_KIND &&
    activity.kind !== "account.updated" &&
    activity.kind !== "account.rate-limits.updated"
  );
}

function scopedWorkItemId(threadId: ThreadId, workItemId: string): string {
  return `${threadId}\u0000${workItemId}`;
}

function compareTimestamps(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? leftMs - rightMs
    : left.localeCompare(right);
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
  return compareTimestamps(left.createdAt, right.createdAt) || left.id.localeCompare(right.id);
}

function newerValue<T>(
  current: AgentActivityDetail | undefined,
  updatedAt: string,
  value: T | null,
  select: (entry: AgentActivityDetail) => T | null,
): T | null {
  if (value !== null && (!current || compareTimestamps(updatedAt, current.updatedAt) >= 0)) {
    return value;
  }
  return current ? select(current) : null;
}

function mergeActivityDetail(
  current: AgentActivityDetail | undefined,
  input: Omit<AgentActivityDetail, "workItemIds"> & { readonly workItemIds: ReadonlyArray<string> },
): AgentActivityDetail {
  const workItemIds = [...new Set([...(current?.workItemIds ?? []), ...input.workItemIds])];
  const updatedAt =
    current && compareTimestamps(current.updatedAt, input.updatedAt) > 0
      ? current.updatedAt
      : input.updatedAt;
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
      readonly parentActivityId: string | null;
      readonly workItemIds: ReadonlyArray<string>;
      readonly subagentThreadId: string | null;
      readonly path: string | null;
      readonly type: string | null;
      readonly description: string | null;
      readonly prompt: string | null;
      readonly result: string | null;
      readonly model: string | null;
    }) => {
      const key = `${thread.threadId}\u0000${input.parentActivityId ?? input.workItemIds[0] ?? input.activity.id}\u0000${input.subagentThreadId ?? 0}`;
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

      if (activity.kind !== "subagent.activity" && isTimelineFocusableActivity(activity)) {
        const parentWorkItemId = taskId ?? providerItemId;
        if (parentWorkItemId) {
          parentActivityIdByWorkItemId.set(parentWorkItemId, activity.id);
        }
        for (const receiverThreadId of receiverThreadIds) {
          parentActivityIdBySubagentThreadId.set(receiverThreadId, activity.id);
        }
      }

      const isTaskActivity = activity.kind.startsWith("task.") && taskId !== null;
      const isSubagentActivity = activity.kind === "subagent.activity";
      const isCollaborationActivity = tool?.itemType === "collab_agent_tool_call";
      if (!isTaskActivity && !isSubagentActivity && !isCollaborationActivity) continue;
      if (activity.kind === "tool.started") continue;

      if (receiverThreadIds.length > 1 && activity.kind !== "subagent.activity") {
        for (const receiverThreadId of receiverThreadIds) {
          const parentActivityId =
            parentActivityIdByWorkItemId.get(taskId ?? providerItemId ?? "") ?? null;
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
            model: tool?.subagentModel ?? asTrimmedString(payload?.model),
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
        (isTimelineFocusableActivity(activity) ? activity.id : null);
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
        model: tool?.subagentModel ?? asTrimmedString(payload?.model),
      });
    }
  }

  return {
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
      : compareTimestamps(next.updatedAt, current.updatedAt) >= 0
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
    kind: current.kind === "workflow" || next.kind === "workflow" ? "workflow" : preferred.kind,
    classification:
      preferred.classification === "inert" && fallback.classification !== "inert"
        ? fallback.classification
        : preferred.classification,
    turnId: preferred.turnId ?? fallback.turnId,
    providerInstanceId: preferred.providerInstanceId ?? fallback.providerInstanceId,
    providerSessionIdentity: preferred.providerSessionIdentity ?? fallback.providerSessionIdentity,
    model: preferred.model ?? fallback.model,
    phase: preferred.phase ?? fallback.phase,
    title: preferred.title ?? fallback.title,
    prompt: preferred.prompt ?? fallback.prompt,
    lastTool: preferred.lastTool ?? fallback.lastTool,
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

const KNOWN_TYPE_LABELS: Readonly<Record<string, string>> = {
  local_bash: "shell",
  shell: "shell",
  monitor: "monitor",
  monitor_mcp: "monitor",
  local_agent: "agent",
  remote_agent: "remote agent",
  local_workflow: "workflow",
};

const KNOWN_TYPE_TITLES: Readonly<Record<string, string>> = {
  local_bash: "Shell command",
  shell: "Shell command",
  monitor: "Monitor",
  monitor_mcp: "MCP monitor",
  local_agent: "Subagent",
  remote_agent: "Remote agent",
  local_workflow: "Workflow",
};

/** Short badge label for a task or subagent type (`local_bash` → `shell`). */
export function agentTypeLabel(phase: string | null): string | null {
  if (!phase) return null;
  return KNOWN_TYPE_LABELS[phase] ?? phase;
}

function humanizeType(phase: string | null): string | null {
  if (!phase) return null;
  const known = KNOWN_TYPE_TITLES[phase];
  if (known) return known;
  const words = phase.replace(/[_-]+/g, " ").trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function panelEntryTitle(
  entry: ThreadBackgroundWorkEntry,
  detail: AgentActivityDetail | undefined,
): string {
  const title =
    asTrimmedString(entry.title) ??
    detail?.description ??
    detail?.path ??
    humanizeType(entry.phase ?? detail?.type ?? null) ??
    (entry.kind === "workflow" ? "Workflow work" : "Subagent");
  return entry.kind === "agent" ? formatSubagentDisplayTitle(title) : title;
}

function matchesStatus(entry: AgentsPanelEntry, status: AgentsStatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "running":
      return entry.live;
    case "failed":
      return !entry.live && entry.status === "failed";
    case "done":
      return !entry.live && entry.status !== "failed";
  }
}

function matchesQuery(entry: AgentsPanelEntry, query: string): boolean {
  if (query.length === 0) return true;
  return [
    entry.title,
    entry.prompt,
    entry.detail,
    entry.phase,
    entry.lastTool,
    entry.threadTitle,
    entry.projectName,
  ].some((value) => value?.toLowerCase().includes(query) === true);
}

/** Counts per status chip for entries that already match the search query. */
export function countAgentsByStatus(
  entries: ReadonlyArray<AgentsPanelEntry>,
): Readonly<Record<AgentsStatusFilter, number>> {
  const counts = { all: entries.length, running: 0, failed: 0, done: 0 };
  for (const entry of entries) {
    if (matchesStatus(entry, "running")) counts.running += 1;
    else if (matchesStatus(entry, "failed")) counts.failed += 1;
    else counts.done += 1;
  }
  return counts;
}

export function filterAgentsPanelEntries(
  entries: ReadonlyArray<AgentsPanelEntry>,
  filter: AgentsPanelFilter,
): ReadonlyArray<AgentsPanelEntry> {
  const query = filter.query.trim().toLowerCase();
  if (query.length === 0 && filter.status === "all") return entries;
  return entries.filter(
    (entry) => matchesQuery(entry, query) && matchesStatus(entry, filter.status),
  );
}

function compareEntries(left: AgentsPanelEntry, right: AgentsPanelEntry): number {
  return (
    Number(right.live) - Number(left.live) ||
    compareTimestamps(right.updatedAt, left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Rebuilds the sections and thread groups from an ordered list of entries. */
export function buildAgentsPanelModel(
  entries: ReadonlyArray<AgentsPanelEntry>,
  generatedAt: string | null,
): AgentsPanelModel {
  const ordered = entries.toSorted(compareEntries);
  const groups = new Map<
    ThreadId,
    {
      threadId: ThreadId;
      threadTitle: string;
      projectName: string | null;
      agents: AgentsPanelEntry[];
      backgroundTasks: AgentsPanelEntry[];
      liveCount: number;
      updatedAt: string;
    }
  >();
  for (const entry of ordered) {
    let group = groups.get(entry.threadId);
    if (!group) {
      group = {
        threadId: entry.threadId,
        threadTitle: entry.threadTitle,
        projectName: entry.projectName,
        agents: [],
        backgroundTasks: [],
        liveCount: 0,
        updatedAt: entry.updatedAt,
      };
      groups.set(entry.threadId, group);
    }
    (entry.kind === "shell" ? group.backgroundTasks : group.agents).push(entry);
    if (entry.live) group.liveCount += 1;
    if (compareTimestamps(entry.updatedAt, group.updatedAt) > 0) group.updatedAt = entry.updatedAt;
  }
  const liveCount = ordered.filter((entry) => entry.live).length;
  return {
    agents: ordered.filter((entry) => entry.kind !== "shell"),
    backgroundTasks: ordered.filter((entry) => entry.kind === "shell"),
    threads: [...groups.values()].toSorted(
      (left, right) =>
        Number(right.liveCount > 0) - Number(left.liveCount > 0) ||
        compareTimestamps(right.updatedAt, left.updatedAt) ||
        left.threadId.localeCompare(right.threadId),
    ),
    liveCount,
    settledCount: ordered.length - liveCount,
    generatedAt,
  };
}

export function deriveAgentsPanelModel(input: {
  readonly snapshot: AgentsSnapshot | null;
  readonly activityIndex: AgentActivityIndex;
  readonly threads: ReadonlyArray<AgentActivityThreadSource>;
}): AgentsPanelModel {
  if (!input.snapshot) return EMPTY_AGENTS_PANEL_MODEL;

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
        current && compareTimestamps(current.startedAt, entry.startedAt) < 0
          ? current.startedAt
          : entry.startedAt,
      completedAt:
        current?.completedAt && entry.completedAt
          ? compareTimestamps(current.completedAt, entry.completedAt) > 0
            ? current.completedAt
            : entry.completedAt
          : (current?.completedAt ?? entry.completedAt),
    });
  }

  const entries = [...grouped.entries()].map(([id, group]): AgentsPanelEntry => {
    const thread = threadById.get(group.entry.threadId);
    const prompt = asTrimmedString(group.entry.prompt) ?? group.detail?.prompt ?? null;
    return {
      id,
      workItemIds: [...group.workItemIds],
      threadId: group.entry.threadId,
      threadTitle: thread?.threadTitle ?? "Unknown thread",
      projectName: thread?.projectName ?? null,
      turnId: group.entry.turnId ?? group.detail?.turnId ?? null,
      focusActivityId: group.detail?.parentActivityId ?? null,
      ownership: group.entry.ownership,
      kind: group.entry.kind,
      classification: group.entry.classification,
      status: group.entry.status,
      active: group.entry.active,
      live: isLiveEntry(group.entry),
      provider: group.entry.provider,
      providerInstanceId: group.entry.providerInstanceId,
      model: group.entry.model ?? group.detail?.model ?? null,
      ...(group.entry.effort !== undefined ? { effort: group.entry.effort } : {}),
      phase: group.entry.phase ?? group.detail?.type ?? null,
      title: panelEntryTitle(group.entry, group.detail),
      prompt,
      lastTool: group.entry.lastTool,
      detail: asTrimmedString(group.entry.latestOutput) ?? group.detail?.result ?? null,
      outputTruncated: group.outputTruncated,
      nativeWorkItemId: group.entry.workItemId,
      startedAt: group.startedAt,
      updatedAt: group.entry.updatedAt,
      completedAt: group.completedAt,
    };
  });

  return buildAgentsPanelModel(entries, input.snapshot.generatedAt);
}

/** An old task must never pick up another driver or a guessed default account's name. */
export function resolveAgentProviderName(
  entry: Pick<AgentsPanelEntry, "provider" | "providerInstanceId">,
  instances: ReadonlyMap<
    ProviderInstanceId,
    { readonly driverKind: string; readonly displayName: string }
  >,
): string | undefined {
  if (!entry.providerInstanceId) return undefined;
  const instance = instances.get(entry.providerInstanceId);
  return instance?.driverKind === entry.provider ? instance.displayName : undefined;
}
