import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AgentsSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildAgentActivityIndex, deriveAgentsPanelModel } from "./agentsModel";

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

    expect(model.directEntries).toHaveLength(1);
    expect(model.directEntries[0]).toEqual(
      expect.objectContaining({
        title: "Review pagination",
        focusActivityId: "parent",
        threadTitle: "Parallel review",
        projectName: "f5",
      }),
    );
    expect(model.directEntries[0]?.workItemIds).toEqual(
      expect.arrayContaining(["provider-parent", "subagent:agent-thread-1"]),
    );
    expect(model.workflowEntries).toHaveLength(1);
    expect(model.liveCount).toBe(1);
    expect(model.settledCount).toBe(1);
    expect(model.coverageWindowLimited).toBe(true);
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
