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
  type UserMessageSkillCall,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import { parsePersistedAppSettings } from "../../appSettings";
import type { TurnDiffSummary } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";
import type { ImageAttachmentActionItem } from "./imageAttachmentActions";
import { WORK_LOG_PAGE_SIZE } from "./workLogConstants";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
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

function makeUserEntry(
  id: string,
  text: string,
  offsetSeconds: number,
  options: {
    skillCall?: UserMessageSkillCall;
    attachments?: Array<{
      type: "image";
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      previewUrl: string;
    }>;
  } = {},
): TimelineEntry {
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
      ...(options.skillCall !== undefined ? { skillCall: options.skillCall } : {}),
      createdAt,
      completedAt: createdAt,
      streaming: false,
      attachments: options.attachments ?? [],
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
  onImageActionMenu?: (item: ImageAttachmentActionItem, position: { x: number; y: number }) => void;
  usesCustomImageContextMenu?: boolean;
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
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, number>>({});
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
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={(groupId, paginatedEntryCount) => {
            setExpandedWorkGroups((current) => {
              const revealedEntries = current[groupId] ?? WORK_LOG_PAGE_SIZE;
              return {
                ...current,
                [groupId]:
                  revealedEntries >= paginatedEntryCount
                    ? WORK_LOG_PAGE_SIZE
                    : Math.min(paginatedEntryCount, revealedEntries + WORK_LOG_PAGE_SIZE),
              };
            });
          }}
          onOpenTurnDiff={props.onOpenTurnDiff ?? (() => {})}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          onImageActionMenu={props.onImageActionMenu}
          usesCustomImageContextMenu={props.usesCustomImageContextMenu}
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

  it("navigates from a turn-rail tick to an offscreen user turn", async () => {
    await page.viewport(1200, 896);
    const host = document.createElement("div");
    document.body.append(host);
    let listRef: LegendListRef | null = null;
    await render(
      <TimelineHarness
        initialEntries={makeOverflowEntries(40)}
        initialHeight={360}
        onIsAtEndChangeSpy={() => {}}
        onListRefChange={(next) => {
          listRef = next;
        }}
      />,
      { container: host },
    );
    const container = await waitForScrollContainer(host);
    await vi.waitFor(() => {
      expect(
        host
          .querySelector('[data-testid="timeline-turn-rail"]')
          ?.getAttribute("data-persistent-gutter"),
      ).toBe("true");
    });
    await scrollTimelineToOffset(listRef, container, container.scrollHeight);
    const targetBefore = host.querySelector<HTMLElement>('[data-message-id="overflow-user-0"]');
    expect(targetBefore === null || !isElementVisibleWithinContainer(targetBefore, container)).toBe(
      true,
    );
    const strip = host.querySelector<HTMLButtonElement>('[data-testid="timeline-turn-rail-strip"]');
    expect(strip).not.toBeNull();
    const rect = strip!.getBoundingClientRect();
    strip!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientY: rect.top + 1, clientX: rect.left + 1 }),
    );
    await vi.waitFor(() => {
      const target = host.querySelector<HTMLElement>('[data-message-id="overflow-user-0"]');
      expect(target).not.toBeNull();
      expect(isElementVisibleWithinContainer(target!, container)).toBe(true);
    });
  });

  it("tracks the active turn-rail tick while scrolling", async () => {
    await page.viewport(1200, 896);
    const host = document.createElement("div");
    document.body.append(host);
    let listRef: LegendListRef | null = null;
    await render(
      <TimelineHarness
        initialEntries={makeOverflowEntries(40)}
        initialHeight={360}
        onIsAtEndChangeSpy={() => {}}
        onListRefChange={(next) => {
          listRef = next;
        }}
      />,
      { container: host },
    );
    const container = await waitForScrollContainer(host);
    await scrollTimelineToOffset(listRef, container, 0);
    await vi.waitFor(() => {
      const active = host.querySelector('[data-turn-rail-active="true"]');
      expect(active).not.toBeNull();
      expect([...host.querySelectorAll("[data-turn-rail-tick]")].indexOf(active!)).toBe(0);
    });
    await scrollTimelineToOffset(listRef, container, container.scrollHeight);
    await vi.waitFor(() => {
      const ticks = [...host.querySelectorAll("[data-turn-rail-tick]")];
      const active = host.querySelector('[data-turn-rail-active="true"]');
      expect(active).not.toBeNull();
      expect(ticks.indexOf(active!)).toBeGreaterThan(0);
    });
  });

  it("keeps the turn-rail hit target inside the measured gutter", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await page.viewport(1200, 896);
    await render(
      <TimelineHarness
        initialEntries={makeOverflowEntries(8)}
        initialHeight={360}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );
    await waitForScrollContainer(host);
    const rail = host.querySelector<HTMLElement>('[data-testid="timeline-turn-rail"]');
    const strip = host.querySelector<HTMLElement>('[data-testid="timeline-turn-rail-strip"]');
    await vi.waitFor(() => expect(rail?.dataset.persistentGutter).toBe("true"));
    expect(Number.parseFloat(getComputedStyle(strip!).width)).toBeGreaterThan(0);

    await page.viewport(600, 896);
    await vi.waitFor(() => {
      expect(rail?.dataset.persistentGutter).toBe("false");
      expect(Number.parseFloat(getComputedStyle(strip!).width)).toBe(0);
      expect(getComputedStyle(strip!).pointerEvents).toBe("none");
    });
    const messageText = host.querySelector<HTMLElement>('[data-message-id="overflow-user-0"]');
    expect(getComputedStyle(messageText!).pointerEvents).not.toBe("none");
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

  it("routes sent-image right-clicks to the F5 image action menu", async () => {
    const onImageActionMenu = vi.fn();
    const entry = makeUserEntry("message-with-image", "See screenshot", 0, {
      attachments: [
        {
          type: "image",
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 128,
          previewUrl: "/attachments/image-1",
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[entry]}
        onIsAtEndChangeSpy={() => {}}
        onImageActionMenu={onImageActionMenu}
        usesCustomImageContextMenu={true}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('img[alt="screenshot.png"]')).not.toBeNull();
      });
      host.querySelector('img[alt="screenshot.png"]')!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 21,
          clientY: 34,
        }),
      );

      expect(onImageActionMenu).toHaveBeenCalledWith(
        {
          src: "/attachments/image-1",
          name: "screenshot.png",
          mimeType: "image/png",
        },
        { x: 21, y: 34 },
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("preserves the native image context menu outside Electron", async () => {
    const onImageActionMenu = vi.fn();
    const entry = makeUserEntry("message-with-web-image", "See screenshot", 0, {
      attachments: [
        {
          type: "image",
          id: "image-web-1",
          name: "web-screenshot.png",
          mimeType: "image/png",
          sizeBytes: 128,
          previewUrl: "/attachments/image-web-1",
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[entry]}
        onIsAtEndChangeSpy={() => {}}
        onImageActionMenu={onImageActionMenu}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('img[alt="web-screenshot.png"]')).not.toBeNull();
      });
      const contextMenuEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      host.querySelector('img[alt="web-screenshot.png"]')!.dispatchEvent(contextMenuEvent);

      expect(contextMenuEvent.defaultPrevented).toBe(false);
      expect(onImageActionMenu).not.toHaveBeenCalled();
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

  it("collapses long single-line user messages", async () => {
    const tail = "VISIBLE_TAIL";
    const longText = `${"a".repeat(600)}${tail}`;
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry("msg-long-single", longText, 0)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Show more");
        expect(host.textContent).not.toContain(tail);
      });

      host.querySelector<HTMLButtonElement>('[data-message-id="msg-long-single"] button')?.click();

      await vi.waitFor(() => {
        expect(host.textContent).toContain("Show less");
        expect(host.textContent).toContain(tail);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("collapses multi-line user messages by line count", async () => {
    const text = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry("msg-long-lines", text, 0)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Show more");
        expect(host.textContent).toContain("line-7");
        expect(host.textContent).not.toContain("line-11");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not collapse short user messages", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry("msg-short", "short message", 0)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("short message");
        expect(host.textContent).not.toContain("Show more");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not collapse terminal-context user messages", async () => {
    const text = appendTerminalContextsToPrompt("a".repeat(700), [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "bun run build",
      },
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry("msg-terminal-context-long", text, 0)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Terminal 1 line 4");
        expect(host.textContent).not.toContain("Show more");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps long user message expansion state isolated per message", async () => {
    const firstTail = "FIRST_TAIL";
    const secondTail = "SECOND_TAIL";
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("msg-long-first", `${"a".repeat(600)}${firstTail}`, 0),
          makeUserEntry("msg-long-second", `${"b".repeat(600)}${secondTail}`, 1),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Show more");
        expect(host.textContent).not.toContain(firstTail);
        expect(host.textContent).not.toContain(secondTail);
      });

      const secondBodyBefore = host.querySelector<HTMLElement>(
        '[data-message-id="msg-long-second"] [data-render-count]',
      );
      expect(secondBodyBefore).not.toBeNull();
      const secondRenderCountBefore = secondBodyBefore?.dataset.renderCount;
      host.querySelector<HTMLButtonElement>('[data-message-id="msg-long-first"] button')?.click();

      await vi.waitFor(() => {
        expect(host.textContent).toContain(firstTail);
        expect(host.textContent).not.toContain(secondTail);
        const secondBodyAfter = host.querySelector<HTMLElement>(
          '[data-message-id="msg-long-second"] [data-render-count]',
        );
        expect(secondBodyAfter?.dataset.renderCount).toBe(secondRenderCountBefore);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("copies the full user message while collapsed", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const tail = "COPY_TAIL";
    const longText = `${"a".repeat(600)}${tail}`;
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry("msg-copy-collapsed", longText, 0)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Show more");
        expect(host.textContent).not.toContain(tail);
      });

      host.querySelector<HTMLButtonElement>('button[title="Copy message"]')?.click();

      await vi.waitFor(() => {
        expect(clipboardWrite).toHaveBeenCalledWith(longText);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders skill call metadata as an inline chip", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("msg-skill-chip", "$review please look at this", 0, {
            skillCall: { name: "review" },
          }),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[aria-label="/review"]')).not.toBeNull();
        expect(host.textContent).toContain("please look at this");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders skill chips with newline-delimited text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("msg-skill-chip-newline", "$review\nplease look at this", 0, {
            skillCall: { name: "review" },
          }),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[aria-label="/review"]')).not.toBeNull();
        expect(host.textContent).toContain("please look at this");
        expect(host.textContent).not.toContain("$review");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders slash-form skill call metadata as an inline chip", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("msg-skill-chip-slash", "/review please look at this", 0, {
            skillCall: { name: "review" },
          }),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[aria-label="/review"]')).not.toBeNull();
        expect(host.textContent).toContain("please look at this");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders skill chips alongside terminal context labels", async () => {
    const text = appendTerminalContextsToPrompt("$review please look at this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "bun run build",
      },
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("msg-skill-terminal-context", text, 0, {
            skillCall: { name: "review" },
          }),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[aria-label="/review"]')).not.toBeNull();
        expect(host.textContent).toContain("Terminal 1 line 4");
        expect(host.textContent).toContain("please look at this");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps dollar-form skill text plain without metadata", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry("msg-skill-plain", "$review please look at this", 0)]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelector('[aria-label="/review"]')).toBeNull();
        expect(host.textContent).toContain("$review please look at this");
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

  it("keeps inline file diffs visible while routine work entries are paginated", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    const turnId = TurnId.makeUnsafe("turn-inline-always-visible");
    getTurnDiffSpy.mockResolvedValue({
      diff: [
        "diff --git a/apps/web/src/always-visible.ts b/apps/web/src/always-visible.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/web/src/always-visible.ts",
        "+++ b/apps/web/src/always-visible.ts",
        "@@ -1 +1,2 @@",
        " export const visible = true;",
        "+export const stillVisible = true;",
      ].join("\n"),
    });
    const createdAt = "2026-03-04T12:01:00.000Z";
    const entries: TimelineEntry[] = [
      {
        id: "always-visible-file-change-entry",
        kind: "work",
        createdAt,
        entry: {
          id: "always-visible-file-change-work",
          createdAt,
          turnId,
          label: "File change",
          tone: "tool",
          itemType: "file_change",
          status: "completed",
          changedFiles: ["apps/web/src/always-visible.ts"],
        },
      } as TimelineEntry,
      ...Array.from({ length: 8 }, (_, index): TimelineEntry => {
        const activityNumber = index + 1;
        const activityCreatedAt = new Date(
          Date.parse(createdAt) + activityNumber * 1_000,
        ).toISOString();
        return {
          id: `routine-entry-${activityNumber}`,
          kind: "work",
          createdAt: activityCreatedAt,
          entry: {
            id: `routine-work-${activityNumber}`,
            createdAt: activityCreatedAt,
            label: `Routine activity ${String(activityNumber).padStart(2, "0")}`,
            tone: "tool",
            itemType: "dynamic_tool_call",
          },
        } as TimelineEntry;
      }),
    ];

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={entries}
        initialHeight={760}
        onIsAtEndChangeSpy={() => {}}
        workspaceRoot="/repo/project"
        turnDiffSummaryByTurnId={
          new Map([
            [
              turnId,
              {
                turnId,
                completedAt: "2026-03-04T12:01:10.000Z",
                checkpointTurnCount: 3,
                files: [{ path: "apps/web/src/always-visible.ts", additions: 1, deletions: 0 }],
              },
            ],
          ])
        }
        chatDiffContextOverrides={{
          threadId: INLINE_DIFF_THREAD_ID,
          isGitRepo: true,
          inferredCheckpointTurnCountByTurnId: { [turnId]: 3 },
        }}
      />,
      { container: host },
    );

    const findButton = (label: string) =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes(label),
      );
    const findInlineDiff = () =>
      host.querySelector(
        '[data-testid="inline-file-diff"][data-work-entry-id="always-visible-file-change-work"]',
      );

    try {
      await vi.waitFor(() => {
        expect(getTurnDiffSpy).toHaveBeenCalledTimes(1);
        expect(findInlineDiff()).not.toBeNull();
        expect(host.textContent).not.toContain("Routine activity 01");
        expect(host.textContent).not.toContain("Routine activity 02");
        expect(host.textContent).toContain("Routine activity 08");
        expect(findButton("Show 2 more")).toBeTruthy();
      });

      findButton("Show 2 more")?.click();
      await vi.waitFor(() => {
        expect(findInlineDiff()).not.toBeNull();
        expect(host.textContent).toContain("Routine activity 01");
        expect(findButton("Show less")).toBeTruthy();
      });

      findButton("Show less")?.click();
      await vi.waitFor(() => {
        expect(findInlineDiff()).not.toBeNull();
        expect(host.textContent).not.toContain("Routine activity 01");
        expect(findButton("Show 2 more")).toBeTruthy();
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

  it("renders hook-heavy diagnostics incrementally and expands full hook details", async () => {
    const hookDiagnostics = Array.from({ length: 14 }, (_, offset): TimelineWorkEntry => {
      const handlerNumber = offset + 1;
      const createdAt = new Date(
        Date.parse("2026-03-04T12:03:00.000Z") + offset * 1_000,
      ).toISOString();
      return {
        id: `hook-work-${handlerNumber}`,
        createdAt,
        label: `Handler ${handlerNumber} completed`,
        tone: "info",
        activityKind: "hook.completed",
        category: "hook",
        isIssue: false,
        diagnostic: {
          type: "hook",
          id: `hook-${handlerNumber}`,
          hookEvent: "preToolUse",
          source: "plugin",
          sourcePath: `/Users/example/.codex/plugins/example/handler-${handlerNumber}.json`,
          handlerType: "command",
          executionMode: "sync",
          scope: "project",
          displayOrder: handlerNumber,
          status: "completed",
          durationMs: handlerNumber,
          statusMessage: `Handler ${handlerNumber} finished successfully`,
          ...(handlerNumber === 1
            ? { entries: [{ message: `diagnostic output ${handlerNumber}` }] }
            : { output: `diagnostic output ${handlerNumber}` }),
        },
      };
    });
    const hookEntries: TimelineEntry[] = [
      {
        id: "hook-parent-entry",
        kind: "work",
        createdAt: "2026-03-04T12:02:59.000Z",
        entry: {
          id: "hook-parent-work",
          createdAt: "2026-03-04T12:02:59.000Z",
          label: "Read file",
          tone: "tool",
          itemType: "dynamic_tool_call",
          nestedDiagnostics: hookDiagnostics,
        },
      },
    ];

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={hookEntries}
        initialHeight={760}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Read file");
        expect(host.textContent).toContain("Diagnostics (14)");
        expect(host.textContent).toContain("Handler 9 completed");
        expect(host.textContent).not.toContain("Handler 1 completed");
        expect(host.textContent).toContain("Show 6 more");
      });

      const findButton = (label: string) =>
        Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
          button.textContent?.includes(label),
        );

      findButton("Show 6 more")?.click();
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Handler 3 completed");
        expect(host.textContent).not.toContain("Handler 1 completed");
        expect(host.textContent).toContain("Show 2 more");
      });

      findButton("Show 2 more")?.click();
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Handler 1 completed");
        expect(host.textContent).toContain("Show less");
      });

      findButton("Handler 1 completed")?.click();
      await vi.waitFor(() => {
        expect(host.textContent).toContain("/Users/example/.codex/plugins/example/handler-1.json");
        expect(host.textContent).toContain("Handler 1 finished successfully");
        expect(host.textContent).toContain("diagnostic output 1");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders stopped postToolUse output replacements as successful diagnostics", async () => {
    const outputReplacement: TimelineWorkEntry = {
      id: "hook-output-replaced",
      createdAt: "2026-03-04T12:03:00.000Z",
      label: "postToolUse hook applied output replacement",
      tone: "info",
      activityKind: "hook.completed",
      category: "hook",
      isIssue: false,
      diagnostic: {
        type: "hook",
        id: "hook-output-replaced",
        hookEvent: "postToolUse",
        source: "plugin",
        sourcePath: "/Users/example/.codex/plugins/example/hooks-codex.json",
        handlerType: "command",
        displayOrder: 7,
        status: "stopped",
        outcome: "success",
        durationMs: 118,
        entries: [{ kind: "stop", text: "PostToolUse hook stopped execution" }],
      },
    };
    const entries: TimelineEntry[] = [
      {
        id: "hook-output-replaced-row",
        kind: "work",
        createdAt: outputReplacement.createdAt,
        entry: outputReplacement,
      },
    ];

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={entries}
        initialHeight={400}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("postToolUse hook applied output replacement");
        expect(host.textContent).toContain("plugin:hooks-codex.json");
        expect(host.textContent).toContain("order 7");
        expect(host.textContent).toContain("118ms");
        expect(host.textContent).toContain("stopped (output replaced)");
      });

      const rowButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.includes("postToolUse hook applied output replacement"),
      );
      expect(rowButton?.querySelector("svg.lucide-check")).not.toBeNull();
      expect(rowButton?.querySelector("svg.lucide-circle-alert")).toBeNull();

      rowButton?.click();
      await vi.waitFor(() => {
        expect(host.textContent).toContain(
          "/Users/example/.codex/plugins/example/hooks-codex.json",
        );
        expect(host.textContent).toContain("PostToolUse hook stopped execution");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps a manually collapsed Codex collaboration row closed across stable rerenders", async () => {
    const makeCollaborationEntry = (status: "inProgress" | "completed"): TimelineEntry =>
      ({
        id: "collaboration-row",
        kind: "work",
        createdAt: "2026-03-04T12:01:00.000Z",
        entry: {
          id: "collaboration-started",
          createdAt: "2026-03-04T12:01:00.000Z",
          label: "Collaboration call",
          tone: "tool",
          itemType: "collab_agent_tool_call",
          status,
          codexCollaborationTool: "sendInput",
          subagentPrompt: "Review reconnect handling",
          subagentReceiverThreadIds: ["agent-reviewer"],
          ...(status === "completed"
            ? {
                subagentStates: [
                  {
                    threadId: "agent-reviewer",
                    status: "completed" as const,
                    message: "Reconnect handling is sound",
                  },
                ],
              }
            : {}),
        },
      }) as TimelineEntry;

    let api: TimelineHarnessApi | null = null;
    const started = makeCollaborationEntry("inProgress");
    const completed = makeCollaborationEntry("completed");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[started]}
        initialHeight={400}
        onIsAtEndChangeSpy={() => {}}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );

    try {
      expect(api).not.toBeNull();
      expect(host.textContent).toContain("Sending message to 1 agent");
      expect(host.querySelector('[data-subagent-state="completed"]')).toBeNull();

      api!.setEntries([completed]);
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Sent message to 1 agent");
        expect(host.querySelector('[data-subagent-state="completed"]')).not.toBeNull();
      });

      const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.includes("Sent message to 1 agent"),
      );
      expect(trigger).toBeDefined();
      trigger!.click();
      await vi.waitFor(() => {
        expect(host.querySelector('[data-subagent-state="completed"]')).toBeNull();
      });

      api!.setEntries([
        makeAssistantEntry("unrelated-before", "Unrelated earlier row", -1),
        completed,
        makeAssistantEntry("unrelated-after", "Unrelated later row", 120),
      ]);
      await vi.waitFor(() => {
        expect(host.querySelector('[data-timeline-row-id="collaboration-row"]')).not.toBeNull();
        expect(host.querySelector('[data-subagent-state="completed"]')).toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
