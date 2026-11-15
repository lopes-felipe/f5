import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  EventId,
  MessageId,
  OrchestrationFileChangeId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePersistedAppSettings } from "../../appSettings";
import { appendAttachedFilesToPrompt } from "../../lib/attachedFiles";
import { orchestrationQueryKeys } from "../../lib/orchestrationReactQuery";
import { providerQueryKeys } from "../../lib/providerReactQuery";
import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type LiveWorkActivity,
  type TimelineEntry,
} from "../../session-logic";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("../DiffSurfaceBoundary", () => ({
  DiffSurfaceBoundary: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@pierre/diffs/react", async () => {
  const actual = await vi.importActual<typeof import("@pierre/diffs/react")>("@pierre/diffs/react");
  return {
    ...actual,
    FileDiff: ({ fileDiff }: { fileDiff: unknown }) => (
      <pre data-testid="mock-file-diff">{JSON.stringify(fileDiff)}</pre>
    ),
    Virtualizer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
});

// LegendList normally virtualizes rows against a real scroll container, but
// `renderToStaticMarkup` runs without layout, so it would emit only the outer
// wrapper + spacers. Stub it with a plain <div> that renders every row so the
// test can assert against the generated markup.
function LegendListStub<T>(props: {
  data: readonly T[];
  renderItem: (info: { item: T; index: number }) => React.ReactNode;
  keyExtractor: (item: T, index: number) => string;
  className?: string;
  ListHeaderComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactNode;
}) {
  const { data, renderItem, keyExtractor, className, ListHeaderComponent, ListFooterComponent } =
    props;
  return (
    <div className={className}>
      {ListHeaderComponent}
      {data.map((item, index) => {
        // keyExtractor returns a stable, data-dependent id derived from the
        // row; it is not the array index even though we forward index into it
        // to match LegendList's real signature.
        const key = keyExtractor(item, index);
        return <div key={key}>{renderItem({ item, index })}</div>;
      })}
      {ListFooterComponent}
    </div>
  );
}
vi.mock("@legendapp/list/react", () => ({ LegendList: LegendListStub }));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const localStorageStore = new Map<string, string>();
const DEFAULT_TIMELINE_TEST_SETTINGS = {
  ...parsePersistedAppSettings(null),
  enableAssistantStreaming: false,
  showAgentCommandTranscripts: false,
  expandMcpToolCalls: false,
  expandMcpToolCallCardsByDefault: true,
} as const;

function setPersistedAppSettings(settings: Record<string, unknown>) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...DEFAULT_TIMELINE_TEST_SETTINGS,
      ...settings,
    }),
  );
}

beforeEach(() => {
  localStorageStore.clear();
});

beforeAll(async () => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localStorageStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageStore.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageStore.delete(key);
    },
    clear: () => {
      localStorageStore.clear();
    },
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
    localStorage,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });

  const { preloadInlineDiffComponents } = await import("./MessagesTimeline");
  await preloadInlineDiffComponents();
});

function extractMessageRowMarkup(markup: string, messageId: string): string {
  const marker = `data-message-id="${messageId}"`;
  const startIndex = markup.indexOf(marker);
  if (startIndex < 0) {
    throw new Error(`Missing message row for ${messageId}`);
  }

  const nextIndex = markup.indexOf('data-message-id="', startIndex + marker.length);
  return nextIndex < 0 ? markup.slice(startIndex) : markup.slice(startIndex, nextIndex);
}

async function renderMcpTimelineMarkup(timelineEntries: TimelineEntry[]): Promise<string> {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  return renderToStaticMarkup(
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnStartedAt={null}
      listRef={{ current: null }}
      onIsAtEndChange={() => {}}
      timelineEntries={timelineEntries}
      completionDividerBeforeEntryId={null}
      completionSummary={null}
      turnDiffSummaryByAssistantMessageId={new Map()}
      turnDiffSummaryByTurnId={new Map()}
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot={undefined}
      expandedCommandExecutions={{}}
      onToggleCommandExecution={() => {}}
      allDirectoriesExpanded={true}
      onToggleAllDirectories={() => {}}
    />,
  );
}

function mcpWorkEntry(
  id: string,
  entry: Partial<Extract<TimelineEntry, { kind: "work" }>["entry"]>,
): TimelineEntry {
  const createdAt = entry.createdAt ?? "2026-03-17T19:12:28.000Z";
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id: `work-${id}`,
      createdAt,
      label: "MCP tool call",
      itemType: "mcp_tool_call",
      tone: "tool",
      ...entry,
    },
  };
}

const DEFAULT_CHAT_DIFF_CONTEXT = {
  threadId: ThreadId.makeUnsafe("thread-inline-diff-test"),
  isGitRepo: true,
  inferredCheckpointTurnCountByTurnId: {},
  expandedFileChangeDiffs: {},
  fileChangeSummariesById: {},
  onToggleFileChangeDiff: () => {},
  onOpenFileChangeDiff: () => {},
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function preloadTurnDiff(input: {
  queryClient: QueryClient;
  threadId: ThreadId;
  turnId: TurnId;
  checkpointTurnCount: number;
  diff: string;
}) {
  input.queryClient.setQueryData(
    providerQueryKeys.checkpointDiff({
      threadId: input.threadId,
      fromTurnCount: Math.max(0, input.checkpointTurnCount - 1),
      toTurnCount: input.checkpointTurnCount,
      cacheScope: `turn:${input.turnId}`,
    }),
    { diff: input.diff },
  );
}

function preloadThreadFileChange(input: {
  queryClient: QueryClient;
  threadId: ThreadId;
  fileChangeId: OrchestrationFileChangeId;
  patch: string;
  changedFiles?: readonly string[];
}) {
  input.queryClient.setQueryData(
    orchestrationQueryKeys.threadFileChange(input.threadId, input.fileChangeId),
    {
      fileChange: {
        id: input.fileChangeId,
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe("turn-inline-exact"),
        providerItemId: ProviderItemId.makeUnsafe("provider-item-1"),
        title: "File change",
        detail: "Apply patch",
        status: "completed",
        changedFiles: [...(input.changedFiles ?? ["packages/foo/src/bar.ts"])],
        startedAt: "2026-03-17T19:12:28.000Z",
        completedAt: "2026-03-17T19:12:29.000Z",
        updatedAt: "2026-03-17T19:12:29.000Z",
        startedSequence: 10,
        lastUpdatedSequence: 11,
        hasPatch: true,
        patch: input.patch,
      },
    },
  );
}

describe("MessagesTimeline", () => {
  it("keeps a paginated turn start unknown until its persisted timing is available", async () => {
    const { deriveTimelineEntries } = await import("../../session-logic");
    const { buildTimelineRows, createTimelineRowCache } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("partially-loaded-turn");
    const answer = {
      id: MessageId.makeUnsafe("partial-answer"),
      role: "assistant" as const,
      text: "Only the last part is loaded",
      createdAt: "2026-11-14T12:40:31.000Z",
      completedAt: "2026-11-14T12:40:40.000Z",
      streaming: false,
      turnId,
    };
    const input = {
      timelineEntries: deriveTimelineEntries([answer], [], [], []),
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    };
    expect(buildTimelineRows(input).find((row) => row.id === answer.id)).toMatchObject({
      showCompletionDivider: false,
      completionSummary: null,
      durationStart: undefined,
    });
    expect(buildTimelineRows(input).find((row) => row.id === answer.id)).not.toHaveProperty(
      "completionStartedAt",
    );
    expect(
      buildTimelineRows({
        ...input,
        turnDiffSummaryByTurnId: new Map([
          [
            turnId,
            {
              turnId,
              files: [],
              startedAt: "2026-11-14T12:40:00.000Z",
              completedAt: answer.completedAt,
            },
          ],
        ]),
      }).find((row) => row.id === answer.id),
    ).toMatchObject({
      completionStartedAt: "2026-11-14T12:40:00.000Z",
      completionSummary: "Worked for 40s",
      durationStart: "2026-11-14T12:40:00.000Z",
    });
  });
  it("shows the latest tool-free completion and refreshes lifecycle metadata on the streaming fast path", async () => {
    const { createTimelineEntryCache, deriveTimelineEntries } = await import("../../session-logic");
    const { buildTimelineRows, createTimelineRowCache } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("latest-tool-free");
    const startedAt = "2026-11-14T12:40:31.000Z";
    const completedAt = "2026-11-14T12:40:31.285Z";
    const question = {
      id: MessageId.makeUnsafe("latest-question"),
      role: "user" as const,
      text: "Question",
      createdAt: startedAt,
      streaming: false,
      turnId,
    };
    const answer = {
      id: MessageId.makeUnsafe("latest-answer"),
      role: "assistant" as const,
      text: "Answer",
      createdAt: startedAt,
      streaming: true,
      turnId,
    };
    const entriesCache = createTimelineEntryCache();
    const plans: [] = [],
      work: [] = [],
      commands: [] = [];
    const derive = (reply: typeof answer & { completedAt?: string }) =>
      deriveTimelineEntries([question, reply], plans, work, commands, entriesCache);
    const input = {
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    };
    const pending = buildTimelineRows({ ...input, timelineEntries: derive(answer) });
    expect(pending.find((row) => row.id === answer.id)).toMatchObject({
      showCompletionDivider: false,
    });
    const finished = buildTimelineRows({
      ...input,
      timelineEntries: derive({ ...answer, streaming: false, completedAt }),
    });
    expect(finished.find((row) => row.id === answer.id)).toMatchObject({
      showCompletionDivider: true,
      completionSummary: "Worked for 285ms",
      completionStartedAt: startedAt,
      completionCompletedAt: completedAt,
    });
    const corrected = buildTimelineRows({
      ...input,
      timelineEntries: derive({
        ...answer,
        streaming: false,
        completedAt: "2026-11-14T12:40:31.500Z",
      }),
    });
    expect(corrected.find((row) => row.id === answer.id)).toMatchObject({
      completionSummary: "Worked for 500ms",
      completionCompletedAt: "2026-11-14T12:40:31.500Z",
    });
    const authoritative = buildTimelineRows({
      ...input,
      timelineEntries: derive({ ...answer, streaming: false, completedAt }),
      turnDiffSummaryByTurnId: new Map([
        [
          turnId,
          {
            turnId,
            files: [],
            startedAt: "2026-11-14T12:40:31.100Z",
            completedAt,
          },
        ],
      ]),
    });
    expect(authoritative.find((row) => row.id === answer.id)).toMatchObject({
      completionSummary: "Worked for 185ms",
      completionStartedAt: "2026-11-14T12:40:31.100Z",
    });
  });

  it("keeps completed turn timing after another prompt and after rebuilding history", async () => {
    const { buildTimelineRows, createTimelineRowCache } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("timed-turn");
    const startedAt = "2026-03-17T19:12:00.000Z";
    const completedAt = "2026-03-17T19:13:15.000Z";
    const message = (
      id: string,
      role: "user" | "assistant",
      createdAt: string,
      messageTurnId = turnId,
      endedAt = completedAt,
    ): TimelineEntry => ({
      id,
      kind: "message",
      createdAt,
      message: {
        id: MessageId.makeUnsafe(id),
        role,
        text: id,
        turnId: messageTurnId,
        createdAt,
        ...(role === "assistant" ? { completedAt: endedAt } : {}),
        streaming: false,
      },
    });
    const entries = [
      message("question", "user", startedAt),
      message("commentary", "assistant", "2026-03-17T19:12:10.000Z"),
      message("answer", "assistant", "2026-03-17T19:13:00.000Z"),
    ];
    const cache = createTimelineRowCache();
    const input = {
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByTurnId: new Map([[turnId, { turnId, completedAt, files: [] }]]),
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache,
    };
    const before = buildTimelineRows({ ...input, timelineEntries: entries });
    const nextTurnId = TurnId.makeUnsafe("next-turn");
    const nextStartedAt = "2026-03-17T19:14:00.000Z";
    const nextEntries = [
      ...entries,
      message("follow-up", "user", nextStartedAt, nextTurnId),
      // A completed commentary message does not mean the active turn has ended.
      message(
        "still-working",
        "assistant",
        "2026-03-17T19:14:01.000Z",
        nextTurnId,
        "2026-03-17T19:14:03.000Z",
      ),
    ];
    const during = buildTimelineRows({
      ...input,
      timelineEntries: nextEntries,
      isWorking: true,
      activeTurnStartedAt: nextStartedAt,
    });
    const reloaded = buildTimelineRows({
      ...input,
      timelineEntries: nextEntries,
      isWorking: true,
      activeTurnStartedAt: nextStartedAt,
      cache: createTimelineRowCache(),
    });
    const withoutCheckpoints = buildTimelineRows({
      ...input,
      timelineEntries: nextEntries,
      isWorking: true,
      activeTurnStartedAt: nextStartedAt,
      turnDiffSummaryByTurnId: undefined,
      cache: createTimelineRowCache(),
    });
    for (const rows of [before, during, reloaded, withoutCheckpoints]) {
      const dividers = rows.filter((row) => row.kind === "message" && row.showCompletionDivider);
      expect(dividers).toHaveLength(1);
      expect(dividers[0]).toMatchObject({
        id: "answer",
        completionSummary: "Worked for 1m 15s",
        completionStartedAt: startedAt,
        completionCompletedAt: completedAt,
      });
    }
  });

  it("keeps paused usage-limit tools grouped with the pause outside the group", async () => {
    const { buildTimelineRows, createTimelineRowCache } = await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const turnId = TurnId.makeUnsafe("limited");
    const work = (id: string, usageLimited = false): TimelineEntry => ({
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        turnId,
        tone: usageLimited ? "info" : "tool",
        label: id,
        usageLimited,
      },
    });
    const rows = buildTimelineRows({
      timelineEntries: [work("tool-1"), work("tool-2"), work("limit", true)],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    });
    expect(
      rows
        .filter((row) => row.kind === "work")
        .map((row) => ({
          ids: row.groupedEntries.map((entry) => entry.id),
          collapseEligible: row.isPriorTurn,
        })),
    ).toEqual([
      { ids: ["tool-1", "tool-2"], collapseEligible: false },
      { ids: ["limit"], collapseEligible: false },
    ]);
    setPersistedAppSettings({ collapseCompletedWorkLogs: true });
    const markup = await renderMcpTimelineMarkup([
      work("tool-1"),
      work("tool-2"),
      work("Usage resets tomorrow", true),
      {
        kind: "message",
        id: "next",
        createdAt,
        message: {
          id: MessageId.makeUnsafe("next"),
          role: "user",
          text: "Next",
          createdAt,
          streaming: false,
        },
      },
    ]);
    expect(markup).toContain("Usage resets tomorrow");
    expect(markup.match(/data-slot="work-group-summary"/g)).toHaveLength(1);
  });
  it("groups computer and preview runs into session rows even when MCP calls expand", async () => {
    const { buildTimelineRows, createTimelineRowCache } = await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const work = (id: string, entry: Partial<Extract<TimelineEntry, { kind: "work" }>["entry"]>) =>
      ({
        id,
        kind: "work",
        createdAt,
        entry: { id, createdAt, tone: "tool", label: id, ...entry },
      }) satisfies TimelineEntry;
    const computerCall = (id: string) =>
      work(id, {
        itemType: "mcp_tool_call",
        mcpServerName: "f5_computer",
        mcpToolName: "computer_click",
        computerTool: true,
      });
    const previewCall = (id: string) =>
      work(id, {
        itemType: "mcp_tool_call",
        mcpServerName: "f5_preview",
        mcpToolName: "preview_click",
      });
    const thought = (id: string) => work(id, { tone: "thinking" });
    const timelineEntries: TimelineEntry[] = [
      work("before", { tone: "info" }),
      computerCall("c1"),
      thought("t1"),
      computerCall("c2"),
      thought("t2"),
      previewCall("p1"),
      previewCall("p2"),
      work("other", { itemType: "mcp_tool_call", mcpServerName: "docs", mcpToolName: "read" }),
      computerCall("c3"),
    ];
    const rows = buildTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: true,
      cache: createTimelineRowCache(),
    });
    expect(
      rows.flatMap((row) =>
        row.kind === "work"
          ? [[row.automationSurface ?? null, row.groupedEntries.map((entry) => entry.id)]]
          : [],
      ),
    ).toEqual([
      [null, ["before"]],
      ["computer", ["c1", "t1", "c2"]],
      [null, ["t2"]],
      ["preview", ["p1", "p2"]],
      [null, ["other"]],
      ["computer", ["c3"]],
    ]);
    const computerRow = rows.find((row) => row.kind === "work" && row.automationSurface);
    expect(computerRow?.kind === "work" && computerRow.workSummary).toBe(
      "Used the computer · 2 actions",
    );

    // A prior turn's lost completion is not a running action, even while a new turn works.
    const orphan = work("orphan", {
      itemType: "mcp_tool_call",
      mcpServerName: "f5_computer",
      mcpToolName: "computer_click",
      computerTool: true,
      status: "inProgress",
    });
    const live = { ...orphan, id: "live", entry: { ...orphan.entry, id: "live" } };
    const userMessage: TimelineEntry = {
      id: "next",
      kind: "message",
      createdAt,
      message: {
        id: MessageId.makeUnsafe("next"),
        role: "user",
        text: "Next",
        createdAt,
        streaming: false,
      },
    };
    const workingRows = buildTimelineRows({
      timelineEntries: [orphan, userMessage, live],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: createdAt,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    });
    expect(
      workingRows.flatMap((row) =>
        row.kind === "work" ? [[row.automationActive, row.workSummary]] : [],
      ),
    ).toEqual([
      [false, "Used the computer · 1 action"],
      [true, "Clicking… · 1 action"],
    ]);
  });

  it("keeps answered questions visible outside collapsed work from previous turns", async () => {
    const { MessagesTimeline, buildTimelineRows, createTimelineRowCache } =
      await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const work = (id: string, activityKind?: string): TimelineEntry => ({
      id,
      kind: "work",
      createdAt,
      entry: {
        id,
        createdAt,
        tone: "info",
        label: id,
        ...(activityKind ? { activityKind } : {}),
        ...(activityKind === "user-input.resolved" ? { detail: "The private one" } : {}),
      },
    });
    const timelineEntries: TimelineEntry[] = [
      work("before"),
      work("Which repository?", "user-input.resolved"),
      work("after"),
      {
        id: "new-turn",
        kind: "message",
        createdAt,
        message: {
          id: MessageId.makeUnsafe("new-turn"),
          role: "user",
          text: "Continue",
          createdAt,
          streaming: false,
        },
      },
    ];
    const rows = buildTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    });
    expect(
      rows
        .filter((row) => row.kind === "work")
        .map((row) => row.groupedEntries.map((entry) => entry.id)),
    ).toEqual([["before"], ["Which repository?"], ["after"]]);
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded
        onToggleAllDirectories={() => {}}
      />,
    );
    expect(markup).toContain("Which repository?");
    expect(markup).toContain("The private one");
  });
  it("renders answered questions as a standalone Q&A card in a collapsed prior turn", async () => {
    const { MessagesTimeline, buildTimelineRows, createTimelineRowCache } =
      await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const timelineEntries: TimelineEntry[] = [
      {
        id: "before",
        kind: "work",
        createdAt,
        entry: { id: "before", createdAt, tone: "tool", label: "Command run" },
      },
      {
        id: "qa",
        kind: "work",
        createdAt,
        entry: {
          id: "qa",
          createdAt,
          tone: "info",
          label: "How should focus motion feel? · Which states?",
          activityKind: "user-input.resolved",
          userInput: {
            state: "answered",
            questions: [
              {
                id: "motion",
                header: "Focus motion",
                question: "How should focus motion feel? It stays at 1.1× today.",
                answers: [{ text: "Spring", custom: false }],
              },
              {
                id: "states",
                header: "Question 2",
                question: "Which states?",
                answers: [
                  { text: "Pinned", custom: false },
                  { text: "Only when idle", custom: true },
                ],
              },
            ],
          },
        },
      },
      {
        id: "new-turn",
        kind: "message",
        createdAt,
        message: {
          id: MessageId.makeUnsafe("new-turn"),
          role: "user",
          text: "Continue",
          createdAt,
          streaming: false,
        },
      },
    ];
    const rows = buildTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    });
    expect(
      rows
        .filter((row) => row.kind === "work")
        .map((row) => row.groupedEntries.map((entry) => entry.id)),
    ).toEqual([["before"], ["qa"]]);
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded
        onToggleAllDirectories={() => {}}
      />,
    );
    expect(markup).toContain('data-slot="user-input-card"');
    expect(markup).toContain(">Asked 2 questions</span>");
    expect(markup).toContain(">Focus motion</p>");
    // The adapter's generic "Question N" header adds nothing, so it gets no chip.
    expect(markup).not.toContain(">Question 2</p>");
    expect(markup).toContain("How should focus motion feel? It stays at 1.1× today.");
    expect(markup).toContain("Spring</li>");
    expect(markup).toContain("“Only when idle”</li>");
  });
  it("renders a message-mode answer as its Q&A card on a user row that keeps revert", async () => {
    const { MessagesTimeline, buildTimelineRows, createTimelineRowCache } =
      await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const answerId = MessageId.makeUnsafe("answer:cmd");
    const timelineEntries: TimelineEntry[] = [
      {
        id: "answer:cmd",
        kind: "message",
        createdAt,
        message: {
          id: answerId,
          role: "user",
          text: '{"0":{"answers":["Signed in"]}}',
          turnId: TurnId.makeUnsafe("answer-turn"),
          createdAt,
          streaming: false,
        },
        userInput: {
          state: "answered",
          questions: [
            {
              id: "0",
              header: "Question",
              question: "Tell me when you are signed in.",
              answers: [{ text: "Signed in", custom: true }],
            },
          ],
          answerMessageId: "answer:cmd",
        },
      },
    ];
    const rows = buildTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache: createTimelineRowCache(),
    });
    // Still a user message row, so turn boundaries and navigation see the answer turn.
    expect(rows.map((row) => row.kind === "message" && row.message.role)).toEqual(["user"]);
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map([[answerId, 1]])}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded
        onToggleAllDirectories={() => {}}
      />,
    );
    expect(markup).toContain('data-slot="user-input-card"');
    expect(markup).toContain(">Asked 1 question</span>");
    expect(markup).toContain("“Signed in”</li>");
    expect(markup).not.toContain('data-slot="user-message-bubble"');
    expect(markup).not.toContain("{&quot;0&quot;");
    expect(markup).toContain('aria-label="Revert to before this message"');
  });
  it("labels the working row with the live activity, not the last finished tool", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const timelineEntries: TimelineEntry[] = [
      {
        id: "finished-tool-entry",
        kind: "work",
        createdAt,
        entry: {
          id: "finished-tool-work",
          createdAt,
          label: "Finished lookup",
          tone: "tool",
          itemType: "dynamic_tool_call",
        },
      },
      {
        id: "running-tool-entry",
        kind: "work",
        createdAt,
        entry: {
          id: "running-tool-work",
          createdAt,
          label: "Running lookup",
          tone: "tool",
          itemType: "dynamic_tool_call",
          providerItemId: ProviderItemId.makeUnsafe("item-running"),
          status: "inProgress",
        },
      },
      {
        id: "running-command-entry",
        kind: "command",
        createdAt,
        commandExecution: {
          id: "running-command",
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: ProviderItemId.makeUnsafe("cmd-running"),
          command: "/bin/zsh -lc 'bun run test'",
          title: "Ran command",
          status: "running",
          detail: null,
          exitCode: null,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
          startedSequence: 1,
          lastUpdatedSequence: 1,
        },
      } as unknown as TimelineEntry,
    ];
    const streamingEntry: TimelineEntry = {
      id: "streaming-entry",
      kind: "message",
      createdAt,
      message: {
        id: MessageId.makeUnsafe("assistant-streaming"),
        role: "assistant",
        text: "Partial answer",
        createdAt,
        streaming: true,
      },
    };
    const queryClient = new QueryClient();
    const render = (liveActivity: LiveWorkActivity, entries = timelineEntries) =>
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <MessagesTimeline
            hasMessages
            isWorking
            activeTurnStartedAt={createdAt}
            liveActivity={liveActivity}
            listRef={{ current: null }}
            onIsAtEndChange={() => {}}
            timelineEntries={entries}
            completionDividerBeforeEntryId={null}
            completionSummary={null}
            turnDiffSummaryByAssistantMessageId={new Map()}
            turnDiffSummaryByTurnId={new Map()}
            expandedWorkGroups={{}}
            onToggleWorkGroup={() => {}}
            onOpenTurnDiff={() => {}}
            revertTurnCountByUserMessageId={new Map()}
            onRevertUserMessage={() => {}}
            isRevertingCheckpoint={false}
            onImageExpand={() => {}}
            markdownCwd={undefined}
            resolvedTheme="light"
            timestampFormat="locale"
            workspaceRoot={undefined}
            expandedCommandExecutions={{}}
            onToggleCommandExecution={() => {}}
            allDirectoriesExpanded
            onToggleAllDirectories={() => {}}
          />
        </QueryClientProvider>,
      );
    const workingActivity = (markup: string) =>
      /· ([^<]*)<\/span>/.exec(markup.replaceAll("<!-- -->", ""))?.[1] ?? null;

    expect(workingActivity(render({ kind: "thinking", detail: null }))).toBe("Thinking");
    expect(workingActivity(render({ kind: "thinking", detail: "Inspecting adapter" }))).toBe(
      "Thinking: Inspecting adapter",
    );
    expect(
      workingActivity(
        render({ kind: "tool", providerItemId: "item-running", title: "fallback title" }),
      ),
    ).toBe("Running lookup");
    expect(
      workingActivity(
        render({ kind: "tool", providerItemId: "cmd-running", title: "Ran command" }),
      ),
    ).toBe("bun run test");
    expect(
      workingActivity(render({ kind: "tool", providerItemId: "item-missing", title: "Grep" })),
    ).toBe("Grep");
    // The latest thought stays above the tool that followed it.
    const withThought = render({
      kind: "tool",
      providerItemId: "item-missing",
      title: "Grep",
      thought: "Found the cause in the adapter",
    });
    expect(workingActivity(withThought)).toBe("Grep");
    expect(withThought).toMatch(/data-working-thought=""[^]*Found the cause in the adapter/);
    expect(render({ kind: "tool", providerItemId: "item-missing", title: "Grep" })).not.toContain(
      "data-working-thought",
    );
    expect(workingActivity(render(null))).toBeNull();
    expect(workingActivity(render({ kind: "reconnecting", attempt: "2/5" }))).toBe(
      "Reconnecting (2/5)",
    );
    expect(workingActivity(render({ kind: "reconnecting", attempt: null }))).toBe("Reconnecting");
    expect(workingActivity(render({ kind: "idle" }))).toBe("Thinking");
    // Streaming text already shows what the model is doing.
    expect(
      workingActivity(render({ kind: "idle" }, [...timelineEntries, streamingEntry])),
    ).toBeNull();
  });

  it("keeps file-change rows visible when routine work exceeds the page size", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const createdAt = "2026-03-17T19:12:28.000Z";
    const timelineEntries: TimelineEntry[] = [
      {
        id: "always-visible-file-change-entry",
        kind: "work",
        createdAt,
        entry: {
          id: "always-visible-file-change-work",
          createdAt,
          label: "File change",
          tone: "tool",
          itemType: "file_change",
          changedFiles: ["apps/web/src/always-visible.ts"],
        },
      },
      ...Array.from({ length: 8 }, (_, index): TimelineEntry => {
        const activityNumber = index + 1;
        return {
          id: `routine-entry-${activityNumber}`,
          kind: "work",
          createdAt: new Date(Date.parse(createdAt) + activityNumber * 1_000).toISOString(),
          entry: {
            id: `routine-work-${activityNumber}`,
            createdAt: new Date(Date.parse(createdAt) + activityNumber * 1_000).toISOString(),
            label: `Routine activity ${String(activityNumber).padStart(2, "0")}`,
            tone: "tool",
            itemType: "dynamic_tool_call",
          },
        };
      }),
    ];
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain("apps/web/src/always-visible.ts");
    expect(markup).not.toContain("Routine activity 01");
    expect(markup).not.toContain("Routine activity 02");
    expect(markup).toContain("Routine activity 08");
    expect(markup).toContain("Show 2 more");
  });

  it("renders the changed filename inline for file-change rows with one file", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              detail: "Updated file contents",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.tsx"],
              tone: "tool",
              requestKind: "file-change",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="File change - apps/web/src/components/chat/MessagesTimeline.tsx"',
    );
    expect(markup).toContain('title="apps/web/src/components/chat/MessagesTimeline.tsx"');
    expect(markup).toContain(">apps/web/src/components/chat/MessagesTimeline.tsx</button>");
    expect(markup).not.toContain('title="File change - Updated file contents"');
  });

  it("renders the first changed filename inline for multi-file change rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              detail: "Updated file contents",
              changedFiles: [
                "apps/web/src/components/chat/MessagesTimeline.tsx",
                "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                "apps/web/src/session-logic.ts",
              ],
              tone: "tool",
              itemType: "file_change",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="File change - apps/web/src/components/chat/MessagesTimeline.tsx +2 more"',
    );
    expect(markup).toContain('title="apps/web/src/components/chat/MessagesTimeline.tsx"');
    expect(markup).toContain(">apps/web/src/components/chat/MessagesTimeline.tsx</button>");
    expect(markup).not.toContain('title="File change - Updated file contents"');
  });

  it("keeps command rows preferring the command preview", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              detail: "Formatted files",
              command: "bun fmt",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.tsx"],
              tone: "tool",
              requestKind: "command",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="Ran command - bun fmt"');
    expect(markup).not.toContain(
      'title="Ran command - apps/web/src/components/chat/MessagesTimeline.tsx"',
    );
  });

  it("renders compact search command rows consistently across lifecycle and transcript paths", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-search-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-search-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label:
                "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
              toolTitle:
                "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
              command:
                "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 20",
              itemType: "command_execution",
              tone: "tool",
              requestKind: "command",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …"',
    );
    expect(markup).toContain("lucide-search");
    expect(markup).not.toContain("chat\\\\.newLocal");
    expect(markup).not.toContain("rg -n");
    expect(markup).not.toContain("lucide-eye");
    expect(markup).not.toContain("lucide-terminal");
  });

  it("renders nested subagent call and result sections for collaborative agent rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-subagent-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-subagent-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              toolTitle: "Explore agent",
              itemType: "collab_agent_tool_call",
              tone: "tool",
              subagentType: "Explore",
              subagentPrompt:
                "Inspect the repo structure and identify the main orchestration entry points.",
              subagentResult:
                "Found three orchestration entry points and one shared provider adapter.",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="Explore agent - Found three orchestration entry points and one shared provider adapter."',
    );
    expect(markup).toContain("Tool Call");
    expect(markup).toContain(
      "Inspect the repo structure and identify the main orchestration entry points.",
    );
    expect(markup).toContain("Result");
    expect(markup).toContain(
      "Found three orchestration entry points and one shared provider adapter.",
    );
  });

  it("renders Codex collaboration prompts and compact receiver responses", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-codex-collab",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-codex-collab",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Collaboration call",
              itemType: "collab_agent_tool_call",
              tone: "error",
              status: "failed",
              codexCollaborationTool: "sendInput",
              subagentPrompt: "Review the reconnect path",
              subagentReceiverThreadIds: ["agent-b", "agent-a"],
              subagentStates: [
                { threadId: "agent-b", status: "errored", message: "Connection failed" },
                { threadId: "agent-a", status: "completed", message: "Review complete" },
              ],
              subagentStatesTruncated: true,
            },
          },
          {
            id: "entry-codex-empty-wait",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-codex-empty-wait",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Collaboration call",
              itemType: "collab_agent_tool_call",
              tone: "tool",
              status: "completed",
              codexCollaborationTool: "wait",
              subagentPrompt: "Check whether any reviews finished",
              subagentReceiverThreadIds: ["agent-c"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain("Message delivery failed");
    expect(markup).toContain("Review the reconnect path");
    expect(markup).toContain('title="Message delivery failed - Review the reconnect path"');
    expect(markup).not.toContain("Tool Call");
    expect(markup).toContain("Errored - Connection failed");
    expect(markup).toContain("Completed - Review complete");
    expect(markup.indexOf("agent-b")).toBeLessThan(markup.indexOf("agent-a"));
    expect(markup).toContain("Additional agent details omitted");
    expect(markup).toContain("Finished waiting");
    expect(markup).toContain("No agents completed yet.");
  });

  it("renders parsed server and tool names for compact MCP rows by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-mcp-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              detail: "mcp__filesystem__list_allowed_directories: {}",
              itemType: "mcp_tool_call",
              tone: "tool",
              mcpServerName: "filesystem",
              mcpToolName: "list_allowed_directories",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="MCP Call - Filesystem: List Allowed Directories"');
    expect(markup).toContain('viewBox="0 0 180 180"');
    expect(markup).not.toContain("mcp__filesystem__list_allowed_directories: {}");
  });

  it("formats MCP identifiers without duplicate spacing in compact row labels", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-mcp-formatting",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-formatting",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              itemType: "mcp_tool_call",
              tone: "tool",
              mcpServerName: "filesystem_api",
              mcpToolName: "fetch_pull_request__with_comments",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="MCP Call - Filesystem Api: Fetch Pull Request With Comments"');
    expect(markup).not.toContain("Pull Request  With");
  });

  it("keeps consecutive MCP work entries grouped when MCP expansion is off", async () => {
    setPersistedAppSettings({ expandMcpToolCalls: false });

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-mcp-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              itemType: "mcp_tool_call",
              tone: "tool",
              mcpServerName: "filesystem",
              mcpToolName: "list_allowed_directories",
            },
          },
          {
            id: "entry-mcp-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-mcp-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "MCP tool call",
              itemType: "mcp_tool_call",
              tone: "tool",
              mcpServerName: "github",
              mcpToolName: "fetch_pull_request",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('data-timeline-row-id="entry-mcp-1"');
    expect(markup).not.toContain('data-timeline-row-id="entry-mcp-2"');
  });

  it("groups back-to-back MCP calls of a turn into one card", async () => {
    setPersistedAppSettings({ expandMcpToolCalls: true });

    const markup = await renderMcpTimelineMarkup([
      mcpWorkEntry("entry-mcp-1", {
        startedAt: "2026-03-17T19:12:27.000Z",
        mcpServerName: "filesystem",
        mcpToolName: "list_allowed_directories",
      }),
      mcpWorkEntry("entry-mcp-2", {
        createdAt: "2026-03-17T19:12:31.000Z",
        mcpServerName: "github",
        mcpToolName: "fetch_pull_request",
      }),
    ]);

    expect(markup).toContain('data-timeline-row-id="entry-mcp-1"');
    expect(markup).not.toContain('data-timeline-row-id="entry-mcp-2"');
    expect(markup).toContain('data-mcp-call-count="2"');
    expect(markup.match(/data-slot="mcp-tool-call"/g)).toHaveLength(2);
    expect(markup).toContain('data-testid="mcp-card-call-count">2 calls · 4.0s</span>');
    expect(markup).toContain('data-mcp-server-icon="github"');
    expect(markup).toContain('data-mcp-server-icon="monogram"');
  });

  it("splits MCP card groups at other tool rows and turn changes", async () => {
    const { buildTimelineRows, createTimelineRowCache, MCP_CARD_MAX_CALLS } =
      await import("./MessagesTimeline");
    const turnA = TurnId.makeUnsafe("turn-a");
    const turnB = TurnId.makeUnsafe("turn-b");
    const call = (id: string, turnId: TurnId) =>
      mcpWorkEntry(id, { turnId, mcpServerName: "docs", mcpToolName: "read" });
    const userMessage: TimelineEntry = {
      id: "user-next",
      kind: "message",
      createdAt: "2026-03-17T19:12:28.000Z",
      message: {
        id: MessageId.makeUnsafe("user-next"),
        role: "user",
        text: "Next",
        createdAt: "2026-03-17T19:12:28.000Z",
        streaming: false,
      },
    };
    const thought: TimelineEntry = {
      id: "thought",
      kind: "work",
      createdAt: "2026-03-17T19:12:28.000Z",
      entry: {
        id: "work-thought",
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Thinking",
        tone: "thinking",
      },
    };
    const build = (expandMcpToolCalls: boolean) =>
      buildTimelineRows({
        timelineEntries: [
          call("m1", turnA),
          call("m2", turnA),
          thought,
          call("m3", turnA),
          call("m4", turnB),
          call("m5", turnB),
          userMessage,
        ],
        completionDividerBeforeEntryId: null,
        completionSummary: null,
        isWorking: false,
        activeTurnStartedAt: null,
        liveActivity: null,
        expandMcpToolCalls,
        cache: createTimelineRowCache(),
      });

    const rows = build(true);
    expect(
      rows.flatMap((row) =>
        row.kind === "work"
          ? [[row.mcpGroup ?? false, row.groupedEntries.map((entry) => entry.id)]]
          : [],
      ),
    ).toEqual([
      [true, ["work-m1", "work-m2"]],
      [false, ["work-thought"]],
      [true, ["work-m3"]],
      [true, ["work-m4", "work-m5"]],
    ]);
    // Tool rows tighten up against the next tool row, but keep their gap before a message.
    const compactIds = (built: ReturnType<typeof buildTimelineRows>) =>
      built.flatMap((row) =>
        (row.kind === "work" || row.kind === "command") && row.compactBottom ? [row.id] : [],
      );
    expect(compactIds(rows)).toEqual(["m1", "thought", "m3"]);

    // With the setting off, MCP calls stay in the plain work log.
    expect(build(false).some((row) => row.kind === "work" && row.mcpGroup)).toBe(false);

    // A long run splits into capped cards.
    const longRun = Array.from({ length: MCP_CARD_MAX_CALLS + 3 }, (_, index) =>
      call(`long-${index}`, turnA),
    );
    const longRows = buildTimelineRows({
      timelineEntries: longRun,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: true,
      cache: createTimelineRowCache(),
    });
    expect(longRows.map((row) => (row.kind === "work" ? row.groupedEntries.length : 0))).toEqual([
      MCP_CARD_MAX_CALLS,
      3,
    ]);
  });

  it("tightens a tool row when another lands below it, keeping unchanged rows", async () => {
    const { buildTimelineRows, createTimelineRowCache } = await import("./MessagesTimeline");
    const cache = createTimelineRowCache();
    const first = mcpWorkEntry("first", { mcpServerName: "docs", mcpToolName: "read" });
    const thought: TimelineEntry = {
      id: "thought",
      kind: "work",
      createdAt: "2026-03-17T19:12:29.000Z",
      entry: {
        id: "work-thought",
        createdAt: "2026-03-17T19:12:29.000Z",
        label: "Thinking",
        tone: "thinking",
      },
    };
    const build = (timelineEntries: TimelineEntry[]) =>
      buildTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId: null,
        completionSummary: null,
        isWorking: false,
        activeTurnStartedAt: null,
        liveActivity: null,
        expandMcpToolCalls: true,
        cache,
      });

    const [alone] = build([first]);
    expect(alone?.kind === "work" && alone.compactBottom).toBeFalsy();
    const [tightened, after] = build([first, thought]);
    // A new row object, so the list re-renders the earlier row with its tighter gap.
    expect(tightened).not.toBe(alone);
    expect(tightened?.kind === "work" && tightened.compactBottom).toBe(true);
    const third = mcpWorkEntry("third", {
      createdAt: "2026-03-17T19:12:30.000Z",
      mcpServerName: "docs",
      mcpToolName: "read",
    });
    const next = build([first, thought, third]);
    expect(next[0]).toBe(tightened);
    expect(next[1]).not.toBe(after);
    expect(next[1]?.kind === "work" && next[1].compactBottom).toBe(true);
  });

  it("renders collapsed MCP cards with input and result previews", async () => {
    setPersistedAppSettings({
      expandMcpToolCalls: true,
      expandMcpToolCallCardsByDefault: false,
    });

    const markup = await renderMcpTimelineMarkup([
      mcpWorkEntry("entry-mcp-card-collapsed", {
        status: "completed",
        mcpServerName: "filesystem",
        mcpServerLabel: "Filesystem",
        mcpToolName: "read_text_file",
        mcpInput: '{\n  "path": "README.md"\n}',
        mcpResult: "\nread successfully\nsecond line",
      }),
    ]);

    expect(markup).not.toContain('data-testid="mcp-badge"');
    expect(markup).toContain('data-testid="mcp-card-header"');
    expect(markup).toContain('<span class="font-semibold tracking-wide">MCP</span>');
    // A single call has no call count in the header.
    expect(markup).not.toContain('data-testid="mcp-card-call-count"');
    expect(markup).toContain(">Filesystem ›</span>");
    expect(markup).toContain('data-testid="mcp-input-summary">path: &quot;README.md&quot;</p>');
    expect(markup).toContain('data-testid="mcp-result-preview">→ read successfully</p>');
    expect(markup).not.toContain("second line");
    expect(markup).not.toContain("border-t border-border/60 px-3 py-3");
  });

  it("shows a failed MCP call's error line and accent while collapsed", async () => {
    setPersistedAppSettings({
      expandMcpToolCalls: true,
      expandMcpToolCallCardsByDefault: false,
    });

    const markup = await renderMcpTimelineMarkup([
      mcpWorkEntry("entry-mcp-ok", {
        status: "completed",
        mcpServerName: "docs",
        mcpToolName: "read",
        mcpResult: "ok",
      }),
      mcpWorkEntry("entry-mcp-failed", {
        status: "failed",
        tone: "error",
        mcpServerName: "docs",
        mcpToolName: "write",
        mcpResult: "Permission denied: docs are read-only",
      }),
    ]);

    expect(markup).toContain("border-l-destructive/80");
    expect(markup).toContain('data-status="failed"');
    expect(markup).toMatch(
      /text-destructive-foreground" data-testid="mcp-result-preview">Permission denied: docs are read-only<\/p>/,
    );
  });

  it("lists a grouped MCP call's hook diagnostics, and its time when it has no duration", async () => {
    setPersistedAppSettings({
      expandMcpToolCalls: true,
      expandMcpToolCallCardsByDefault: false,
    });

    const markup = await renderMcpTimelineMarkup([
      mcpWorkEntry("entry-mcp-first", {
        status: "completed",
        mcpServerName: "docs",
        mcpToolName: "read",
      }),
      mcpWorkEntry("entry-mcp-hooked", {
        status: "completed",
        mcpServerName: "docs",
        mcpToolName: "write",
        nestedDiagnostics: [
          {
            id: "hook-work",
            createdAt: "2026-03-17T19:12:28.100Z",
            label: "preToolUse hook blocked the call",
            tone: "error",
            activityKind: "hook.completed",
            category: "hook",
            isIssue: true,
            diagnostic: {
              type: "hook",
              id: "hook-1",
              hookEvent: "preToolUse",
              source: "plugin",
              sourcePath: "/Users/example/.claude/hooks.json",
              handlerType: "command",
              displayOrder: 1,
              status: "failed",
              durationMs: 9,
              entries: [],
            },
          },
        ],
      }),
    ]);

    expect(markup).toContain('data-mcp-call-count="2"');
    expect(markup).toContain("preToolUse hook blocked the call");
    expect(markup.match(/preToolUse hook blocked the call/g)).toHaveLength(1);
    // Neither call has a start time, so each shows when it happened instead.
    expect(markup.match(/data-testid="mcp-call-time"/g)).toHaveLength(2);
  });

  it("renders expanded MCP rows with transcript-style card chrome", async () => {
    setPersistedAppSettings({ expandMcpToolCalls: true });

    const markup = await renderMcpTimelineMarkup([
      mcpWorkEntry("entry-mcp-card", {
        startedAt: "2026-03-17T19:12:27.160Z",
        status: "completed",
        mcpServerName: "filesystem",
        mcpToolName: "read_text_file",
        mcpInput: '{\n  "path": "README.md"\n}',
        mcpResult: "read successfully",
      }),
    ]);

    expect(markup).toContain("group rounded-xl border border-l-2 border-border/60 bg-card/35");
    expect(markup).toContain("border-l-success/70");
    expect(markup).toContain('data-slot="mcp-tool-card"');
    expect(markup).toContain("border-t border-border/60 px-3 py-3 pl-17");
    expect(markup).toContain('viewBox="0 0 180 180"');
    expect(markup).toContain(">filesystem ›</span>");
    expect(markup).toContain(">read_text_file</span>");
    expect(markup).not.toContain('data-testid="mcp-badge"');
    expect(markup).toContain('approval wait">840ms</span>');
    // The status icon leads the row, ahead of the server name.
    const statusIndex = markup.indexOf('role="img" aria-label="Completed"');
    expect(statusIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeLessThan(markup.indexOf(">filesystem ›</span>"));
    expect(markup).toContain('data-testid="mcp-input-grid"');
    expect(markup).toContain(">path</dt>");
    expect(markup).toContain(">README.md</dd>");
    expect(markup).toContain('aria-label="Copy input"');
    expect(markup).toContain('aria-label="Copy result"');
    // Open cards show the full input below instead of the one-line summary.
    expect(markup).not.toContain('data-testid="mcp-input-summary"');
    expect(markup).not.toContain('data-testid="mcp-result-preview"');
    expect(markup).not.toContain("rounded-xl border border-border/45 bg-card/25 px-2 py-1.5");
    expect(markup).not.toContain(
      '<span class="text-[10px] text-muted-foreground">Filesystem</span>',
    );
    expect(markup).not.toContain("line-clamp-2 text-[12px] leading-5 text-muted-foreground");
    expect(markup).not.toContain(
      '<span class="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75">read_text_file</span>',
    );
  });

  it("includes file-read line summaries inline without rendering duplicate file chips", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              detail: "lines 120-180",
              changedFiles: ["apps/server/src/provider/Layers/ClaudeAdapter.test.ts"],
              tone: "tool",
              requestKind: "file-read",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="Read file - apps/server/src/provider/Layers/ClaudeAdapter.test.ts (lines 120-180)"',
    );
    expect(markup).toContain('title="apps/server/src/provider/Layers/ClaudeAdapter.test.ts"');
    expect(markup).toContain(">apps/server/src/provider/Layers/ClaudeAdapter.test.ts</button>");
    expect(markup).not.toContain(
      'title="apps/server/src/provider/Layers/ClaudeAdapter.test.ts" role="button"',
    );
  });

  it("renders file-read previews relative to the execution cwd when available", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              cwd: "/repo/project/atlantis-docker",
              changedFiles: ["Dockerfile"],
              tone: "tool",
              requestKind: "file-read",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="Read file - atlantis-docker/Dockerfile"');
    expect(markup).toContain('title="atlantis-docker/Dockerfile"');
    expect(markup).toContain(">atlantis-docker/Dockerfile</button>");
  });

  it("renders tool-call file-read payload details as inline file links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read",
              toolTitle: "Read",
              detail: '{"file_path":"/repo/project/package.json"}',
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="Read - package.json"');
    expect(markup).toContain('title="package.json"');
    expect(markup).toContain(">package.json</button>");
    expect(markup).not.toContain("{&quot;file_path&quot;:&quot;/repo/project/package.json&quot;}");
  });

  it("renders prefixed tool-call file-read payload details as inline file links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Tool call",
              detail: 'Read: {"file_path":"/repo/project/vitest.config.ts"}',
              itemType: "dynamic_tool_call",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="File read - vitest.config.ts"');
    expect(markup).toContain('title="vitest.config.ts"');
    expect(markup).toContain(">vitest.config.ts</button>");
    expect(markup).not.toContain(
      "Read: {&quot;file_path&quot;:&quot;/repo/project/vitest.config.ts&quot;}",
    );
  });

  it("renders Claude file-read bare path details as inline file links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File read",
              detail: "apps/server/package.json",
              itemType: "dynamic_tool_call",
              requestKind: "file-read",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="File read - apps/server/package.json"');
    expect(markup).toContain('title="apps/server/package.json"');
    expect(markup).toContain(">apps/server/package.json</button>");
  });

  it("renders normalized Claude read-path hints as inline file links with range text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              toolTitle: "Read file",
              itemType: "dynamic_tool_call",
              requestKind: "file-read",
              readPaths: ["apps/server/src/provider/Layers/ClaudeAdapter.ts"],
              lineSummary: "lines 120-180",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="Read file - apps/server/src/provider/Layers/ClaudeAdapter.ts (lines 120-180)"',
    );
    expect(markup).toContain('title="apps/server/src/provider/Layers/ClaudeAdapter.ts"');
    expect(markup).toContain(">apps/server/src/provider/Layers/ClaudeAdapter.ts</button>");
    expect(markup).toContain("> (lines 120-180)</span>");
  });

  it("renders deduped provider-item read worklog rows only once while preserving range text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-read-updated"),
        tone: "tool",
        kind: "tool.updated",
        summary: "Tool updated",
        payload: {
          itemType: "dynamic_tool_call",
          providerItemId: "provider-item-1",
          title: "Read file",
          requestKind: "file-read",
          readPaths: ["apps/server/src/provider/Layers/ClaudeAdapter.ts"],
          lineSummary: "lines 120-180",
        },
        turnId: null,
        createdAt: "2026-03-17T19:12:28.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-read-completed"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool",
        payload: {
          itemType: "dynamic_tool_call",
          providerItemId: "provider-item-1",
          title: "Read file",
          requestKind: "file-read",
          readPaths: ["apps/server/src/provider/Layers/ClaudeAdapter.ts"],
          lineSummary: "lines 120-180",
        },
        turnId: null,
        createdAt: "2026-03-17T19:12:29.000Z",
      },
    ];
    const timelineEntries = deriveTimelineEntries(
      [],
      [],
      deriveWorkLogEntries(activities, undefined),
    );
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(
      markup.match(/>apps\/server\/src\/provider\/Layers\/ClaudeAdapter\.ts<\/button>/g) ?? [],
    ).toHaveLength(1);
    expect(markup).toContain("> (lines 120-180)</span>");
  });

  it("renders normalized Claude search hints as compact search rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-search-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-search-2",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Searching apps/web/src/components for **/*.test.tsx",
              toolTitle: "Searching apps/web/src/components for **/*.test.tsx",
              itemType: "dynamic_tool_call",
              searchSummary: "Searching apps/web/src/components for **/*.test.tsx",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="Searching apps/web/src/components for **/*.test.tsx"');
    expect(markup).toContain("lucide-search");
    expect(markup).not.toContain("lucide-terminal");
    expect(markup).not.toContain("lucide-hammer");
  });

  it("renders reasoning-update read hints with file-read headings", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-reasoning-read",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-reasoning-read",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Reasoning update",
              readPaths: ["apps/web/src/components/ui/alert.tsx"],
              lineSummary: "lines 120-180",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="File read - apps/web/src/components/ui/alert.tsx (lines 120-180)"',
    );
    expect(markup).toContain("lucide-eye");
    expect(markup).not.toContain(">Reasoning update</span>");
  });

  it("renders reasoning-update search hints as compact search rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-reasoning-search",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-reasoning-search",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Reasoning update",
              searchSummary: "Searching apps/web/src for serverConfigQuery, useServerConfig",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="Searching apps/web/src for serverConfigQuery, useServerConfig"',
    );
    expect(markup).toContain("lucide-search");
    expect(markup).not.toContain(">Reasoning update</span>");
  });

  it("renders Claude file-change bare path details as inline file links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              detail: "apps/server/README.md",
              itemType: "file_change",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="File change - apps/server/README.md"');
    expect(markup).toContain('title="apps/server/README.md"');
    expect(markup).toContain(">apps/server/README.md</button>");
  });

  it("renders prefixed tool-call write payload details as inline file links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Tool call",
              detail: 'Write: {"file_path":"/repo/project/scratch.txt"}',
              itemType: "dynamic_tool_call",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain('title="Write file - scratch.txt"');
    expect(markup).toContain('title="scratch.txt"');
    expect(markup).toContain(">scratch.txt</button>");
    expect(markup).not.toContain(
      "Write: {&quot;file_path&quot;:&quot;/repo/project/scratch.txt&quot;}",
    );
  });

  it("renders read-command worklog rows as inline file links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              command:
                "/bin/zsh -lc 'sed -n 1,220p apps/server/src/provider/Layers/ClaudeSdk.testUtils.ts'",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="File read - apps/server/src/provider/Layers/ClaudeSdk.testUtils.ts (lines 1-220)"',
    );
    expect(markup).toContain('title="apps/server/src/provider/Layers/ClaudeSdk.testUtils.ts"');
    expect(markup).toContain(">apps/server/src/provider/Layers/ClaudeSdk.testUtils.ts</button>");
    expect(markup).toContain("> (lines 1-220)</span>");
    expect(markup).not.toContain("/bin/zsh -lc");
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("falls back to workspace-relative turn diff files for file-change previews when activity data is empty", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId,
              label: "File change",
              tone: "tool",
              itemType: "file_change",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={
          new Map([
            [
              turnId,
              {
                turnId,
                completedAt: "2026-03-17T19:12:30.000Z",
                files: [
                  {
                    path: "/repo/project/apps/web/src/components/chat/MessagesTimeline.tsx",
                  },
                  {
                    path: "/repo/project/apps/web/src/components/ChatView.tsx",
                  },
                ],
              },
            ],
          ])
        }
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain(
      'title="File change - apps/web/src/components/chat/MessagesTimeline.tsx +1 more"',
    );
    expect(markup).toContain('title="apps/web/src/components/chat/MessagesTimeline.tsx"');
    expect(markup).toContain(">apps/web/src/components/chat/MessagesTimeline.tsx</button>");
    expect(markup).not.toContain('title="File change - /repo/project/');
  });

  it("keeps file-change rows compact when inline diffs are disabled", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: false });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-inline-off",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-off",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: TurnId.makeUnsafe("turn-inline-off"),
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              changedFiles: ["packages/foo/src/bar.ts"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).not.toContain('data-testid="inline-file-diff"');
  });

  it("keeps completed file-change rows compact until a fallback checkpoint turn count is known", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-inline-waiting");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-inline-waiting",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-waiting",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId,
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              changedFiles: ["packages/foo/src/bar.ts"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
        chatDiffContext={DEFAULT_CHAT_DIFF_CONTEXT}
      />,
    );

    expect(markup).not.toContain("Show diff");
    expect(markup).not.toContain('data-testid="inline-file-diff"');
  });

  it("renders inline file-change diffs from the shared turn diff cache", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const threadId = ThreadId.makeUnsafe("thread-inline-happy");
    const turnId = TurnId.makeUnsafe("turn-inline-happy");
    const queryClient = makeQueryClient();
    preloadTurnDiff({
      queryClient,
      threadId,
      turnId,
      checkpointTurnCount: 2,
      diff: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1,2 +1,3 @@",
        " export const a = 1;",
        "-export const c = 3;",
        "+export const b = 2;",
        "+export const c = 4;",
      ].join("\n"),
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={{ current: null }}
          onIsAtEndChange={() => {}}
          timelineEntries={[
            {
              id: "entry-inline-happy",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-inline-happy",
                createdAt: "2026-03-17T19:12:28.000Z",
                turnId,
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                changedFiles: ["packages/foo/src/bar.ts"],
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  completedAt: "2026-03-17T19:12:30.000Z",
                  checkpointTurnCount: 2,
                  files: [
                    {
                      path: "packages/foo/src/bar.ts",
                      additions: 2,
                      deletions: 1,
                    },
                  ],
                },
              ],
            ])
          }
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo/project"
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={true}
          onToggleAllDirectories={() => {}}
          chatDiffContext={{
            ...DEFAULT_CHAT_DIFF_CONTEXT,
            threadId,
            expandedFileChangeDiffs: { "work-inline-happy": true },
            inferredCheckpointTurnCountByTurnId: { [turnId]: 2 },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="inline-file-diff"');
    expect(markup).toContain("+2 / -1");
    expect(markup).toContain("packages/foo/src/bar.ts");
    expect(markup).toContain("export const b = 2;");
    expect(markup).toContain("View full diff");
  });

  it("renders fallback inline file-change diffs when provider changedFiles is empty", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const threadId = ThreadId.makeUnsafe("thread-inline-claude-fallback");
    const turnId = TurnId.makeUnsafe("turn-inline-claude-fallback");
    const queryClient = makeQueryClient();
    preloadTurnDiff({
      queryClient,
      threadId,
      turnId,
      checkpointTurnCount: 2,
      diff: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const claudeFallback = true;",
      ].join("\n"),
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={{ current: null }}
          onIsAtEndChange={() => {}}
          timelineEntries={[
            {
              id: "entry-inline-claude-fallback",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-inline-claude-fallback",
                createdAt: "2026-03-17T19:12:28.000Z",
                turnId,
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                changedFiles: [],
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  completedAt: "2026-03-17T19:12:30.000Z",
                  checkpointTurnCount: 2,
                  files: [
                    {
                      path: "packages/foo/src/bar.ts",
                      additions: 1,
                      deletions: 0,
                    },
                  ],
                },
              ],
            ])
          }
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo/project"
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={true}
          onToggleAllDirectories={() => {}}
          chatDiffContext={{
            ...DEFAULT_CHAT_DIFF_CONTEXT,
            threadId,
            expandedFileChangeDiffs: { "work-inline-claude-fallback": true },
            inferredCheckpointTurnCountByTurnId: { [turnId]: 2 },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="inline-file-diff"');
    expect(markup).toContain("packages/foo/src/bar.ts");
    expect(markup).toContain("claudeFallback = true");
    expect(markup).toContain("View full diff");
  });

  it("still renders fallback inline diffs when checkpoint turn count is 0", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const threadId = ThreadId.makeUnsafe("thread-inline-zero");
    const turnId = TurnId.makeUnsafe("turn-inline-zero");
    const queryClient = makeQueryClient();
    preloadTurnDiff({
      queryClient,
      threadId,
      turnId,
      checkpointTurnCount: 0,
      diff: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const zero = true;",
      ].join("\n"),
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={{ current: null }}
          onIsAtEndChange={() => {}}
          timelineEntries={[
            {
              id: "entry-inline-zero",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-inline-zero",
                createdAt: "2026-03-17T19:12:28.000Z",
                turnId,
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                changedFiles: ["packages/foo/src/bar.ts"],
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  completedAt: "2026-03-17T19:12:30.000Z",
                  checkpointTurnCount: 0,
                  files: [{ path: "packages/foo/src/bar.ts", additions: 1, deletions: 0 }],
                },
              ],
            ])
          }
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo/project"
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={true}
          onToggleAllDirectories={() => {}}
          chatDiffContext={{
            ...DEFAULT_CHAT_DIFF_CONTEXT,
            threadId,
            expandedFileChangeDiffs: { "work-inline-zero": true },
            inferredCheckpointTurnCountByTurnId: { [turnId]: 0 },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="inline-file-diff"');
    expect(markup).toContain("zero = true");
  });

  it("renders exact inline file-change diffs from transcript cache even outside git", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const threadId = ThreadId.makeUnsafe("thread-inline-exact");
    const fileChangeId = OrchestrationFileChangeId.makeUnsafe(
      "filechange:thread-inline-exact:item-1",
    );
    const queryClient = makeQueryClient();
    preloadThreadFileChange({
      queryClient,
      threadId,
      fileChangeId,
      patch: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const exact = true;",
      ].join("\n"),
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={{ current: null }}
          onIsAtEndChange={() => {}}
          timelineEntries={[
            {
              id: "entry-inline-exact",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-inline-exact",
                createdAt: "2026-03-17T19:12:28.000Z",
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                changedFiles: ["packages/foo/src/bar.ts"],
                fileChangeId,
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={new Map()}
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo/project"
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={true}
          onToggleAllDirectories={() => {}}
          chatDiffContext={{
            ...DEFAULT_CHAT_DIFF_CONTEXT,
            threadId,
            isGitRepo: false,
            expandedFileChangeDiffs: { "work-inline-exact": true },
            fileChangeSummariesById: {
              [fileChangeId]: {
                id: fileChangeId,
                threadId,
                turnId: TurnId.makeUnsafe("turn-inline-exact"),
                providerItemId: ProviderItemId.makeUnsafe("provider-item-1"),
                title: "File change",
                detail: "Apply patch",
                status: "completed",
                changedFiles: ["packages/foo/src/bar.ts"],
                startedAt: "2026-03-17T19:12:28.000Z",
                completedAt: "2026-03-17T19:12:29.000Z",
                updatedAt: "2026-03-17T19:12:29.000Z",
                startedSequence: 10,
                lastUpdatedSequence: 11,
                hasPatch: true,
              },
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="inline-file-diff"');
    expect(markup).toContain("packages/foo/src/bar.ts");
    expect(markup).toContain("exact = true");
    expect(markup).toContain("View full diff");
  });

  it("falls back to the V1 turn diff when the exact transcript patch is unparseable", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const threadId = ThreadId.makeUnsafe("thread-inline-exact-fallback");
    const turnId = TurnId.makeUnsafe("turn-inline-exact-fallback");
    const fileChangeId = OrchestrationFileChangeId.makeUnsafe(
      "filechange:thread-inline-exact-fallback:item-1",
    );
    const queryClient = makeQueryClient();
    preloadThreadFileChange({
      queryClient,
      threadId,
      fileChangeId,
      patch: "this is not a unified diff",
    });
    preloadTurnDiff({
      queryClient,
      threadId,
      turnId,
      checkpointTurnCount: 2,
      diff: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const fallback = true;",
      ].join("\n"),
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={{ current: null }}
          onIsAtEndChange={() => {}}
          timelineEntries={[
            {
              id: "entry-inline-exact-fallback",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-inline-exact-fallback",
                createdAt: "2026-03-17T19:12:28.000Z",
                turnId,
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
                changedFiles: ["packages/foo/src/bar.ts"],
                fileChangeId,
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  completedAt: "2026-03-17T19:12:30.000Z",
                  checkpointTurnCount: 2,
                  files: [{ path: "packages/foo/src/bar.ts", additions: 1, deletions: 0 }],
                },
              ],
            ])
          }
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo/project"
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={true}
          onToggleAllDirectories={() => {}}
          chatDiffContext={{
            ...DEFAULT_CHAT_DIFF_CONTEXT,
            threadId,
            expandedFileChangeDiffs: { "work-inline-exact-fallback": true },
            inferredCheckpointTurnCountByTurnId: { [turnId]: 2 },
            fileChangeSummariesById: {
              [fileChangeId]: {
                id: fileChangeId,
                threadId,
                turnId,
                providerItemId: ProviderItemId.makeUnsafe("provider-item-1"),
                title: "File change",
                detail: "Apply patch",
                status: "completed",
                changedFiles: ["packages/foo/src/bar.ts"],
                startedAt: "2026-03-17T19:12:28.000Z",
                completedAt: "2026-03-17T19:12:29.000Z",
                updatedAt: "2026-03-17T19:12:29.000Z",
                startedSequence: 10,
                lastUpdatedSequence: 11,
                hasPatch: true,
              },
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="inline-file-diff"');
    expect(markup).toContain("fallback = true");
    expect(markup).not.toContain("this is not a unified diff");
  });

  it("keeps in-progress file-change rows compact even when inline diffs are enabled", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-inline-in-progress",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-in-progress",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: TurnId.makeUnsafe("turn-inline-in-progress"),
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "inProgress",
              changedFiles: ["packages/foo/src/bar.ts"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
        chatDiffContext={DEFAULT_CHAT_DIFF_CONTEXT}
      />,
    );

    expect(markup).not.toContain('data-testid="inline-file-diff"');
  });

  it("falls back to the turn diff for file-change rows when changedFiles is missing", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const threadId = ThreadId.makeUnsafe("thread-inline-no-fallback");
    const turnId = TurnId.makeUnsafe("turn-inline-no-fallback");
    const queryClient = makeQueryClient();
    preloadTurnDiff({
      queryClient,
      threadId,
      turnId,
      checkpointTurnCount: 2,
      diff: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const fromFallback = true;",
      ].join("\n"),
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={{ current: null }}
          onIsAtEndChange={() => {}}
          timelineEntries={[
            {
              id: "entry-inline-no-fallback",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-inline-no-fallback",
                createdAt: "2026-03-17T19:12:28.000Z",
                turnId,
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                status: "completed",
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={
            new Map([
              [
                turnId,
                {
                  turnId,
                  completedAt: "2026-03-17T19:12:30.000Z",
                  checkpointTurnCount: 2,
                  files: [{ path: "packages/foo/src/bar.ts", additions: 1, deletions: 0 }],
                },
              ],
            ])
          }
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo/project"
          expandedCommandExecutions={{}}
          onToggleCommandExecution={() => {}}
          allDirectoriesExpanded={true}
          onToggleAllDirectories={() => {}}
          chatDiffContext={{
            ...DEFAULT_CHAT_DIFF_CONTEXT,
            threadId,
            expandedFileChangeDiffs: { "work-inline-no-fallback": true },
            inferredCheckpointTurnCountByTurnId: { [turnId]: 2 },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="inline-file-diff"');
    expect(markup).toContain("fromFallback = true");
  });

  it("does not render inline file-change diffs for non-git projects", async () => {
    setPersistedAppSettings({ showFileChangeDiffsInline: true });
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "entry-inline-non-git",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-non-git",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: TurnId.makeUnsafe("turn-inline-non-git"),
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              status: "completed",
              changedFiles: ["packages/foo/src/bar.ts"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
        chatDiffContext={{ ...DEFAULT_CHAT_DIFF_CONTEXT, isGitRepo: false }}
      />,
    );

    expect(markup).not.toContain('data-testid="inline-file-diff"');
  });

  it("renders assistant raw markdown actions only for assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = "assistant-message";
    const userMessageId = "user-message";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe(assistantMessageId),
              role: "assistant",
              text: "## Result\n\nDone.",
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
          {
            id: "user-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe(userMessageId),
              role: "user",
              text: "Please copy that",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
        onQuoteAssistantMessage={() => {}}
      />,
    );

    const assistantMarkup = extractMessageRowMarkup(markup, assistantMessageId);
    const userMarkup = extractMessageRowMarkup(markup, userMessageId);

    expect(assistantMarkup).toContain('data-message-role="assistant"');
    expect(assistantMarkup).toContain('aria-label="Message actions"');
    expect(assistantMarkup).toContain('title="Copy message"');
    expect(userMarkup).toContain('data-message-role="user"');
    expect(userMarkup).not.toContain('aria-label="Message actions"');
    expect(userMarkup).toContain('title="Copy message"');
  });

  it("renders attached file chips relative to the worktree root without exposing raw metadata", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const userMessageId = "user-message-with-file";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "user-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe(userMessageId),
              role: "user",
              text: appendAttachedFilesToPrompt("Inspect this", [
                "/repo/project/.worktrees/feature/apps/web/src/components/ChatView.tsx",
              ]),
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/repo/project/.worktrees/feature"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded={true}
        onToggleAllDirectories={() => {}}
      />,
    );

    const userMarkup = extractMessageRowMarkup(markup, userMessageId);
    expect(userMarkup).toContain("apps/web/src/components/ChatView.tsx");
    expect(userMarkup).not.toContain("/repo/project/.worktrees/feature/");
    expect(userMarkup).not.toContain("&lt;attached_files&gt;");
  });

  it("renders generated images, waits, warning counts, and nested hook diagnostics", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    let diagnosticSerializationCount = 0;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={[
          {
            id: "generated-image-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "generated-image-work",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Generated image",
              detail: "/tmp/generated.png",
              tone: "tool",
              itemType: "image_generation",
              nestedDiagnostics: [
                {
                  id: "hook-work",
                  createdAt: "2026-03-17T19:12:28.100Z",
                  label: "postToolUse hook completed",
                  tone: "info",
                  activityKind: "hook.completed",
                  category: "hook",
                  isIssue: false,
                  diagnostic: {
                    type: "hook",
                    id: "hook-1",
                    hookEvent: "postToolUse",
                    source: "plugin",
                    sourcePath: "/Users/example/.codex/hooks/hooks-codex.json",
                    handlerType: "command",
                    displayOrder: 2,
                    status: "completed",
                    durationMs: 15,
                    entries: [
                      {
                        toJSON() {
                          diagnosticSerializationCount += 1;
                          return { message: "hook output" };
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            id: "sleep-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "sleep-work",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Waited 5s",
              detail: "5000ms",
              tone: "tool",
              itemType: "sleep",
            },
          },
          {
            id: "warning-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "warning-work",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Unsupported protocol request",
              tone: "error",
              activityKind: "runtime.warning",
              category: "issue",
              isIssue: true,
              warningCount: 3,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain("Generated image");
    expect(markup).toContain("Waited 5s");
    expect(markup).toContain("postToolUse hook completed");
    expect(markup).toContain("plugin:hooks-codex.json");
    expect(markup).toContain("order 2");
    expect(markup).toContain("15ms");
    expect(markup).toContain("Unsupported protocol request");
    expect(markup).toContain("×3");
    expect(diagnosticSerializationCount).toBe(0);
  });
});
