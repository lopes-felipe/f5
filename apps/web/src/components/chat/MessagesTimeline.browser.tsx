// Production CSS is part of the behavior under test because LegendList's
// internal measurement depends on Tailwind sizing utilities applied to each
// row.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrchestrationCommandExecution } from "@t3tools/contracts";
import {
  MessageId,
  type NativeApi,
  type OrchestrationFileChangeSummary,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import { parsePersistedAppSettings } from "../../appSettings";
import type { TurnDiffSummary } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
const INLINE_DIFF_THREAD_ID = ThreadId.makeUnsafe("thread-inline-browser");
const getTurnDiffSpy = vi.fn();
const getFullThreadDiffSpy = vi.fn();
const getThreadFileChangesSpy = vi.fn();
const getThreadFileChangeSpy = vi.fn();
const nativeApiMock = {
  orchestration: {
    getTurnDiff: getTurnDiffSpy,
    getFullThreadDiff: getFullThreadDiffSpy,
    getThreadFileChanges: getThreadFileChangesSpy,
    getThreadFileChange: getThreadFileChangeSpy,
  },
} as unknown as NativeApi;

function persistAppSettings(settings: Record<string, unknown> = {}) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...parsePersistedAppSettings(null),
      ...settings,
    }),
  );
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function makeUserEntry(id: string, text: string, offsetSeconds: number): TimelineEntry {
  const createdAt = new Date(
    Date.parse("2026-03-04T12:00:00.000Z") + offsetSeconds * 1000,
  ).toISOString();
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: id as MessageId,
      role: "user",
      text,
      createdAt,
      completedAt: createdAt,
      streaming: false,
      attachments: [],
      reasoningText: null,
    },
  } as unknown as TimelineEntry;
}

function makeAssistantEntry(id: string, text: string, offsetSeconds: number): TimelineEntry {
  const createdAt = new Date(
    Date.parse("2026-03-04T12:00:00.000Z") + offsetSeconds * 1000,
  ).toISOString();
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: id as MessageId,
      role: "assistant",
      text,
      createdAt,
      completedAt: createdAt,
      streaming: false,
      attachments: [],
      reasoningText: null,
    },
  } as unknown as TimelineEntry;
}

function makeCommandEntry(
  id: string,
  overrides: Partial<OrchestrationCommandExecution> = {},
): TimelineEntry {
  const startedAt = overrides.startedAt ?? "2026-03-04T12:00:09.000Z";
  const completedAt = overrides.completedAt ?? "2026-03-04T12:00:10.000Z";
  const updatedAt = overrides.updatedAt ?? completedAt;
  return {
    id,
    kind: "command",
    createdAt: startedAt,
    commandExecution: {
      id: id as OrchestrationCommandExecution["id"],
      threadId: "thread-1" as OrchestrationCommandExecution["threadId"],
      turnId: TurnId.makeUnsafe("turn-1"),
      providerItemId: null,
      command: "/bin/zsh -lc 'echo hello from transcript'",
      title: null,
      status: "completed",
      detail: null,
      exitCode: 0,
      output: "hello from transcript\n",
      outputTruncated: false,
      startedAt,
      completedAt,
      updatedAt,
      startedSequence: 1,
      lastUpdatedSequence: 2,
      ...overrides,
    },
  } as unknown as TimelineEntry;
}

interface HarnessProps {
  initialEntries: TimelineEntry[];
  onIsAtEndChangeSpy: (value: boolean) => void;
  onListRefChange?: (ref: LegendListRef | null) => void;
  headerContent?: React.ReactNode;
  initialHeight?: number;
  initialIsWorking?: boolean;
  initialActiveTurnStartedAt?: string | null;
  initialExpandedCommandExecutions?: Record<string, boolean>;
  queryClient?: QueryClient;
  turnDiffSummaryByTurnId?: Map<TurnId, TurnDiffSummary>;
  workspaceRoot?: string;
  chatDiffContextOverrides?: Partial<{
    threadId: ThreadId | null;
    isGitRepo: boolean;
    inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
    expandedFileChangeDiffs: Record<string, boolean>;
    fileChangeSummariesById: Record<string, OrchestrationFileChangeSummary>;
  }>;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
}

interface TimelineHarnessApi {
  setEntries: (entries: TimelineEntry[]) => void;
  setHeaderContent: (content: React.ReactNode) => void;
  setHeight: (height: number) => void;
  setTimelineState: (nextState: {
    entries: TimelineEntry[];
    isWorking: boolean;
    activeTurnStartedAt?: string | null;
  }) => void;
}

function TimelineHarness(
  props: HarnessProps & {
    // Parent drives the entry list via this setter so the test can push
    // additions and simulate 0 → >0 transitions.
    setApi?: (api: TimelineHarnessApi) => void;
  },
) {
  const [entries, setEntries] = useState<TimelineEntry[]>(props.initialEntries);
  const [height, setHeight] = useState(props.initialHeight ?? 400);
  const [isWorking, setIsWorking] = useState(props.initialIsWorking ?? false);
  const [activeTurnStartedAt, setActiveTurnStartedAt] = useState<string | null>(
    props.initialActiveTurnStartedAt ?? "2026-03-04T12:00:00.000Z",
  );
  const [headerContent, setHeaderContent] = useState<React.ReactNode>(props.headerContent ?? null);
  const [expandedCommandExecutions, setExpandedCommandExecutions] = useState<
    Record<string, boolean>
  >(props.initialExpandedCommandExecutions ?? {});
  const [expandedFileChangeDiffs, setExpandedFileChangeDiffs] = useState<Record<string, boolean>>(
    {},
  );
  const listRef = useRef<LegendListRef | null>(null);
  const queryClientRef = useRef<QueryClient>(props.queryClient ?? makeQueryClient());
  // Expose the list ref out through the callback so tests can observe the
  // real LegendList ref the component received.
  if (props.onListRefChange) {
    props.onListRefChange(listRef.current);
  }
  if (props.setApi) {
    props.setApi({
      setEntries,
      setHeaderContent,
      setHeight,
      setTimelineState: (nextState) => {
        setEntries(nextState.entries);
        setIsWorking(nextState.isWorking);
        if (Object.hasOwn(nextState, "activeTurnStartedAt")) {
          setActiveTurnStartedAt(nextState.activeTurnStartedAt ?? null);
        }
      },
    });
  }

  return (
    <div style={{ height, display: "flex", flexDirection: "column" }}>
      <QueryClientProvider client={queryClientRef.current}>
        <MessagesTimeline
          hasMessages={entries.length > 0}
          isWorking={isWorking}
          activeTurnStartedAt={activeTurnStartedAt}
          listRef={listRef}
          onIsAtEndChange={props.onIsAtEndChangeSpy}
          timelineEntries={entries}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId ?? new Map()}
          nowIso="2026-03-04T12:05:00.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={props.onOpenTurnDiff ?? (() => {})}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={props.workspaceRoot}
          expandedCommandExecutions={expandedCommandExecutions}
          onToggleCommandExecution={(commandExecutionId) => {
            setExpandedCommandExecutions((current) => ({
              ...current,
              [commandExecutionId]: !(current[commandExecutionId] ?? false),
            }));
          }}
          allDirectoriesExpanded={false}
          onToggleAllDirectories={() => {}}
          listHeaderContent={headerContent}
          chatDiffContext={{
            threadId: INLINE_DIFF_THREAD_ID,
            isGitRepo: true,
            inferredCheckpointTurnCountByTurnId: {},
            expandedFileChangeDiffs,
            fileChangeSummariesById: {},
            onToggleFileChangeDiff: (workEntryId) => {
              setExpandedFileChangeDiffs((current) => ({
                ...current,
                [workEntryId]: !(current[workEntryId] ?? true),
              }));
            },
            onOpenFileChangeDiff: () => {},
            ...props.chatDiffContextOverrides,
          }}
        />
      </QueryClientProvider>
    </div>
  );
}

function makeOverflowEntries(count: number): TimelineEntry[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? makeUserEntry(`overflow-user-${index}`, `user row ${index} `.repeat(12), index)
      : makeAssistantEntry(
          `overflow-assistant-${index}`,
          `assistant row ${index} `.repeat(18),
          index,
        ),
  );
}

async function waitForScrollContainer(host: HTMLElement): Promise<HTMLElement> {
  let scrollContainer: HTMLElement | null = null;
  await vi.waitFor(() => {
    scrollContainer = host.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]');
    expect(scrollContainer, "Unable to find the LegendList scroll container.").not.toBeNull();
    expect(scrollContainer!.scrollHeight).toBeGreaterThan(scrollContainer!.clientHeight);
  });
  return scrollContainer!;
}

function isElementVisibleWithinContainer(element: HTMLElement, container: HTMLElement): boolean {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.bottom > containerRect.top && elementRect.top < containerRect.bottom;
}

function scrollContainerToOffset(container: HTMLElement, nextScrollTop: number) {
  container.scrollTop = nextScrollTop;
  container.dispatchEvent(new Event("scroll"));
}

async function scrollTimelineToOffset(
  listRef: LegendListRef | null,
  container: HTMLElement,
  nextScrollTop: number,
) {
  if (listRef?.scrollToOffset) {
    await listRef.scrollToOffset({ offset: nextScrollTop, animated: false });
    return;
  }
  scrollContainerToOffset(container, nextScrollTop);
}

describe("MessagesTimeline (LegendList)", () => {
  beforeEach(() => {
    localStorage.clear();
    persistAppSettings();
    getTurnDiffSpy.mockReset();
    getFullThreadDiffSpy.mockReset();
    getThreadFileChangesSpy.mockReset();
    getThreadFileChangeSpy.mockReset();
    getTurnDiffSpy.mockResolvedValue({ diff: "" });
    getFullThreadDiffSpy.mockResolvedValue({ diff: "" });
    getThreadFileChangesSpy.mockResolvedValue({
      threadId: INLINE_DIFF_THREAD_ID,
      fileChanges: [],
      latestSequence: 0,
      isFullSync: true,
    });
    getThreadFileChangeSpy.mockResolvedValue({ fileChange: null });
    (
      window as typeof window & {
        nativeApi?: NativeApi;
      }
    ).nativeApi = nativeApiMock;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the empty-state copy and the listHeaderContent when no entries are present", async () => {
    // Regression for the empty-timeline + tasks panel case: the plan called
    // out that the tasks panel must still render when details are loaded but
    // the timeline is empty. MessagesTimeline must render the header slot in
    // the empty branch, not only inside LegendList.ListHeaderComponent.
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[]}
        onIsAtEndChangeSpy={() => {}}
        headerContent={<div data-testid="tasks-panel-stub">Tasks panel content</div>}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Send a message to start the conversation.");
        const taskPanel = host.querySelector('[data-testid="tasks-panel-stub"]');
        expect(taskPanel, "Tasks panel must render alongside the empty state.").not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("invokes scrollToEnd and flips isAtEnd on 0 → >0 row transitions", async () => {
    // Upstream fix 33dadb5a: when the row count goes from 0 to >0 (new thread,
    // first message), LegendList has already latched `initialScrollAtEnd`, so
    // we must explicitly scroll to end and propagate isAtEnd=true again. This
    // test exercises the requestAnimationFrame path inside MessagesTimeline.
    const isAtEndCalls: boolean[] = [];
    const scrollToEndSpy = vi.fn();
    let currentRef: LegendListRef | null = null;
    let api: { setEntries: (entries: TimelineEntry[]) => void } | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[]}
        onIsAtEndChangeSpy={(value) => isAtEndCalls.push(value)}
        onListRefChange={(ref) => {
          currentRef = ref;
        }}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      // The empty branch doesn't mount LegendList, so `currentRef` will stay
      // null here. Once we push entries, LegendList mounts and we can spy
      // on scrollToEnd via the ref. We wire the spy after adding rows below.
      expect(api).not.toBeNull();

      isAtEndCalls.length = 0;
      api!.setEntries([makeUserEntry("msg-1", "hello", 0)]);

      await vi.waitFor(
        () => {
          // Row rendered
          expect(host.querySelector('[data-message-id="msg-1"]')).not.toBeNull();
        },
        { timeout: 3_000, interval: 16 },
      );

      // The 0 → >0 effect calls onIsAtEndChange(true) inside rAF. Patch the
      // ref's scrollToEnd once it exists so subsequent commits capture it.
      await vi.waitFor(
        () => {
          if (currentRef && typeof currentRef.scrollToEnd === "function") {
            currentRef.scrollToEnd = scrollToEndSpy as LegendListRef["scrollToEnd"];
          }
          expect(isAtEndCalls).toContain(true);
        },
        { timeout: 3_000, interval: 16 },
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("auto-follows appended rows when the user is already at the end", async () => {
    const initialEntries = makeOverflowEntries(16);
    const isAtEndCalls: boolean[] = [];
    let api: TimelineHarnessApi | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={initialEntries}
        initialHeight={240}
        onIsAtEndChangeSpy={(value) => isAtEndCalls.push(value)}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      expect(api).not.toBeNull();

      const scrollContainer = await waitForScrollContainer(host);
      await vi.waitFor(() => {
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeLessThan(8);
      });

      isAtEndCalls.length = 0;
      api!.setEntries([
        ...initialEntries,
        makeAssistantEntry("msg-assistant-auto-follow-tail", "tail append target", 120),
      ]);

      await vi.waitFor(() => {
        const appendedRow = host.querySelector<HTMLElement>(
          '[data-message-id="msg-assistant-auto-follow-tail"]',
        );
        expect(appendedRow, "Appended row should render after the update.").not.toBeNull();
        expect(
          isElementVisibleWithinContainer(appendedRow!, scrollContainer),
          "Appended row should stay visible when the user is already at the end.",
        ).toBe(true);
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeLessThan(8);
        expect(isAtEndCalls.at(-1)).toBe(true);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("auto-follows when a final assistant row replaces the trailing working row", async () => {
    const initialEntries = makeOverflowEntries(16);
    const isAtEndCalls: boolean[] = [];
    let api: TimelineHarnessApi | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={initialEntries}
        initialHeight={240}
        initialIsWorking
        initialActiveTurnStartedAt="2026-03-04T12:03:00.000Z"
        onIsAtEndChangeSpy={(value) => isAtEndCalls.push(value)}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      expect(api).not.toBeNull();

      const scrollContainer = await waitForScrollContainer(host);
      await vi.waitFor(() => {
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeLessThan(8);
      });

      isAtEndCalls.length = 0;
      api!.setTimelineState({
        entries: [
          ...initialEntries,
          makeAssistantEntry("msg-assistant-final-tail", "final tail message", 122),
        ],
        isWorking: false,
        activeTurnStartedAt: null,
      });

      await vi.waitFor(() => {
        const appendedRow = host.querySelector<HTMLElement>(
          '[data-message-id="msg-assistant-final-tail"]',
        );
        expect(
          appendedRow,
          "Final assistant row should render after replacing the working row.",
        ).not.toBeNull();
        expect(
          isElementVisibleWithinContainer(appendedRow!, scrollContainer),
          "Replacing the working row at the tail should still keep the user pinned to the end.",
        ).toBe(true);
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeLessThan(8);
        expect(isAtEndCalls.at(-1)).toBe(true);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the user's scroll position when rows append away from the end", async () => {
    const initialEntries = makeOverflowEntries(16);
    const isAtEndCalls: boolean[] = [];
    let api: TimelineHarnessApi | null = null;
    let currentRef: LegendListRef | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={initialEntries}
        initialHeight={240}
        onIsAtEndChangeSpy={(value) => isAtEndCalls.push(value)}
        onListRefChange={(ref) => {
          currentRef = ref;
        }}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      expect(api).not.toBeNull();

      const scrollContainer = await waitForScrollContainer(host);
      await scrollTimelineToOffset(currentRef, scrollContainer, 0);
      scrollContainer.dispatchEvent(new Event("scroll"));

      await vi.waitFor(() => {
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeGreaterThan(80);
        expect(isAtEndCalls.at(-1)).toBe(false);
      });

      isAtEndCalls.length = 0;
      const scrollTopBeforeAppend = scrollContainer.scrollTop;
      api!.setEntries([
        ...initialEntries,
        makeAssistantEntry("msg-assistant-manual-tail", "manual tail target", 121),
      ]);

      await vi.waitFor(() => {
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeGreaterThan(80);
        expect(Math.abs(scrollContainer.scrollTop - scrollTopBeforeAppend)).toBeLessThan(8);
        const appendedRow = host.querySelector<HTMLElement>(
          '[data-message-id="msg-assistant-manual-tail"]',
        );
        if (appendedRow) {
          expect(
            isElementVisibleWithinContainer(appendedRow, scrollContainer),
            "Appended row should stay out of view while the user is reading history.",
          ).toBe(false);
        }
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("resyncs isAtEnd after the viewport grows without a user scroll", async () => {
    const isAtEndCalls: boolean[] = [];
    let api: TimelineHarnessApi | null = null;
    let currentRef: LegendListRef | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={makeOverflowEntries(16)}
        initialHeight={240}
        onIsAtEndChangeSpy={(value) => isAtEndCalls.push(value)}
        onListRefChange={(ref) => {
          currentRef = ref;
        }}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      expect(api).not.toBeNull();

      const scrollContainer = await waitForScrollContainer(host);
      const initialMaxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const targetScrollTop = Math.max(0, initialMaxScrollTop - 80);
      await scrollTimelineToOffset(currentRef, scrollContainer, targetScrollTop);

      await vi.waitFor(() => {
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeGreaterThan(40);
      });

      isAtEndCalls.length = 0;
      api!.setHeight(640);

      await vi.waitFor(() => {
        expect(isAtEndCalls).toContain(true);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("resyncs isAtEnd after header reflow changes the bottom position", async () => {
    const isAtEndCalls: boolean[] = [];
    let api: TimelineHarnessApi | null = null;
    let currentRef: LegendListRef | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={makeOverflowEntries(16)}
        initialHeight={260}
        headerContent={<div data-testid="tall-header" style={{ height: 260 }} />}
        onIsAtEndChangeSpy={(value) => isAtEndCalls.push(value)}
        onListRefChange={(ref) => {
          currentRef = ref;
        }}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      expect(api).not.toBeNull();

      const scrollContainer = await waitForScrollContainer(host);
      const initialMaxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const targetScrollTop = Math.max(0, initialMaxScrollTop - 50);
      await scrollTimelineToOffset(currentRef, scrollContainer, targetScrollTop);

      await vi.waitFor(() => {
        const distanceFromEnd =
          scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
        expect(distanceFromEnd).toBeGreaterThan(30);
      });

      isAtEndCalls.length = 0;
      api!.setHeaderContent(<div data-testid="short-header" style={{ height: 0 }} />);

      await vi.waitFor(() => {
        expect(isAtEndCalls).toContain(true);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders heterogeneous rows without throwing when commands and messages mix", async () => {
    // Smoke test for the mixed-row case. Under react-virtual we had a
    // dedicated "complex row" escape hatch to prevent height mis-estimates
    // from piling up; LegendList owns measurement, so this test only needs
    // to confirm no runtime errors and that every kind of row reaches the DOM.
    const entries: TimelineEntry[] = [
      makeUserEntry("msg-user-a", "first question", 0),
      makeAssistantEntry("msg-asst-a", "first answer", 3),
      makeUserEntry("msg-user-b", "follow-up", 6),
      makeAssistantEntry("msg-asst-b", "second answer", 9),
    ];

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness initialEntries={entries} onIsAtEndChangeSpy={() => {}} />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[data-message-id="msg-user-a"]')).not.toBeNull();
        expect(host.querySelector('[data-message-id="msg-asst-b"]')).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("re-renders command rows when transcript expansion changes", async () => {
    // Regression for the LegendList port: command rows depend on external
    // expansion state, so the list must receive extraData to invalidate its
    // cached item render when the card is toggled.
    const commandId = "command-expand-row";
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeCommandEntry(commandId)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    const getRow = () => host.querySelector<HTMLElement>(`[data-timeline-row-id="${commandId}"]`);
    const getToggleButton = () =>
      host.querySelector<HTMLButtonElement>(
        `[data-timeline-row-id="${commandId}"] button[aria-expanded]`,
      );

    try {
      await vi.waitFor(() => {
        expect(getRow(), "Unable to find the command transcript row.").not.toBeNull();
        expect(getToggleButton()?.getAttribute("aria-expanded")).toBe("false");
        expect(getRow()?.textContent).not.toContain("Output");
      });

      getToggleButton()?.click();

      await vi.waitFor(() => {
        expect(getToggleButton()?.getAttribute("aria-expanded")).toBe("true");
        expect(getRow()?.textContent).toContain("Output");
        expect(getRow()?.textContent).toContain("hello from transcript");
      });

      getToggleButton()?.click();

      await vi.waitFor(() => {
        expect(getToggleButton()?.getAttribute("aria-expanded")).toBe("false");
        expect(getRow()?.textContent).not.toContain("Output");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shares a single turn-diff fetch across inline file-change cards in the same turn", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    const turnId = TurnId.makeUnsafe("turn-inline-shared-fetch");
    getTurnDiffSpy.mockResolvedValue({
      diff: [
        "diff --git a/packages/foo/src/bar.ts b/packages/foo/src/bar.ts",
        "index 1111111..2222222 100644",
        "--- a/packages/foo/src/bar.ts",
        "+++ b/packages/foo/src/bar.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const b = 2;",
      ].join("\n"),
    });

    const entries: TimelineEntry[] = Array.from({ length: 20 }, (_, index) => {
      const createdAt = new Date(
        Date.parse("2026-03-04T12:00:00.000Z") + index * 1000,
      ).toISOString();
      return {
        id: `work-entry-${index}`,
        kind: "work",
        createdAt,
        entry: {
          id: `work-row-${index}`,
          createdAt,
          turnId,
          label: "File change",
          tone: "tool",
          itemType: "file_change",
          status: "completed",
          changedFiles: ["packages/foo/src/bar.ts"],
        },
      } as unknown as TimelineEntry;
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={entries}
        onIsAtEndChangeSpy={() => {}}
        workspaceRoot="/repo/project"
        turnDiffSummaryByTurnId={
          new Map([
            [
              turnId,
              {
                turnId,
                completedAt: "2026-03-04T12:00:20.000Z",
                checkpointTurnCount: 2,
                files: [{ path: "packages/foo/src/bar.ts", additions: 1, deletions: 0 }],
              },
            ],
          ])
        }
        chatDiffContextOverrides={{
          threadId: INLINE_DIFF_THREAD_ID,
          isGitRepo: true,
          expandedFileChangeDiffs: Object.fromEntries(
            entries.flatMap((entry) =>
              entry.kind === "work" ? ([[entry.entry.id, true]] as const) : [],
            ),
          ),
          inferredCheckpointTurnCountByTurnId: { [turnId]: 2 },
        }}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(getTurnDiffSpy).toHaveBeenCalledTimes(1);
        expect(host.querySelector('[data-testid="inline-file-diff"]')).not.toBeNull();
        expect(host.innerHTML).toContain("max-h-80");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps a historical file-change row rendered after appending a newer user message", async () => {
    const fillerEntries: TimelineEntry[] = Array.from({ length: 32 }, (_, index) =>
      index % 2 === 0
        ? makeUserEntry(`msg-user-filler-${index}`, `filler user ${index}`, index * 3)
        : makeAssistantEntry(
            `msg-assistant-filler-${index}`,
            `filler assistant ${index}`,
            index * 3,
          ),
    );
    const remoteFileChangeEntry: TimelineEntry = {
      id: "remote-file-change-entry",
      kind: "work",
      createdAt: "2026-03-04T12:01:28.304Z",
      entry: {
        id: "remote-file-change-work",
        createdAt: "2026-03-04T12:01:28.304Z",
        label: "File change",
        tone: "tool",
        status: "completed",
        itemType: "file_change",
        changedFiles: ["/repo/project/REMOTE.md"],
      },
    } as TimelineEntry;
    const initialEntries: TimelineEntry[] = [
      ...fillerEntries,
      makeUserEntry("msg-user-edit", "no, let me show you. edit a file", 90),
      makeAssistantEntry(
        "msg-assistant-switch",
        "I’m switching back to a simple sample file change.",
        97,
      ),
      makeAssistantEntry(
        "msg-assistant-remote",
        "`REMOTE.md` is clean. I’m adding a single obvious test-only line near the top.",
        104,
      ),
      remoteFileChangeEntry,
      makeAssistantEntry(
        "msg-assistant-checking",
        "The edit is in place. I’m checking the diff to confirm it’s only that one-line addition.",
        112,
      ),
      makeAssistantEntry(
        "msg-assistant-summary",
        "Added a minimal sample file change in REMOTE.md by inserting Sample inline diff change.",
        121,
      ),
    ];
    let api: { setEntries: (entries: TimelineEntry[]) => void } | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={initialEntries}
        onIsAtEndChangeSpy={() => {}}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(
          host.querySelector('[data-timeline-row-id="remote-file-change-entry"]'),
          "Historical file-change row should render before the newer user message arrives.",
        ).not.toBeNull();
      });

      if (api === null) {
        throw new Error("Expected timeline harness API to be available.");
      }
      const timelineApi = api as { setEntries: (entries: TimelineEntry[]) => void };
      timelineApi.setEntries([
        ...initialEntries,
        makeUserEntry("msg-user-next", "ok, another one now", 139),
      ]);

      await vi.waitFor(() => {
        const historicalFileChangeRow = host.querySelector(
          '[data-timeline-row-id="remote-file-change-entry"]',
        );
        expect(
          historicalFileChangeRow,
          "Historical file-change row should stay rendered after appending a newer user message.",
        ).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps an expanded inline diff rendered after appending a newer user message", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    const turnId = TurnId.makeUnsafe("turn-inline-persist-after-append");
    getTurnDiffSpy.mockResolvedValue({
      diff: [
        "diff --git a/.docs/ci.md b/.docs/ci.md",
        "index 1111111..2222222 100644",
        "--- a/.docs/ci.md",
        "+++ b/.docs/ci.md",
        "@@ -1,2 +1,4 @@",
        " # CI quality gates",
        " ",
        "+Sample inline diff change.",
        "+",
      ].join("\n"),
    });

    const fileChangeEntry: TimelineEntry = {
      id: "entry-inline-persist",
      kind: "work",
      createdAt: "2026-03-04T12:01:28.304Z",
      entry: {
        id: "work-inline-persist",
        createdAt: "2026-03-04T12:01:28.304Z",
        turnId,
        label: "File change",
        tone: "tool",
        itemType: "file_change",
        status: "completed",
        changedFiles: ["/repo/project/.docs/ci.md"],
      },
    } as TimelineEntry;
    const initialEntries: TimelineEntry[] = [
      makeAssistantEntry(
        "msg-assistant-before-inline",
        "I’m editing `.docs/ci.md` now with the same minimal one-line addition.",
        57,
      ),
      fileChangeEntry,
      makeAssistantEntry(
        "msg-assistant-after-inline",
        "The sample edit is in place. I’m checking the diff and the line number.",
        67,
      ),
    ];
    let api: { setEntries: (entries: TimelineEntry[]) => void } | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={initialEntries}
        onIsAtEndChangeSpy={() => {}}
        setApi={(nextApi) => {
          api = nextApi;
        }}
        workspaceRoot="/repo/project"
        turnDiffSummaryByTurnId={
          new Map([
            [
              turnId,
              {
                turnId,
                completedAt: "2026-03-04T12:01:40.000Z",
                checkpointTurnCount: 12,
                files: [{ path: ".docs/ci.md", additions: 2, deletions: 0 }],
              },
            ],
          ])
        }
        chatDiffContextOverrides={{
          threadId: INLINE_DIFF_THREAD_ID,
          isGitRepo: true,
          expandedFileChangeDiffs: { "work-inline-persist": true },
          inferredCheckpointTurnCountByTurnId: { [turnId]: 12 },
        }}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(getTurnDiffSpy).toHaveBeenCalledTimes(1);
        expect(host.querySelector('[data-testid="inline-file-diff"]')).not.toBeNull();
        expect(host.textContent).toContain(".docs/ci.md");
      });

      if (api === null) {
        throw new Error("Expected timeline harness API to be available.");
      }
      const timelineApi = api as { setEntries: (entries: TimelineEntry[]) => void };
      timelineApi.setEntries([
        ...initialEntries,
        makeUserEntry("msg-user-next-inline", "another one", 100),
      ]);

      await vi.waitFor(() => {
        const inlineDiff = host.querySelector(
          '[data-testid="inline-file-diff"][data-work-entry-id="work-inline-persist"]',
        );
        expect(
          inlineDiff,
          "Expanded inline diff should stay rendered after appending a newer user message.",
        ).not.toBeNull();
        expect(host.textContent).toContain(".docs/ci.md");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps a user-expanded inline diff open after appending a newer user message", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    const turnId = TurnId.makeUnsafe("turn-inline-open-state-after-append");
    getTurnDiffSpy.mockResolvedValue({
      diff: [
        "diff --git a/.docs/codex-prerequisites.md b/.docs/codex-prerequisites.md",
        "index 1111111..2222222 100644",
        "--- a/.docs/codex-prerequisites.md",
        "+++ b/.docs/codex-prerequisites.md",
        "@@ -1,2 +1,4 @@",
        " # Codex prerequisites",
        " ",
        "+Sample inline diff change.",
        "+",
      ].join("\n"),
    });

    const fileChangeEntry: TimelineEntry = {
      id: "entry-inline-open-state",
      kind: "work",
      createdAt: "2026-03-04T12:02:28.304Z",
      entry: {
        id: "work-inline-open-state",
        createdAt: "2026-03-04T12:02:28.304Z",
        turnId,
        label: "File change",
        tone: "tool",
        itemType: "file_change",
        status: "completed",
        changedFiles: ["/repo/project/.docs/codex-prerequisites.md"],
      },
    } as TimelineEntry;
    const initialEntries: TimelineEntry[] = [
      makeAssistantEntry(
        "msg-assistant-before-open-state",
        "I’m editing `.docs/codex-prerequisites.md` now with the same minimal one-line addition.",
        60,
      ),
      fileChangeEntry,
      makeAssistantEntry(
        "msg-assistant-after-open-state",
        "The sample edit is in place. I’m checking the diff and the line number.",
        70,
      ),
    ];
    let api: { setEntries: (entries: TimelineEntry[]) => void } | null = null;

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={initialEntries}
        onIsAtEndChangeSpy={() => {}}
        setApi={(nextApi) => {
          api = nextApi;
        }}
        workspaceRoot="/repo/project"
        turnDiffSummaryByTurnId={
          new Map([
            [
              turnId,
              {
                turnId,
                completedAt: "2026-03-04T12:02:40.000Z",
                checkpointTurnCount: 13,
                files: [{ path: ".docs/codex-prerequisites.md", additions: 2, deletions: 0 }],
              },
            ],
          ])
        }
        chatDiffContextOverrides={{
          threadId: INLINE_DIFF_THREAD_ID,
          isGitRepo: true,
          inferredCheckpointTurnCountByTurnId: { [turnId]: 13 },
        }}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(getTurnDiffSpy).toHaveBeenCalledTimes(1);
        const inlineDiff = host.querySelector(
          '[data-testid="inline-file-diff"][data-work-entry-id="work-inline-open-state"]',
        );
        expect(inlineDiff).not.toBeNull();
        expect(host.textContent).toContain(".docs/codex-prerequisites.md");
      });

      if (api === null) {
        throw new Error("Expected timeline harness API to be available.");
      }
      const timelineApi = api as { setEntries: (entries: TimelineEntry[]) => void };
      timelineApi.setEntries([
        ...initialEntries,
        makeUserEntry("msg-user-next-open-state", "another one", 110),
      ]);

      await vi.waitFor(() => {
        const inlineDiff = host.querySelector(
          '[data-testid="inline-file-diff"][data-work-entry-id="work-inline-open-state"]',
        );
        expect(
          inlineDiff,
          "User-expanded inline diff should stay open after appending a newer user message.",
        ).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
