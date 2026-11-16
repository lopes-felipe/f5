import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AgentsSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  agentTypeLabel,
  resolveAgentProviderName,
  buildAgentActivityIndex,
  countAgentsByStatus,
  deriveAgentsPanelModel,
  filterAgentsPanelEntries,
} from "./agentsModel";

const THREAD_ID = ThreadId.makeUnsafe("thread-agents");
const TURN_ID = TurnId.makeUnsafe("turn-agents");

function activity(input: {
  id: string;
  kind: string;
  sequence: number;
  payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(input.id),
    turnId: TURN_ID,
    tone: "tool",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    sequence: input.sequence,
    createdAt: new Date(Date.UTC(2026, 7, 15, 10, 0, input.sequence)).toISOString(),
  };
}

const source = {
  threadId: THREAD_ID,
  threadTitle: "Parallel review",
  projectName: "f5",
  hasOlderActivities: true,
  activities: [
    activity({
      id: "parent-started",
      kind: "tool.started",
      sequence: 0,
      payload: {
        itemType: "collab_agent_tool_call",
        providerItemId: "provider-parent",
        subagentReceiverThreadIds: ["agent-thread-1"],
      },
    }),
    activity({
      id: "parent",
      kind: "tool.completed",
      sequence: 1,
      payload: {
        itemType: "collab_agent_tool_call",
        providerItemId: "provider-parent",
        subagentDescription: "Review pagination",
        subagentReceiverThreadIds: ["agent-thread-1"],
      },
    }),
    activity({
      id: "child",
      kind: "subagent.activity",
      sequence: 2,
      payload: {
        itemType: "collab_agent_tool_call",
        providerItemId: "provider-parent",
        subagentThreadId: "agent-thread-1",
        subagentPath: "/root/reviewer",
        subagentType: "interacted",
      },
    }),
    activity({
      id: "workflow-start",
      kind: "task.started",
      sequence: 3,
      payload: { taskId: "workflow-1", taskType: "local_workflow", detail: "Run checks" },
    }),
  ],
} as const;

function snapshot(): AgentsSnapshot {
  return {
    generatedAt: "2026-08-15T10:01:00.000Z",
    entries: [
      {
        threadId: THREAD_ID,
        workItemId: "provider-parent",
        provider: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claude-default"),
        providerSessionIdentity: "claude|default",
        turnId: TURN_ID,
        classification: "working",
        ownership: "direct-subagent",
        kind: "agent",
        title: null,
        prompt: null,
        lastTool: null,
        status: "running",
        active: true,
        model: "claude-sonnet",
        phase: null,
        latestOutput: "Inspecting cursor behavior",
        outputTruncated: false,
        startedAt: "2026-08-15T10:00:01.000Z",
        updatedAt: "2026-08-15T10:00:02.000Z",
        lastSeenAt: "2026-08-15T10:00:02.000Z",
        completedAt: null,
      },
      {
        threadId: THREAD_ID,
        workItemId: "subagent:agent-thread-1",
        provider: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claude-default"),
        providerSessionIdentity: "claude|default",
        turnId: TURN_ID,
        classification: "working",
        ownership: "direct-subagent",
        kind: "agent",
        title: null,
        prompt: null,
        lastTool: null,
        status: "running",
        active: true,
        model: null,
        phase: "/root/reviewer",
        latestOutput: null,
        outputTruncated: false,
        startedAt: "2026-08-15T10:00:02.000Z",
        updatedAt: "2026-08-15T10:00:03.000Z",
        lastSeenAt: "2026-08-15T10:00:03.000Z",
        completedAt: null,
      },
      {
        threadId: THREAD_ID,
        workItemId: "workflow-1",
        provider: "claudeAgent",
        providerInstanceId: null,
        providerSessionIdentity: "claude|default",
        turnId: TURN_ID,
        classification: "working",
        ownership: "workflow",
        kind: "workflow",
        title: null,
        prompt: null,
        lastTool: null,
        status: "completed",
        active: false,
        model: null,
        phase: "local_workflow",
        latestOutput: "Checks passed",
        outputTruncated: false,
        startedAt: "2026-08-15T10:00:03.000Z",
        updatedAt: "2026-08-15T10:00:05.000Z",
        lastSeenAt: "2026-08-15T10:00:05.000Z",
        completedAt: "2026-08-15T10:00:05.000Z",
      },
    ],
  };
}

describe("agentsModel", () => {
  it("correlates child activity aliases without double-counting a durable subagent", () => {
    const index = buildAgentActivityIndex([source]);
    const model = deriveAgentsPanelModel({
      snapshot: snapshot(),
      activityIndex: index,
      threads: [source],
    });

    const direct = model.agents.filter((entry) => entry.kind === "agent");
    expect(direct).toHaveLength(1);
    expect(direct[0]).toEqual(
      expect.objectContaining({
        title: "Review pagination",
        focusActivityId: "parent",
        threadTitle: "Parallel review",
        projectName: "f5",
        live: true,
      }),
    );
    expect(direct[0]?.workItemIds).toEqual(
      expect.arrayContaining(["provider-parent", "subagent:agent-thread-1"]),
    );
    expect(model.agents.filter((entry) => entry.kind === "workflow")).toHaveLength(1);
    expect(model.backgroundTasks).toHaveLength(0);
    expect(model.liveCount).toBe(1);
    expect(model.settledCount).toBe(1);
  });

  it("keeps distinct pre-id collaboration rows representable by parent and ordinal", () => {
    const index = buildAgentActivityIndex([
      {
        ...source,
        hasOlderActivities: false,
        activities: [
          activity({
            id: "pre-id-a",
            kind: "tool.completed",
            sequence: 1,
            payload: { itemType: "collab_agent_tool_call", subagentDescription: "First" },
          }),
          activity({
            id: "pre-id-b",
            kind: "tool.completed",
            sequence: 2,
            payload: { itemType: "collab_agent_tool_call", subagentDescription: "Second" },
          }),
        ],
      },
    ]);

    expect([...new Set(index.byScopedWorkItemId.values())].map((entry) => entry.key)).toEqual([
      `${THREAD_ID}\u0000pre-id-a\u00000`,
      `${THREAD_ID}\u0000pre-id-b\u00000`,
    ]);
  });
});

const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-other");

function workEntry(
  overrides: Partial<AgentsSnapshot["entries"][number]> & { readonly workItemId: string },
): AgentsSnapshot["entries"][number] {
  return {
    threadId: THREAD_ID,
    provider: "claudeAgent",
    providerInstanceId: null,
    providerSessionIdentity: "claude|default",
    turnId: null,
    classification: "working",
    ownership: "direct-subagent",
    kind: "agent",
    status: "completed",
    active: false,
    model: null,
    phase: null,
    title: null,
    prompt: null,
    lastTool: null,
    latestOutput: null,
    outputTruncated: false,
    startedAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:01.000Z",
    lastSeenAt: "2026-08-15T10:00:01.000Z",
    completedAt: "2026-08-15T10:00:01.000Z",
    ...overrides,
  };
}

function derive(entries: ReadonlyArray<AgentsSnapshot["entries"][number]>) {
  return deriveAgentsPanelModel({
    snapshot: { generatedAt: "2026-08-15T10:01:00.000Z", entries: [...entries] },
    activityIndex: buildAgentActivityIndex([]),
    threads: [
      {
        threadId: THREAD_ID,
        threadTitle: "Parallel review",
        projectName: "f5",
        activities: [],
        hasOlderActivities: false,
      },
      {
        threadId: OTHER_THREAD_ID,
        threadTitle: "Other work",
        projectName: "f5",
        activities: [],
        hasOlderActivities: false,
      },
    ],
  });
}

describe("agents panel model", () => {
  it("counts live agents from earlier turns while the parent is idle or working on a later turn", () => {
    const model = derive([
      workEntry({
        workItemId: "older-live",
        turnId: TurnId.make("earlier-turn"),
        status: "running",
        active: true,
        completedAt: null,
      }),
      workEntry({
        workItemId: "current-live",
        turnId: TURN_ID,
        status: "running",
        active: true,
        completedAt: null,
      }),
      workEntry({
        workItemId: "older-done",
        turnId: TurnId.make("earlier-turn"),
        status: "completed",
        active: false,
      }),
    ]);
    expect(model.liveCount).toBe(2);
    expect(model.threads[0]?.liveCount).toBe(2);
    expect(
      model.agents
        .filter((entry) => entry.live)
        .map((entry) => entry.nativeWorkItemId)
        .toSorted(),
    ).toEqual(["current-live", "older-live"]);
  });

  it("prefers the durable title and humanizes the type only as a fallback", () => {
    const model = derive([
      workEntry({ workItemId: "titled", phase: "local_bash", title: "Run browser suite" }),
      workEntry({ workItemId: "untitled-shell", phase: "local_bash", kind: "shell" }),
      workEntry({ workItemId: "untitled-custom", phase: "code_reviewer" }),
      workEntry({ workItemId: "bare" }),
    ]);
    const titleOf = (id: string) =>
      [...model.agents, ...model.backgroundTasks].find((entry) => entry.nativeWorkItemId === id)
        ?.title;
    expect(titleOf("titled")).toBe("Run browser suite");
    expect(titleOf("untitled-shell")).toBe("Shell command");
    expect(titleOf("untitled-custom")).toBe("Code reviewer");
    expect(titleOf("bare")).toBe("Subagent");
    expect(agentTypeLabel("local_bash")).toBe("shell");
    expect(agentTypeLabel("Explore")).toBe("Explore");
  });

  it("splits shells from agents and orders live work first", () => {
    const model = derive([
      workEntry({ workItemId: "old-agent", updatedAt: "2026-08-15T10:00:01.000Z" }),
      workEntry({
        workItemId: "live-agent",
        status: "running",
        active: true,
        completedAt: null,
        updatedAt: "2026-08-15T09:00:00.000Z",
      }),
      workEntry({
        workItemId: "shell",
        kind: "shell",
        classification: "monitoring",
        status: "monitoring",
        active: true,
        completedAt: null,
      }),
      workEntry({ workItemId: "workflow", kind: "workflow", ownership: "workflow" }),
    ]);
    expect(model.agents.map((entry) => entry.nativeWorkItemId)).toEqual([
      "live-agent",
      "old-agent",
      "workflow",
    ]);
    expect(model.backgroundTasks.map((entry) => entry.nativeWorkItemId)).toEqual(["shell"]);
    expect(model.liveCount).toBe(2);
    expect(model.settledCount).toBe(2);
  });

  it("filters by search text and status chips", () => {
    const model = derive([
      workEntry({
        workItemId: "running",
        title: "Review pagination",
        status: "running",
        active: true,
        completedAt: null,
      }),
      workEntry({ workItemId: "failed", title: "Run tests", status: "failed" }),
      workEntry({
        workItemId: "done",
        title: "Summarize",
        prompt: "Summarize the pagination change",
      }),
      workEntry({ workItemId: "stopped", title: "Lint", status: "stopped" }),
    ]);
    const all = [...model.agents];
    const ids = (entries: ReadonlyArray<{ readonly nativeWorkItemId: string }>) =>
      entries.map((entry) => entry.nativeWorkItemId).toSorted();

    expect(countAgentsByStatus(all)).toEqual({ all: 4, running: 1, failed: 1, done: 2 });
    expect(ids(filterAgentsPanelEntries(all, { query: "PAGINATION", status: "all" }))).toEqual([
      "done",
      "running",
    ]);
    expect(ids(filterAgentsPanelEntries(all, { query: "", status: "running" }))).toEqual([
      "running",
    ]);
    expect(ids(filterAgentsPanelEntries(all, { query: "", status: "failed" }))).toEqual(["failed"]);
    expect(ids(filterAgentsPanelEntries(all, { query: "", status: "done" }))).toEqual([
      "done",
      "stopped",
    ]);
    expect(ids(filterAgentsPanelEntries(all, { query: "other work", status: "all" }))).toEqual([]);
  });

  it("groups by thread with live threads first, then most recent", () => {
    const model = derive([
      workEntry({ workItemId: "recent", updatedAt: "2026-08-15T12:00:00.000Z" }),
      workEntry({
        workItemId: "other-live",
        threadId: OTHER_THREAD_ID,
        status: "running",
        active: true,
        completedAt: null,
        updatedAt: "2026-08-15T08:00:00.000Z",
      }),
      workEntry({
        workItemId: "other-shell",
        threadId: OTHER_THREAD_ID,
        kind: "shell",
        updatedAt: "2026-08-15T07:00:00.000Z",
      }),
    ]);
    expect(model.threads.map((group) => group.threadId)).toEqual([OTHER_THREAD_ID, THREAD_ID]);
    expect(model.threads[0]).toEqual(
      expect.objectContaining({ threadTitle: "Other work", liveCount: 1 }),
    );
    expect(model.threads[0]?.agents.map((entry) => entry.nativeWorkItemId)).toEqual(["other-live"]);
    expect(model.threads[0]?.backgroundTasks.map((entry) => entry.nativeWorkItemId)).toEqual([
      "other-shell",
    ]);
  });
});

it("retains the provider instance that owns a durable background task", () => {
  const model = deriveAgentsPanelModel({
    snapshot: snapshot(),
    activityIndex: buildAgentActivityIndex([source]),
    threads: [source],
  });
  expect(
    model.agents.find((agent) => agent.workItemIds.includes("provider-parent"))?.providerInstanceId,
  ).toBe(ProviderInstanceId.make("claude-default"));
});

it("resolves only the task's recorded provider instance and driver", () => {
  const id = ProviderInstanceId.make("claude_work");
  const instances = new Map([[id, { driverKind: "claudeAgent", displayName: "Claude · Work" }]]);
  expect(
    resolveAgentProviderName({ provider: "claudeAgent", providerInstanceId: id }, instances),
  ).toBe("Claude · Work");
  expect(
    resolveAgentProviderName({ provider: "codex", providerInstanceId: id }, instances),
  ).toBeUndefined();
  expect(
    resolveAgentProviderName({ provider: "claudeAgent", providerInstanceId: null }, instances),
  ).toBeUndefined();
  expect(
    resolveAgentProviderName(
      { provider: "claudeAgent", providerInstanceId: ProviderInstanceId.make("removed") },
      instances,
    ),
  ).toBeUndefined();
});

it("formats native subagent paths as display names while preserving shell titles", () => {
  const title = "Subagent: /root/coordinator/review_api";
  const model = derive([
    workEntry({ workItemId: "agent-title", kind: "agent", title }),
    workEntry({ workItemId: "shell-title", kind: "shell", title }),
  ]);
  expect(model.agents.find((agent) => agent.nativeWorkItemId === "agent-title")?.title).toBe(
    "Review Api",
  );
  expect(model.backgroundTasks.find((task) => task.nativeWorkItemId === "shell-title")?.title).toBe(
    title,
  );
});
