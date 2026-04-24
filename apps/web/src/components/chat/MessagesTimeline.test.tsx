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
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
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

beforeAll(() => {
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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

  it("renders consecutive MCP work entries as separate work rows when MCP expansion is on", async () => {
    setPersistedAppSettings({ expandMcpToolCalls: true });

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
        nowIso="2026-03-17T19:12:30.000Z"
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
    expect(markup).toContain('data-timeline-row-id="entry-mcp-2"');
  });

  it("renders collapsed MCP cards when default card expansion is disabled", async () => {
    setPersistedAppSettings({
      expandMcpToolCalls: true,
      expandMcpToolCallCardsByDefault: false,
    });

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
            id: "entry-mcp-card-collapsed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-card-collapsed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              itemType: "mcp_tool_call",
              tone: "tool",
              mcpServerName: "filesystem",
              mcpToolName: "read_text_file",
              mcpInput: '{\n  "path": "README.md"\n}',
              mcpResult: "read successfully",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
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

    expect(markup).toContain("MCP tool call");
    expect(markup).not.toContain("border-t border-border/60 px-3 py-3");
    expect(markup).not.toContain("read successfully");
  });

  it("renders expanded MCP rows with transcript-style card chrome", async () => {
    setPersistedAppSettings({ expandMcpToolCalls: true });

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
            id: "entry-mcp-card",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-card",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              itemType: "mcp_tool_call",
              tone: "tool",
              mcpServerName: "filesystem",
              mcpToolName: "read_text_file",
              mcpInput: '{\n  "path": "README.md"\n}',
              mcpResult: "read successfully",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
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

    expect(markup).toContain("group rounded-xl border border-border/60 bg-card/35");
    expect(markup).toContain("border-t border-border/60 px-3 py-3");
    expect(markup).toContain('viewBox="0 0 180 180"');
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
          nowIso="2026-03-17T19:12:30.000Z"
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
          nowIso="2026-03-17T19:12:30.000Z"
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
          nowIso="2026-03-17T19:12:30.000Z"
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
          nowIso="2026-03-17T19:12:30.000Z"
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
          nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
          nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:30.000Z"
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
        nowIso="2026-03-17T19:12:31.000Z"
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

    const assistantMarkup = extractMessageRowMarkup(markup, assistantMessageId);
    const userMarkup = extractMessageRowMarkup(markup, userMessageId);

    expect(assistantMarkup).toContain('data-message-role="assistant"');
    expect(assistantMarkup).toContain('aria-label="Message actions"');
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
        nowIso="2026-03-17T19:12:31.000Z"
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
});
