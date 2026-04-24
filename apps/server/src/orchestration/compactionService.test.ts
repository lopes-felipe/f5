import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildThreadCompactionRestoreInput,
  buildThreadCompactionTranscript,
} from "./compactionService.ts";
import {
  estimateModelContextWindowTokens,
  isReadOnlyToolName,
} from "../provider/providerContext.ts";

function makeThread(): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "claude-sonnet-4-6",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    archivedAt: null,
    createdAt: "2026-04-03T10:00:00.000Z",
    lastInteractionAt: "2026-04-03T10:04:00.000Z",
    updatedAt: "2026-04-03T10:04:00.000Z",
    deletedAt: null,
    estimatedContextTokens: null,
    messages: [
      {
        id: MessageId.makeUnsafe("message-1"),
        role: "user",
        text: "First request",
        streaming: false,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-04-03T10:00:00.000Z",
        updatedAt: "2026-04-03T10:00:00.000Z",
      },
      {
        id: MessageId.makeUnsafe("message-2"),
        role: "assistant",
        text: "Initial implementation",
        streaming: false,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-04-03T10:01:00.000Z",
        updatedAt: "2026-04-03T10:01:00.000Z",
      },
      {
        id: MessageId.makeUnsafe("message-3"),
        role: "user",
        text: "Second request",
        streaming: false,
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-04-03T10:02:00.000Z",
        updatedAt: "2026-04-03T10:02:00.000Z",
      },
    ],
    proposedPlans: [],
    tasks: [
      {
        id: "task-1",
        content: "Finish the feature",
        activeForm: "Finishing the feature",
        status: "in_progress",
      },
    ],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    activities: [
      {
        id: EventId.makeUnsafe("activity-read"),
        tone: "info",
        kind: "tool.updated",
        summary: "Opened file",
        payload: {
          itemType: "file_change",
          detail: 'open_file: {"path":"apps/server/src/orchestration/decider.ts"}',
        },
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-04-03T10:03:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-spreadsheet"),
        tone: "info",
        kind: "tool.updated",
        summary: "Spreadsheet tool",
        payload: {
          itemType: "dynamic_tool_call",
          detail: 'spreadsheet: {"path":"ignored.csv"}',
        },
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-04-03T10:03:30.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-plan"),
        tone: "info",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        payload: {
          explanation: "Current approach",
          plan: [
            {
              step: "Patch the worker",
              status: "in_progress",
            },
          ],
        },
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-04-03T10:04:00.000Z",
      },
    ],
    checkpoints: [
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-04-03T10:01:00.000Z",
      },
      {
        turnId: TurnId.makeUnsafe("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-2"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-04-03T10:03:00.000Z",
      },
    ],
    compaction: {
      summary: "Summary:\nEarlier work",
      trigger: "manual",
      estimatedTokens: 1234,
      modelContextWindowTokens: 1_000_000,
      createdAt: "2026-04-03T10:05:00.000Z",
      direction: "from",
      pivotMessageId: MessageId.makeUnsafe("message-2"),
      fromTurnCount: 1,
      toTurnCount: 2,
    },
    session: null,
  };
}

describe("compactionService helpers", () => {
  it("builds partial transcripts with preserved later context and turn ranges", () => {
    const thread = makeThread();

    const transcript = buildThreadCompactionTranscript({
      thread,
      direction: "up_to",
      pivotMessageId: MessageId.makeUnsafe("message-2"),
    });

    expect(transcript.transcript).toContain("First request");
    expect(transcript.transcript).toContain("Initial implementation");
    expect(transcript.transcript).not.toContain("Second request");
    expect(transcript.preservedTranscriptAfter).toContain("Second request");
    expect(transcript.fromTurnCount).toBe(1);
    expect(transcript.toTurnCount).toBe(1);
    expect(transcript.estimatedTokens).toBeGreaterThan(0);
  });

  it("restores summary, file refs, plan state, and tasks from compacted threads", () => {
    const restoreInput = buildThreadCompactionRestoreInput(makeThread());

    expect(restoreInput.priorWorkSummary).toBe("Summary:\nEarlier work");
    expect(restoreInput.preservedTranscriptBefore).toContain("First request");
    expect(restoreInput.restoredRecentFileRefs).toEqual([
      "apps/server/src/orchestration/decider.ts",
    ]);
    expect(restoreInput.restoredActivePlan).toContain("Current approach");
    expect(restoreInput.restoredTasks).toEqual(["[in_progress] Finishing the feature"]);
  });

  it("restores the latest proposed plan, tasks, and session notes without compaction", () => {
    const thread = {
      ...makeThread(),
      compaction: null,
      proposedPlans: [
        {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Recovery plan\n\n1. Inspect the issue\n2. Continue from here",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-04-03T10:04:10.000Z",
          updatedAt: "2026-04-03T10:04:20.000Z",
        },
      ],
      sessionNotes: {
        title: "Recovery thread",
        currentState: "Current state",
        taskSpecification: "Task specification",
        filesAndFunctions: "Files and functions",
        workflow: "Workflow",
        errorsAndCorrections: "Errors and corrections",
        codebaseAndSystemDocumentation: "Docs",
        learnings: "Learnings",
        keyResults: "Key results",
        worklog: "Worklog",
        updatedAt: "2026-04-03T10:05:00.000Z",
        sourceLastInteractionAt: "2026-04-03T10:04:00.000Z",
      },
    } satisfies OrchestrationThread;

    const restoreInput = buildThreadCompactionRestoreInput(thread);

    expect(restoreInput.priorWorkSummary).toBeUndefined();
    expect(restoreInput.restoredActivePlan).toBe(
      "# Recovery plan\n\n1. Inspect the issue\n2. Continue from here",
    );
    expect(restoreInput.restoredTasks).toEqual(["[in_progress] Finishing the feature"]);
    expect(restoreInput.sessionNotes?.title).toBe("Recovery thread");
  });

  it("ignores non-path tool detail previews when restoring recent file refs", () => {
    const thread = {
      ...makeThread(),
      activities: [
        {
          id: EventId.makeUnsafe("activity-read-preview"),
          tone: "info" as const,
          kind: "tool.updated",
          summary: "Opened file",
          payload: {
            itemType: "dynamic_tool_call",
            detail: "open_file: request approved",
          },
          turnId: TurnId.makeUnsafe("turn-2"),
          createdAt: "2026-04-03T10:03:00.000Z",
        },
      ],
    } satisfies OrchestrationThread;

    const restoreInput = buildThreadCompactionRestoreInput(thread);

    expect(restoreInput.restoredRecentFileRefs).toBeUndefined();
  });

  it("recognizes Codex-style read-only tool names", () => {
    expect(isReadOnlyToolName("file_read")).toBe(true);
    expect(isReadOnlyToolName("write_file")).toBe(false);
  });

  it("estimates Codex model context windows conservatively", () => {
    expect(estimateModelContextWindowTokens("gpt-5.4", "codex")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.3-codex", "codex")).toBe(400_000);
    expect(estimateModelContextWindowTokens("gpt-5.3-codex-spark", "codex")).toBe(400_000);
    expect(estimateModelContextWindowTokens("claude-sonnet-4-6", "claudeAgent")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("unknown-codex-model", "codex")).toBe(200_000);
  });
});
