import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommandExecution,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { setNowTickerClockForTests } from "../../lib/nowTicker";
import type { deriveTimelineEntries } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";

// Counts renders of finished assistant rows. The real component is memoized,
// which would hide row re-renders; this stand-in runs whenever its row does.
const assistantRowRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("./MessageCopyButton", () => ({
  MessageCopyButton: (props: { text: string }) => {
    assistantRowRenders.set(props.text, (assistantRowRenders.get(props.text) ?? 0) + 1);
    return null;
  },
}));

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];

const TURN_START = "2026-03-04T12:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(TURN_START) + seconds * 1000).toISOString();

function message(id: string, role: "user" | "assistant", text: string, seconds: number) {
  const createdAt = at(seconds);
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt,
      completedAt: createdAt,
      streaming: false,
      attachments: [],
      reasoningText: null,
    },
  } as unknown as TimelineEntry;
}

function runningCommand(id: string, seconds: number): TimelineEntry {
  const startedAt = at(seconds);
  return {
    id,
    kind: "command",
    createdAt: startedAt,
    commandExecution: {
      id: id as OrchestrationCommandExecution["id"],
      threadId: "thread-clock" as OrchestrationCommandExecution["threadId"],
      turnId: TurnId.makeUnsafe("turn-clock"),
      providerItemId: null,
      command: "sleep 600",
      title: null,
      status: "running",
      detail: null,
      exitCode: null,
      output: "",
      outputTruncated: false,
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
      startedSequence: 1,
      lastUpdatedSequence: 1,
    },
  } as unknown as TimelineEntry;
}

function mcpCall(
  id: string,
  toolName: string,
  status: "inProgress" | "completed" | "failed",
  startSeconds: number,
  endSeconds: number,
): TimelineEntry {
  const createdAt = at(endSeconds);
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id: `work-${id}`,
      createdAt,
      startedAt: at(startSeconds),
      turnId: TurnId.makeUnsafe("turn-clock"),
      label: "MCP tool call",
      itemType: "mcp_tool_call",
      tone: status === "failed" ? "error" : "tool",
      status,
      mcpServerName: "claude_ai_Claude_Docs",
      mcpServerLabel: "Claude Docs",
      mcpToolName: toolName,
      mcpInput: JSON.stringify({ query: toolName }),
      ...(status === "inProgress" ? {} : { mcpResult: status === "failed" ? "Not found" : "ok" }),
    },
  } as unknown as TimelineEntry;
}

function Harness(props: { entries: TimelineEntry[]; isWorking?: boolean }) {
  const listRef = useRef<LegendListRef | null>(null);
  const queryClient = useRef(
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  );
  return (
    <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <QueryClientProvider client={queryClient.current}>
        <MessagesTimeline
          threadId={ThreadId.makeUnsafe("thread-clock")}
          hasMessages
          isWorking={props.isWorking ?? true}
          activeTurnStartedAt={TURN_START}
          liveActivity={null}
          listRef={listRef}
          onIsAtEndChange={() => {}}
          timelineEntries={props.entries}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={new Map()}
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onSetWorkGroupExpanded={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          revertDisabledReason={null}
          pendingRevert={null}
          revertReopenRequest={null}
          latestMessageId={null}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="24-hour"
          workspaceRoot={undefined}
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={false}
          onToggleAllDirectories={() => {}}
          listHeaderContent={null}
          chatDiffContext={{
            threadId: ThreadId.makeUnsafe("thread-clock"),
            isGitRepo: true,
            inferredCheckpointTurnCountByTurnId: {},
            expandedFileChangeDiffs: {},
            fileChangeSummariesById: {},
            onToggleFileChangeDiff: () => {},
            onOpenFileChangeDiff: () => {},
          }}
        />
      </QueryClientProvider>
    </div>
  );
}

describe("MessagesTimeline live clock", () => {
  afterEach(() => {
    setNowTickerClockForTests(null);
    assistantRowRenders.clear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("updates live labels on each tick without re-rendering finished rows", async () => {
    let now = Date.parse(at(300));
    setNowTickerClockForTests(() => now);
    const host = document.body.appendChild(document.createElement("div"));
    const screen = await render(
      <Harness
        entries={[
          message("user-1", "user", "Run the long job", 0),
          message("assistant-done", "assistant", "Finished earlier answer", 5),
          runningCommand("command-running", 240),
        ]}
      />,
      { container: host },
    );
    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Working · 5m");
        expect(host.textContent).toContain("1m");
        expect(assistantRowRenders.get("Finished earlier answer")).toBeGreaterThan(0);
      });
      const settledRenders = assistantRowRenders.get("Finished earlier answer");

      for (const [seconds, working, command] of [
        [301, "Working · 5m 1s", "1m 1s"],
        [302, "Working · 5m 2s", "1m 2s"],
        [303, "Working · 5m 3s", "1m 3s"],
      ] as const) {
        now = Date.parse(at(seconds));
        setNowTickerClockForTests(() => now);
        await vi.waitFor(() => {
          expect(host.textContent).toContain(working);
          expect(host.textContent).toContain(command);
        });
      }

      expect(assistantRowRenders.get("Finished earlier answer")).toBe(settledRenders);
    } finally {
      await screen.unmount();
    }
  });

  it("counts a running MCP call up in its group card, and freezes it on an idle thread", async () => {
    localStorage.setItem(
      "t3code:app-settings:v1",
      JSON.stringify({
        ...parsePersistedAppSettings(null),
        expandMcpToolCalls: true,
        expandMcpToolCallCardsByDefault: false,
      }),
    );
    let now = Date.parse(at(70));
    setNowTickerClockForTests(() => now);
    const entries = [
      message("user-mcp", "user", "Look it up", 0),
      mcpCall("mcp-done", "search", "completed", 1, 3),
      mcpCall("mcp-failed", "fetch", "failed", 3, 4),
      mcpCall("mcp-running", "export", "inProgress", 10, 10),
    ];
    const host = document.body.appendChild(document.createElement("div"));
    const screen = await render(<Harness entries={entries} />, { container: host });
    try {
      const card = () => host.querySelector<HTMLElement>('[data-slot="mcp-tool-card"]');
      const runningRow = () =>
        host.querySelector<HTMLElement>('[data-slot="mcp-tool-call"][data-status="running"]');
      await vi.waitFor(() => {
        expect(card()?.dataset.mcpCallCount).toBe("3");
        expect(runningRow()?.textContent).toContain("1m");
      });
      // Running wins the accent, and the header has no span while anything runs.
      expect(card()?.className).toContain("border-l-info/70");
      expect(host.querySelector('[data-testid="mcp-card-call-count"]')?.textContent).toBe(
        "3 calls",
      );

      now = Date.parse(at(71));
      setNowTickerClockForTests(() => now);
      await vi.waitFor(() => expect(runningRow()?.textContent).toContain("1m 1s"));

      // Rows open independently.
      const failedRow = host.querySelector<HTMLElement>('[data-status="failed"]');
      expect(failedRow?.querySelector('[data-testid="mcp-result-preview"]')?.textContent).toBe(
        "Not found",
      );
      failedRow?.querySelector<HTMLButtonElement>("button")?.click();
      await vi.waitFor(() =>
        expect(failedRow?.querySelector('[data-testid="mcp-result-preview"]')).toBeNull(),
      );
      expect(
        host.querySelector('[data-status="completed"] [data-testid="mcp-result-preview"]'),
      ).not.toBeNull();

      // A lost completion on an idle thread stops counting.
      await screen.rerender(<Harness entries={entries} isWorking={false} />);
      await vi.waitFor(() => expect(runningRow()?.textContent).toContain("1m 1s"));
      now = Date.parse(at(90));
      setNowTickerClockForTests(() => now);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(runningRow()?.textContent).toContain("1m 1s");
    } finally {
      await screen.unmount();
    }
  });
});
