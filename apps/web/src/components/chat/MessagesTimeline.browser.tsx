import {
  TimelineHarness,
  waitForTimelineLayout,
  makeUserEntry,
  makeAssistantEntry,
  type TimelineHarnessApi,
} from "../../test/timeline";
// Production CSS is part of the behavior under test because LegendList's
// internal measurement depends on Tailwind sizing utilities applied to each
// row.
import "../../index.css";

import { QueryClient } from "@tanstack/react-query";
import type { OrchestrationCommandExecution } from "@t3tools/contracts";
import {
  EventId,
  MessageId,
  type NativeApi,
  type OrchestrationFileChangeSummary,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "@vitest/browser-playwright"; // Types cdp() as a Playwright CDPSession.
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  deriveWorkLogEntries,
  type deriveTimelineEntries,
  type LiveWorkActivity,
} from "../../session-logic";
import { parsePersistedAppSettings } from "../../appSettings";
import type { TurnDiffSummary } from "../../types";
import { readTimelineScrollAnchor } from "./timelineScrollAnchors";
import {
  buildTimelineRowExternals,
  buildTimelineRows,
  createTimelineRowCache,
  type TimelineRowExternalsInputs,
} from "./MessagesTimeline";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";

const reducedMotionStore = vi.hoisted(() => {
  let value = false;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: boolean) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("../../hooks/useReducedMotion", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useReducedMotion: () =>
      useSyncExternalStore(reducedMotionStore.subscribe, reducedMotionStore.get),
  };
});

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

function makeReadWorkEntry(id: string, path: string, offsetSeconds: number): TimelineEntry {
  const createdAt = new Date(
    Date.parse("2026-03-04T12:00:00.000Z") + offsetSeconds * 1000,
  ).toISOString();
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id,
      createdAt,
      label: "Read file",
      tone: "tool",
      requestKind: "file-read",
      readPaths: [path],
      changedFiles: [path],
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
  await waitForTimelineLayout(() => scrollContainer);
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
  await vi.waitFor(async () => {
    if (listRef?.scrollToOffset) {
      await listRef.scrollToOffset({ offset: nextScrollTop, animated: false });
    } else {
      scrollContainerToOffset(container, nextScrollTop);
    }
    // Let initial virtual-row measurements and scroll anchoring settle before
    // the test observes the requested position or appends more rows.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const expectedOffset = Math.min(nextScrollTop, container.scrollHeight - container.clientHeight);
    expect(Math.abs(container.scrollTop - expectedOffset)).toBeLessThan(2);
  });
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

  it("renders the actual skill name from persisted generic tool history", async () => {
    const createdAt = "2026-03-04T12:00:01.000Z";
    const [entry] = deriveWorkLogEntries(
      [
        {
          id: EventId.makeUnsafe("skill-history"),
          createdAt,
          kind: "tool.completed",
          summary: "Tool call completed",
          tone: "tool",
          turnId: TurnId.makeUnsafe("turn-1"),
          payload: {
            itemType: "dynamic_tool_call",
            title: "Tool call",
            providerItemId: "skill-call",
            status: "completed",
            data: { toolName: "Skill", input: { skill: "team:review" } },
          },
        },
      ],
      undefined,
    );
    expect(entry?.toolTitle).toBe("Skill: team:review");
    await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("skill-user", "Review the patch", 0),
          { id: entry!.id, kind: "work", createdAt, entry: entry! },
        ]}
        onIsAtEndChangeSpy={vi.fn()}
      />,
    );
    await expect.element(page.getByText("Skill: team:review", { exact: true })).toBeVisible();
  });

  it("restores a thread reading position after navigating away", async () => {
    const threadId = ThreadId.makeUnsafe("remember-reading-position");
    const entries = makeOverflowEntries(40);
    let list: LegendListRef | null = null;
    const screen = await render(
      <TimelineHarness
        threadId={threadId}
        initialEntries={entries}
        onIsAtEndChangeSpy={vi.fn()}
        initialHeight={360}
        onListRefChange={(value) => {
          list = value;
        }}
      />,
    );
    const node = () =>
      document.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]')!;
    await expect.poll(() => node()?.scrollHeight ?? 0).toBeGreaterThan(1000);
    await scrollTimelineToOffset(list, node(), 700);
    const before = readTimelineScrollAnchor(node());

    await screen.unmount();
    const reopened = await render(
      <TimelineHarness
        threadId={threadId}
        initialEntries={entries}
        onIsAtEndChangeSpy={vi.fn()}
        initialHeight={360}
      />,
    );
    try {
      await expect
        .poll(() => {
          const after = readTimelineScrollAnchor(node());
          return after.rowId === before.rowId ? Math.abs(after.top - before.top) : 99999;
        })
        .toBeLessThan(3);
    } finally {
      await reopened.unmount();
    }
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

  it("scrolls the timeline when the wheel turns over the turn rail or minimap", async () => {
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
    await scrollTimelineToOffset(listRef, container, container.scrollHeight);
    const targets = [
      host.querySelector<HTMLElement>('[data-testid="timeline-turn-rail-strip"]'),
      host.querySelector<HTMLElement>('[aria-label="Conversation minimap"]'),
    ];
    for (const target of targets) {
      expect(target).not.toBeNull();
      const before = container.scrollTop;
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 });
      target!.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(container.scrollTop).toBeLessThan(before));
    }
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

  it("keeps a visible turn-rail hit target inside the measured gutter", async () => {
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
      expect(Number.parseFloat(getComputedStyle(strip!).width)).toBeGreaterThan(0);
      expect(getComputedStyle(strip!).pointerEvents).toBe("auto");
      expect(Number.parseFloat(getComputedStyle(rail!).opacity)).toBeGreaterThan(0);
    });
    const messageText = host.querySelector<HTMLElement>('[data-message-id="overflow-user-0"]');
    const contentColumn = host.querySelector<HTMLElement>('[data-timeline-root="true"]');
    expect(strip!.getBoundingClientRect().right).toBeLessThanOrEqual(
      contentColumn!.getBoundingClientRect().left,
    );
    expect(getComputedStyle(messageText!).pointerEvents).not.toBe("none");

    const compactStripRect = strip!.getBoundingClientRect();
    strip!.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: compactStripRect.left + 1,
        clientY: compactStripRect.top + compactStripRect.height / 2,
      }),
    );
    await vi.waitFor(() => {
      expect(host.querySelector("[data-turn-rail-preview]")).not.toBeNull();
    });
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

  it("keeps the latest turn's work log open and collapses it once the next turn starts", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let api: TimelineHarnessApi | null = null;
    const firstTurn = [
      makeUserEntry("collapse-user-1", "Read the sources", 0),
      makeReadWorkEntry("collapse-work-1", "src/a.ts", 1),
      makeReadWorkEntry("collapse-work-2", "src/b.ts", 2),
    ];
    const screen = await render(
      <TimelineHarness
        initialEntries={firstTurn}
        initialIsWorking
        onIsAtEndChangeSpy={() => {}}
        setApi={(nextApi) => {
          api = nextApi;
        }}
      />,
      { container: host },
    );
    const summaryButton = () =>
      host.querySelector<HTMLButtonElement>('[data-slot="work-group-summary"]');

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("src/a.ts");
      });
      expect(summaryButton()).toBeNull();

      // The turn settles under the reader: the group must stay open.
      const settledTurn = [...firstTurn, makeAssistantEntry("collapse-assistant-1", "Done.", 3)];
      api!.setTimelineState({ entries: settledTurn, isWorking: false });
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Done.");
      });
      expect(summaryButton()).toBeNull();
      expect(host.textContent).toContain("src/b.ts");

      // The next send pushes the group into a prior turn, which collapses.
      api!.setTimelineState({
        entries: [...settledTurn, makeUserEntry("collapse-user-2", "Now fix it", 4)],
        isWorking: true,
      });
      await vi.waitFor(() => {
        expect(summaryButton()).not.toBeNull();
      });
      expect(summaryButton()!.textContent).toContain("Read 2 files");
      expect(summaryButton()!.getAttribute("aria-expanded")).toBe("false");
      expect(host.textContent).not.toContain("src/a.ts");

      summaryButton()!.click();
      await vi.waitFor(() => {
        expect(host.textContent).toContain("src/a.ts");
      });
      expect(summaryButton()).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps a prior-turn MCP app visible while ordinary work logs collapse", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const appEntry = makeReadWorkEntry("app-work", "unused", 2);
    if (appEntry.kind !== "work") throw new Error("Expected work entry");
    appEntry.entry = {
      ...appEntry.entry,
      label: "Weather app",
      readPaths: [],
      changedFiles: [],
      mcpApp: {
        reference: {
          attachmentId: "weather-doc",
          server: "weather",
          tool: "forecast",
          resourceUri: "ui://weather/app",
        },
        arguments: {},
        result: { content: [] },
      },
    };
    const screen = await render(
      <TimelineHarness
        threadId={INLINE_DIFF_THREAD_ID}
        initialEntries={[
          makeUserEntry("app-user-1", "Weather", 0),
          makeReadWorkEntry("app-read", "src/weather.ts", 1),
          appEntry,
          makeAssistantEntry("app-answer", "Sunny", 3),
          makeUserEntry("app-user-2", "Tomorrow?", 4),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );
    try {
      await vi.waitFor(() => {
        expect(
          host.querySelector('[data-slot="work-group-summary"]')?.getAttribute("aria-expanded"),
        ).toBe("false");
        expect(host.textContent).toContain("Send a message to reconnect.");
      });
      expect(host.textContent).not.toContain("src/weather.ts");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps prior work logs open when the collapse setting is off", async () => {
    persistAppSettings({ collapseCompletedWorkLogs: false });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("open-user-1", "Read the sources", 0),
          makeReadWorkEntry("open-work-1", "src/a.ts", 1),
          makeAssistantEntry("open-assistant-1", "Done.", 2),
          makeUserEntry("open-user-2", "Again", 3),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("src/a.ts");
      });
      expect(host.querySelector('[data-slot="work-group-summary"]')).toBeNull();
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

  it("follows the tail from a scrolled-up position when a new turn requests it", async () => {
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
      await vi.waitFor(() => expect(isAtEndCalls.at(-1)).toBe(false));

      api!.followNewTurn([
        ...initialEntries,
        makeUserEntry("msg-user-followed-tail", "followed tail target", 121),
      ]);

      await vi.waitFor(
        () => {
          const appendedRow = host.querySelector<HTMLElement>(
            '[data-message-id="msg-user-followed-tail"]',
          );
          expect(appendedRow, "The followed row should be rendered.").not.toBeNull();
          expect(isElementVisibleWithinContainer(appendedRow!, scrollContainer)).toBe(true);
        },
        { timeout: 4_000 },
      );
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

      // Reflow settles over a few frames; under full-suite load that can exceed 1s.
      await vi.waitFor(
        () => {
          expect(isAtEndCalls).toContain(true);
        },
        { timeout: 4_000, interval: 16 },
      );
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

  it("keeps short user bubbles tight when revert actions are available", async () => {
    const messageId = "msg-short-bubble" as MessageId;
    const host = document.createElement("div");
    host.style.width = "900px";
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry(messageId, "test", 0)]}
        onIsAtEndChangeSpy={() => {}}
        revertTurnCountByUserMessageId={new Map([[messageId, 1]])}
        canRestoreFiles
      />,
      { container: host },
    );

    try {
      let bubble: HTMLElement | null = null;
      await vi.waitFor(() => {
        bubble = host.querySelector<HTMLElement>('[data-slot="user-message-bubble"]');
        expect(bubble).not.toBeNull();
        expect(
          host.querySelector('button[aria-label="Revert to before this message"]'),
        ).not.toBeNull();
      });
      const bubbleRect = bubble!.getBoundingClientRect();
      expect(bubbleRect.width).toBeLessThan(200);
      // Hover actions live outside the bubble, so they must not add height to it.
      expect(bubble!.querySelector("button")).toBeNull();
      expect(bubbleRect.height).toBeLessThan(60);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("confirms a revert from the anchored popover, previewing what it removes", async () => {
    const firstId = "msg-revert-first" as MessageId;
    const targetId = "msg-revert-target" as MessageId;
    const onRevertUserMessage = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const entries = [
      makeUserEntry(firstId, "keep me", 0),
      makeUserEntry(targetId, "revert me", 10),
    ];
    const screen = await render(
      <TimelineHarness
        initialEntries={entries}
        onIsAtEndChangeSpy={() => {}}
        revertTurnCountByUserMessageId={
          new Map([
            [firstId, 0],
            [targetId, 1],
          ])
        }
        onRevertUserMessage={onRevertUserMessage}
        canRestoreFiles={false}
      />,
      { container: host },
    );
    const rowOf = (id: MessageId) =>
      host
        .querySelector(`[data-message-id="${id}"]`)
        ?.closest<HTMLElement>("[data-revert-dimmed], [data-timeline-root] > div");

    try {
      const triggers = page.getByRole("button", { name: "Revert to before this message" });
      await triggers.nth(1).click();
      const popover = page.getByRole("dialog", { name: "Revert to before this message" });
      await vi.waitFor(() => {
        expect(popover.element().textContent).toContain("Removes this message.");
        expect(popover.element().textContent).toContain("needs an isolated workspace");
        expect(
          page.getByRole("button", { name: "Restore files" }).element().hasAttribute("disabled"),
        ).toBe(true);
        // Only the target and what follows it are dimmed while deciding.
        expect(rowOf(targetId)?.hasAttribute("data-revert-dimmed")).toBe(true);
        expect(rowOf(firstId)?.hasAttribute("data-revert-dimmed")).toBe(false);
      });

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(rowOf(targetId)?.hasAttribute("data-revert-dimmed")).toBe(false);
        expect(document.querySelector('[data-slot="revert-popover"]')).toBeNull();
      });
      expect(onRevertUserMessage).not.toHaveBeenCalled();

      await screen.rerender(
        <TimelineHarness
          initialEntries={entries}
          onIsAtEndChangeSpy={() => {}}
          revertTurnCountByUserMessageId={
            new Map([
              [firstId, 0],
              [targetId, 1],
            ])
          }
          onRevertUserMessage={onRevertUserMessage}
          canRestoreFiles
        />,
      );
      await triggers.nth(0).click();
      await page.getByRole("button", { name: "Restore files" }).click();
      await vi.waitFor(() => {
        expect(popover.element().textContent).toContain(
          "Removes this message and the one after it.",
        );
      });
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(onRevertUserMessage).toHaveBeenCalledTimes(1);
        expect(onRevertUserMessage).toHaveBeenLastCalledWith(firstId, true, null);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("sends the newest message seen when the popover opened, not when it was confirmed", async () => {
    const messageId = "msg-revert-tail" as MessageId;
    const seenTail = "msg-seen-tail" as MessageId;
    const onRevertUserMessage = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const harness = (latestMessageId: MessageId) => (
      <TimelineHarness
        initialEntries={[makeUserEntry(messageId, "revert me", 0)]}
        onIsAtEndChangeSpy={() => {}}
        revertTurnCountByUserMessageId={new Map([[messageId, 0]])}
        onRevertUserMessage={onRevertUserMessage}
        latestMessageId={latestMessageId}
      />
    );
    const screen = await render(harness(seenTail), { container: host });

    try {
      await page.getByRole("button", { name: "Revert to before this message" }).click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="revert-popover"]')).not.toBeNull();
      });
      // A message arrives while the user is still deciding.
      await screen.rerender(harness("msg-arrived-later" as MessageId));
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(onRevertUserMessage).toHaveBeenCalledWith(messageId, false, seenTail);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("consumes a reopen request once, and drops it while revert is unavailable", async () => {
    const messageId = "msg-revert-reopen" as MessageId;
    const onRevertReopenHandled = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const request = { messageId, restoreFiles: false, nonce: 7 };
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry(messageId, "revert me", 0)]}
        onIsAtEndChangeSpy={() => {}}
        revertTurnCountByUserMessageId={new Map([[messageId, 0]])}
        revertReopenRequest={request}
        onRevertReopenHandled={onRevertReopenHandled}
        revertDisabledReason="Stop the agent to revert"
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(onRevertReopenHandled).toHaveBeenCalledWith(7);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.querySelector('[data-slot="revert-popover"]')).toBeNull();

      await screen.rerender(
        <TimelineHarness
          initialEntries={[makeUserEntry(messageId, "revert me", 0)]}
          onIsAtEndChangeSpy={() => {}}
          revertTurnCountByUserMessageId={new Map([[messageId, 0]])}
          revertReopenRequest={{ ...request, nonce: 8 }}
          onRevertReopenHandled={onRevertReopenHandled}
        />,
      );
      await vi.waitFor(() => {
        expect(onRevertReopenHandled).toHaveBeenLastCalledWith(8);
        expect(document.querySelector('[data-slot="revert-popover"]')).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("explains why revert is unavailable and shows progress while it runs", async () => {
    const messageId = "msg-revert-disabled" as MessageId;
    const onRevertUserMessage = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[makeUserEntry(messageId, "revert me", 0)]}
        onIsAtEndChangeSpy={() => {}}
        revertTurnCountByUserMessageId={new Map([[messageId, 0]])}
        onRevertUserMessage={onRevertUserMessage}
        revertDisabledReason="Cursor doesn't support revert"
      />,
      { container: host },
    );

    try {
      const trigger = page.getByRole("button", { name: "Revert to before this message" });
      await vi.waitFor(() => {
        expect(trigger.element().getAttribute("aria-disabled")).toBe("true");
      });
      await trigger.hover();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Cursor doesn't support revert");
      });
      // Playwright refuses to click aria-disabled controls; a DOM click must not open it either.
      (trigger.element() as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.querySelector('[data-slot="revert-popover"]')).toBeNull();

      await screen.rerender(
        <TimelineHarness
          initialEntries={[makeUserEntry(messageId, "revert me", 0)]}
          onIsAtEndChangeSpy={() => {}}
          revertTurnCountByUserMessageId={new Map([[messageId, 0]])}
          onRevertUserMessage={onRevertUserMessage}
          pendingRevert={{ targetMessageId: messageId, label: "Reverting conversation…" }}
        />,
      );
      await vi.waitFor(() => {
        expect(host.querySelector('[data-slot="revert-status-pill"]')?.textContent).toContain(
          "Reverting conversation…",
        );
        expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
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

  it("stays at the end while a command row at the end opens and closes", async () => {
    const commandId = "command-toggle-at-end";
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          ...makeOverflowEntries(16),
          makeCommandEntry(commandId, {
            output: Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n"),
          }),
        ]}
        initialHeight={240}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );
    const toggle = () =>
      host.querySelector<HTMLButtonElement>(
        `[data-timeline-row-id="${commandId}"] button[aria-expanded]`,
      );
    try {
      const scrollContainer = await waitForScrollContainer(host);
      const distanceFromEnd = () =>
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
      await vi.waitFor(() => {
        expect(toggle()).not.toBeNull();
        expect(distanceFromEnd()).toBeLessThan(8);
      });
      for (const expanded of ["true", "false"]) {
        toggle()!.click();
        await vi.waitFor(() => {
          expect(toggle()?.getAttribute("aria-expanded")).toBe(expanded);
          expect(distanceFromEnd()).toBeLessThan(8);
        });
      }

      // Scrolled up, the toggled row holds its place instead of following the end.
      scrollContainer.scrollTop -= 120;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rowTop = toggle()!.getBoundingClientRect().top;
      toggle()!.click();
      await vi.waitFor(() => {
        expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
        expect(Math.abs(toggle()!.getBoundingClientRect().top - rowTop)).toBeLessThan(2);
        expect(distanceFromEnd()).toBeGreaterThan(100);
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

describe("MessagesTimeline working ribbon", () => {
  const TURN_START = "2026-03-04T12:00:00.000Z";
  const at = (seconds: number) => new Date(Date.parse(TURN_START) + seconds * 1000).toISOString();

  const grabButton = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>("[data-working-ribbon-grab]");
  const plainLabel = (host: HTMLElement) =>
    Array.from(host.querySelectorAll<HTMLElement>("span.tabular-nums")).find((element) =>
      element.textContent?.startsWith("Working"),
    ) ?? null;
  const stage = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-slot="working-ribbon"]');
  const glyphs = (host: HTMLElement) =>
    Array.from(host.querySelectorAll<HTMLElement>("[data-ribbon-glyph]"));
  const ribbonText = (host: HTMLElement) =>
    glyphs(host)
      .map((glyph) => glyph.textContent)
      .join("");

  function glyphTranslate(glyph: HTMLElement): { x: number; y: number } {
    const matrix = new DOMMatrixReadOnly(glyph.style.transform);
    return { x: matrix.m41, y: matrix.m42 };
  }

  const headGlyph = (host: HTMLElement) => glyphTranslate(glyphs(host).at(-1)!);

  function expectPlacedGlyphs(host: HTMLElement) {
    for (const glyph of glyphs(host)) {
      expect(glyph.style.transform).toContain("translate(");
      const { x, y } = glyphTranslate(glyph);
      expect(x !== 0 || y !== 0).toBe(true);
    }
  }

  /** Every glyph's painted box (rotation included) lies inside the stage. */
  function expectGlyphsInsideStage(host: HTMLElement) {
    const bounds = stage(host)!.getBoundingClientRect();
    for (const glyph of glyphs(host)) {
      const rect = glyph.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 0.5);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 0.5);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 0.5);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 0.5);
    }
  }

  async function nextFrames(count = 2) {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  async function expectRibbonSettles(host: HTMLElement) {
    await vi.waitFor(
      async () => {
        const before = headGlyph(host);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const after = headGlyph(host);
        expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(2);
      },
      { timeout: 5_000, interval: 50 },
    );
  }

  async function mountWorkingTimeline(
    options: {
      entries?: TimelineEntry[];
      initialNowIso?: string;
      initialActiveTurnStartedAt?: string | null;
      initialHeight?: number;
      initialLiveActivity?: LiveWorkActivity;
      threadId?: ThreadId;
      strict?: boolean;
    } = {},
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    let api: TimelineHarnessApi | null = null;
    const focusLost = vi.fn();
    const harness = (
      <TimelineHarness
        initialEntries={options.entries ?? [makeUserEntry("ribbon-user", "Keep going", 0)]}
        initialIsWorking
        initialHeight={options.initialHeight ?? 400}
        {...(options.initialNowIso ? { initialNowIso: options.initialNowIso } : {})}
        {...(options.initialActiveTurnStartedAt !== undefined
          ? { initialActiveTurnStartedAt: options.initialActiveTurnStartedAt }
          : {})}
        {...(options.threadId ? { threadId: options.threadId } : {})}
        {...(options.initialLiveActivity !== undefined
          ? { initialLiveActivity: options.initialLiveActivity }
          : {})}
        onIsAtEndChangeSpy={() => {}}
        onWorkingRibbonFocusLost={focusLost}
        setApi={(next) => {
          api = next;
        }}
      />
    );
    const screen = await render(options.strict ? <StrictMode>{harness}</StrictMode> : harness, {
      container: host,
    });
    await vi.waitFor(() => {
      expect(grabButton(host) ?? plainLabel(host)).not.toBeNull();
    });
    return {
      host,
      focusLost,
      api: () => api!,
      cleanup: async () => {
        await screen.unmount();
        host.remove();
      },
    };
  }

  async function grab(host: HTMLElement) {
    await userEvent.click(grabButton(host)!);
    await vi.waitFor(() => {
      expect(stage(host)).not.toBeNull();
      expect(document.activeElement).toBe(stage(host));
    });
  }

  async function expectReleasedTo(host: HTMLElement, focused: () => Element | null) {
    await vi.waitFor(() => {
      expect(stage(host)).toBeNull();
      expect(document.activeElement).toBe(focused());
    });
  }

  beforeEach(async () => {
    localStorage.clear();
    persistAppSettings();
    reducedMotionStore.set(false);
    await page.viewport(1000, 800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    reducedMotionStore.set(false);
    document.body.innerHTML = "";
  });

  it("renders the grab button exactly like the plain label", async () => {
    for (const startedAt of [TURN_START, null]) {
      reducedMotionStore.set(false);
      const mounted = await mountWorkingTimeline({
        entries: [
          makeUserEntry("ribbon-footprint-user", "Read it", 0),
          makeReadWorkEntry("ribbon-footprint-read", "src/a.ts", 1),
        ],
        initialActiveTurnStartedAt: startedAt,
        initialLiveActivity: { kind: "tool", providerItemId: null, title: "Read src/a.ts" },
      });
      const { host } = mounted;
      const measure = () => {
        const label = (grabButton(host) ?? plainLabel(host))!;
        const row = label.parentElement!;
        const activity = row.querySelector<HTMLElement>("span.truncate");
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const rect = label.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          textLeft: text.left,
          textTop: text.top,
          textBottom: text.bottom,
          rowHeight: row.parentElement!.offsetHeight,
          activityLeft: activity?.getBoundingClientRect().left ?? -1,
          activityWidth: activity?.getBoundingClientRect().width ?? -1,
        };
      };
      try {
        await vi.waitFor(() => {
          expect(grabButton(host)).not.toBeNull();
          expect(grabButton(host)!.parentElement!.querySelector("span.truncate")).not.toBeNull();
        });
        const asButton = measure();
        reducedMotionStore.set(true);
        await vi.waitFor(() => {
          expect(grabButton(host)).toBeNull();
          expect(plainLabel(host)).not.toBeNull();
        });
        const asSpan = measure();
        expect(asButton).toEqual(asSpan);
      } finally {
        await mounted.cleanup();
      }
    }
  });

  it("picks the label up on click without moving the row or the list", async () => {
    const mounted = await mountWorkingTimeline({ entries: makeOverflowEntries(30) });
    const { host } = mounted;
    try {
      const scroller = await waitForScrollContainer(host);
      await vi.waitFor(() => {
        expect(grabButton(host)).not.toBeNull();
      });
      await nextFrames(4);
      const button = grabButton(host)!;
      const rowHeight = button.parentElement!.parentElement!.offsetHeight;
      const scrollTop = scroller.scrollTop;

      await grab(host);

      expect(getComputedStyle(button).visibility).toBe("hidden");
      expect(button.parentElement!.parentElement!.offsetHeight).toBe(rowHeight);
      expect(scroller.scrollTop).toBe(scrollTop);
      expect(ribbonText(host)).toBe("Working · 5m");
      expectPlacedGlyphs(host);
    } finally {
      await mounted.cleanup();
    }
  });

  it("picks the label up with Enter or Space", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      grabButton(host)!.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(stage(host));
      });
      await userEvent.keyboard("{Escape}");
      await expectReleasedTo(host, () => grabButton(host));

      await userEvent.keyboard("[Space]");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(stage(host));
      });
      await userEvent.keyboard("{Escape}");
      await expectReleasedTo(host, () => grabButton(host));
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not re-grab when focus returns while Enter is still held", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      grabButton(host)!.focus();
      await userEvent.keyboard("{Enter>}");
      try {
        await vi.waitFor(() => {
          expect(document.activeElement).toBe(stage(host));
        });
        // The ribbon drops for lack of room and focus returns to the label
        // while Enter is still down; its autorepeat must not grab again.
        // (Chromium ignores button repeats by itself; the label's own
        // repeat guard is for engines that do not.)
        mounted.api().setDockHeight(395);
        await expectReleasedTo(host, () => grabButton(host));
        mounted.api().setDockHeight(0);
        // A trusted autorepeat keydown; userEvent will not re-press a held key.
        const repeats: boolean[] = [];
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === "Enter") repeats.push(event.repeat);
        };
        window.addEventListener("keydown", onKeyDown, true);
        try {
          // With `text`, Chrome follows up with the keypress that activates
          // the button, unless the keydown was default-prevented.
          await cdp().send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            text: "\r",
            windowsVirtualKeyCode: 13,
            autoRepeat: true,
          });
        } finally {
          window.removeEventListener("keydown", onKeyDown, true);
        }
        await nextFrames(3);
        expect(repeats).toEqual([true]);
        expect(stage(host)).toBeNull();
        expect(document.activeElement).toBe(grabButton(host));
      } finally {
        await userEvent.keyboard("{/Enter}");
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("steers with the arrow keys and settles after release", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      const start = headGlyph(host);
      await userEvent.keyboard("{ArrowRight>}");
      try {
        await vi.waitFor(
          () => {
            expect(headGlyph(host).x).toBeGreaterThan(start.x + 30);
          },
          { timeout: 3_000 },
        );
      } finally {
        await userEvent.keyboard("{/ArrowRight}");
      }
      await expectRibbonSettles(host);
      expect(document.activeElement).toBe(stage(host));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps steering keys from scrolling the list", async () => {
    const mounted = await mountWorkingTimeline({ entries: makeOverflowEntries(30) });
    const { host } = mounted;
    // Captured on the way down; checked once dispatch has finished.
    const arrowEvents: KeyboardEvent[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") arrowEvents.push(event);
    };
    try {
      const scroller = await waitForScrollContainer(host);
      await vi.waitFor(() => {
        expect(grabButton(host)).not.toBeNull();
      });
      await nextFrames(4);
      await grab(host);
      const scrollTop = scroller.scrollTop;
      window.addEventListener("keydown", onKeyDown, true);
      await userEvent.keyboard("{ArrowUp>6/}");
      await nextFrames(3);
      expect(arrowEvents.length).toBeGreaterThan(1);
      expect(arrowEvents.every((event) => event.defaultPrevented)).toBe(true);
      expect(scroller.scrollTop).toBe(scrollTop);
      expect(document.scrollingElement?.scrollTop ?? 0).toBe(0);
    } finally {
      window.removeEventListener("keydown", onKeyDown, true);
      await mounted.cleanup();
    }
  });

  it("stops steering when a modifier swallows the arrow's keyup", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      const start = headGlyph(host);
      await userEvent.keyboard("{ArrowRight>}");
      try {
        await vi.waitFor(() => {
          expect(headGlyph(host).x).toBeGreaterThan(start.x + 10);
        });
        // macOS never delivers the arrow's keyup while Cmd is down: the
        // ribbon must settle with no keyup for the arrow at all.
        await userEvent.keyboard("{Meta>}{/Meta}");
        await expectRibbonSettles(host);
        // A stuck arrow would instead pin the head against the right edge.
        expect(headGlyph(host).x).toBeLessThan(stage(host)!.clientWidth - 200);
      } finally {
        await userEvent.keyboard("{/ArrowRight}");
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the live timer in flight as glyphs come and go", async () => {
    const mounted = await mountWorkingTimeline({ initialNowIso: at(9) });
    const { host } = mounted;
    try {
      await grab(host);
      expect(ribbonText(host)).toBe("Working · 9s");
      expect(stage(host)!.textContent).toContain("Working · 9s");

      for (const [seconds, label] of [
        [10, "Working · 10s"],
        [59, "Working · 59s"],
        [60, "Working · 1m"],
      ] as const) {
        mounted.api().setTimelineState({ nowIso: at(seconds) });
        await vi.waitFor(() => {
          expect(ribbonText(host)).toBe(label);
        });
        expect(glyphs(host)).toHaveLength(Array.from(label).length);
        expectPlacedGlyphs(host);
        expectGlyphsInsideStage(host);
      }
      expect(document.activeElement).toBe(stage(host));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the same stage when the turn's start time arrives mid-flight", async () => {
    const mounted = await mountWorkingTimeline({ initialActiveTurnStartedAt: null });
    const { host } = mounted;
    try {
      await grab(host);
      expect(ribbonText(host)).toBe("Working…");
      const stageNode = stage(host);
      await userEvent.keyboard("{ArrowDown>}");
      try {
        mounted.api().setTimelineState({ activeTurnStartedAt: TURN_START });
        await vi.waitFor(() => {
          expect(ribbonText(host)).toBe("Working · 5m");
        });
        expect(stage(host)).toBe(stageNode);
        expect(document.activeElement).toBe(stageNode);
        expectPlacedGlyphs(host);
        const before = headGlyph(host);
        await vi.waitFor(() => {
          expect(headGlyph(host).y).toBeGreaterThan(before.y + 20);
        });
      } finally {
        await userEvent.keyboard("{/ArrowDown}");
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the playfield above the composer dock", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      const dockHost = host.querySelector<HTMLElement>("[data-composer-dock-host]")!;
      expect(stage(host)!.getBoundingClientRect().bottom).toBeCloseTo(
        dockHost.getBoundingClientRect().bottom,
        0,
      );
      mounted.api().setDockHeight(120);
      await vi.waitFor(() => {
        expect(stage(host)!.getBoundingClientRect().bottom).toBeCloseTo(
          dockHost.getBoundingClientRect().bottom - 120,
          0,
        );
      });
      expect(document.activeElement).toBe(stage(host));

      // A dock that leaves no room drops the ribbon back into its row.
      mounted.api().setDockHeight(395);
      await expectReleasedTo(host, () => grabButton(host));
      expect(mounted.focusLost).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps every glyph inside a stage that shrinks under a steered trail", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      // Lay a long vertical trail, then shrink the stage below it.
      await userEvent.keyboard("{ArrowDown>}");
      try {
        await vi.waitFor(
          () => {
            expect(headGlyph(host).y).toBeGreaterThan(300);
          },
          { timeout: 3_000 },
        );
      } finally {
        await userEvent.keyboard("{/ArrowDown}");
      }
      mounted.api().setHeight(120);
      await vi.waitFor(() => {
        expect(stage(host)!.getBoundingClientRect().height).toBeCloseTo(120, 0);
      });
      await nextFrames(2);
      expectGlyphsInsideStage(host);
      // Still in bounds once the remaining momentum plays out.
      await expectRibbonSettles(host);
      expectGlyphsInsideStage(host);
      expect(document.activeElement).toBe(stage(host));
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops the ribbon when the timeline gets too short", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      mounted.api().setHeight(30);
      await expectReleasedTo(host, () => grabButton(host));
    } finally {
      await mounted.cleanup();
    }
  });

  it("re-measures when appearance settings change the root style", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    const root = document.documentElement;
    const previousFontSize = root.style.fontSize;
    try {
      await grab(host);
      const spread = () => {
        const all = glyphs(host);
        return Math.abs(glyphTranslate(all.at(-1)!).x - glyphTranslate(all[0]!).x);
      };
      const before = spread();
      root.style.fontSize = "24px";
      await vi.waitFor(() => {
        expect(spread()).toBeGreaterThan(before + 10);
      });
      expect(stage(host)).not.toBeNull();
      expect(document.activeElement).toBe(stage(host));
      expectGlyphsInsideStage(host);
    } finally {
      root.style.fontSize = previousFontSize;
      await mounted.cleanup();
    }
  });

  it("drops on Escape, returns focus, and claims the key", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    // Captured on the way down; a bubbling window listener (the sidebar's
    // Escape handler) must never see it.
    let escapeEvent: KeyboardEvent | null = null;
    let escapeReachedWindow = false;
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapeEvent = event;
    };
    const onBubble = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapeReachedWindow = true;
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    try {
      await grab(host);
      await userEvent.keyboard("{Escape}");
      await expectReleasedTo(host, () => grabButton(host));
      expect(escapeEvent).not.toBeNull();
      expect(escapeEvent!.defaultPrevented).toBe(true);
      expect(escapeReachedWindow).toBe(false);
      expect(getComputedStyle(grabButton(host)!).visibility).toBe("visible");
      expect(mounted.focusLost).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
      await mounted.cleanup();
    }
  });

  it("drops when focus moves to another control", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      mounted.api().setHeaderContent(
        <button type="button" data-testid="ribbon-header-button">
          Header
        </button>,
      );
      const headerButton = () =>
        host.querySelector<HTMLButtonElement>('[data-testid="ribbon-header-button"]');
      await vi.waitFor(() => {
        expect(headerButton()).not.toBeNull();
      });
      await grab(host);
      headerButton()!.focus();
      await expectReleasedTo(host, headerButton);
      await nextFrames(2);
      expect(document.activeElement).toBe(headerButton());
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops when the window blurs or the tab is hidden", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      window.dispatchEvent(new Event("blur"));
      await vi.waitFor(() => {
        expect(stage(host)).toBeNull();
      });

      await grab(host);
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.waitFor(() => {
          expect(stage(host)).toBeNull();
        });
      } finally {
        Reflect.deleteProperty(document, "hidden");
      }
      expect(mounted.focusLost).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops when the turn ends and hands focus back", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      mounted.api().setTimelineState({ isWorking: false });
      await vi.waitFor(() => {
        expect(stage(host)).toBeNull();
        expect(mounted.focusLost).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops when reduced motion turns on", async () => {
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      reducedMotionStore.set(true);
      await vi.waitFor(() => {
        expect(stage(host)).toBeNull();
        expect(grabButton(host)).toBeNull();
        expect(plainLabel(host)).not.toBeNull();
        expect(mounted.focusLost).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops on a thread switch and starts inactive after remounting", async () => {
    const mounted = await mountWorkingTimeline({
      threadId: ThreadId.makeUnsafe("ribbon-thread-a"),
    });
    const { host } = mounted;
    try {
      await grab(host);
      mounted.api().setThreadId(ThreadId.makeUnsafe("ribbon-thread-b"));
      await vi.waitFor(() => {
        expect(stage(host)).toBeNull();
        expect(grabButton(host)).not.toBeNull();
      });
      await nextFrames(2);
      expect(stage(host)).toBeNull();
      expect(getComputedStyle(grabButton(host)!).visibility).toBe("visible");
    } finally {
      await mounted.cleanup();
    }
  });

  function trackRibbonFrames() {
    const pendingFrames = new Set<number>();
    let tickCount = 0;
    let maxPendingFrames = 0;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const originalCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      if (callback.name !== "tick") return originalRequestAnimationFrame(callback);
      const frame = originalRequestAnimationFrame((now) => {
        pendingFrames.delete(frame);
        tickCount += 1;
        callback(now);
      });
      pendingFrames.add(frame);
      maxPendingFrames = Math.max(maxPendingFrames, pendingFrames.size);
      return frame;
    });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      pendingFrames.delete(frame);
      originalCancelAnimationFrame(frame);
    });
    return {
      tickCount: () => tickCount,
      pendingCount: () => pendingFrames.size,
      maxPendingCount: () => maxPendingFrames,
      cancelSpy,
    };
  }

  it("tears down its loop and observers on release", async () => {
    const { tickCount, pendingCount, cancelSpy } = trackRibbonFrames();
    const resizeDisconnectSpy = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const mutationDisconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const mounted = await mountWorkingTimeline();
    const { host } = mounted;
    try {
      await grab(host);
      await vi.waitFor(() => {
        expect(tickCount()).toBeGreaterThan(3);
      });
      cancelSpy.mockClear();
      resizeDisconnectSpy.mockClear();
      mutationDisconnectSpy.mockClear();

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(stage(host)).toBeNull();
      });
      expect(cancelSpy).toHaveBeenCalled();
      expect(resizeDisconnectSpy).toHaveBeenCalled();
      expect(mutationDisconnectSpy).toHaveBeenCalled();
      expect(pendingCount()).toBe(0);
      const ticksAtRelease = tickCount();
      await nextFrames(5);
      expect(tickCount()).toBe(ticksAtRelease);
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs a single loop under Strict Mode", async () => {
    const { tickCount, pendingCount, maxPendingCount } = trackRibbonFrames();
    const mounted = await mountWorkingTimeline({ strict: true });
    const { host } = mounted;
    try {
      await grab(host);
      await nextFrames(8);
      expect(tickCount()).toBeGreaterThan(3);
      // Count outstanding requests, independent of browser frame timestamps.
      expect(maxPendingCount()).toBe(1);
      expect(pendingCount()).toBe(1);
      expect(document.activeElement).toBe(stage(host));
      expect(mounted.focusLost).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});

describe("MessagesTimeline row stability", () => {
  const EMPTY_CHAT_DIFF_CONTEXT = {
    threadId: null,
    isGitRepo: false,
    inferredCheckpointTurnCountByTurnId: {},
    expandedFileChangeDiffs: {},
    fileChangeSummariesById: {},
    onToggleFileChangeDiff: () => {},
    onOpenFileChangeDiff: () => {},
  };

  function externalsInputs(
    overrides: Partial<TimelineRowExternalsInputs> = {},
  ): TimelineRowExternalsInputs {
    return {
      threadId: null,
      expandedWorkGroups: {},
      workGroupCollapseOverrides: {},
      turnDiffSummaryByTurnId: new Map(),
      chatDiffContext: EMPTY_CHAT_DIFF_CONTEXT,
      revertTurnCountByUserMessageId: new Map(),
      revertPopover: null,
      revertImpact: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      changedFilesPresentationOverrides: {},
      newestTurnDiffId: null,
      expandedCommandExecutions: {},
      ribbonActive: false,
      ...overrides,
    };
  }

  function buildRows(entries: TimelineEntry[], cache: ReturnType<typeof createTimelineRowCache>) {
    return buildTimelineRows({
      timelineEntries: entries,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
      activeTurnStartedAt: null,
      liveActivity: null,
      expandMcpToolCalls: false,
      cache,
    });
  }

  function withTurnId(entry: TimelineEntry, turnId: TurnId): TimelineEntry {
    if (entry.kind !== "work") throw new Error("expected a work entry");
    return { ...entry, entry: { ...entry.entry, turnId } };
  }

  it("keeps earlier row objects and versions when the last message streams", () => {
    const cache = createTimelineRowCache();
    const user = makeUserEntry("row-user", "hello", 0);
    const work = makeReadWorkEntry("row-work", "src/a.ts", 1);
    const assistant = makeAssistantEntry("row-assistant", "Hel", 2);
    const before = buildRows([user, work, assistant], cache);
    const externalsBefore = buildTimelineRowExternals(before, externalsInputs(), new Map());

    const grown = makeAssistantEntry("row-assistant", "Hello there", 2);
    const after = buildRows([user, work, grown], cache);
    const externalsAfter = buildTimelineRowExternals(after, externalsInputs(), externalsBefore);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(externalsAfter.get("row-user")).toBe(externalsBefore.get("row-user"));
    expect(externalsAfter.get("row-work")).toBe(externalsBefore.get("row-work"));
    // Rebuilding the same entries returns the same array.
    expect(buildRows([user, work, grown], cache)).toBe(after);
  });

  it("changes only the rows of the turn whose diff summary changed", () => {
    const cache = createTimelineRowCache();
    const turnA = TurnId.makeUnsafe("turn-a");
    const turnB = TurnId.makeUnsafe("turn-b");
    const rows = buildRows(
      [
        withTurnId(makeReadWorkEntry("work-a", "src/a.ts", 0), turnA),
        makeUserEntry("user-between", "next", 1),
        withTurnId(makeReadWorkEntry("work-b", "src/b.ts", 2), turnB),
      ],
      cache,
    );
    const summaryA = { turnId: turnA, completedAt: "2026-03-04T12:00:00.000Z", files: [] };
    const externalsBefore = buildTimelineRowExternals(
      rows,
      externalsInputs({
        turnDiffSummaryByTurnId: new Map([[turnA, summaryA as unknown as TurnDiffSummary]]),
      }),
      new Map(),
    );
    const nextSummaryA = { ...summaryA, checkpointTurnCount: 2 };
    const externalsAfter = buildTimelineRowExternals(
      rows,
      externalsInputs({
        turnDiffSummaryByTurnId: new Map([[turnA, nextSummaryA as unknown as TurnDiffSummary]]),
      }),
      externalsBefore,
    );

    expect(externalsAfter.get("work-a")?.version).not.toBe(externalsBefore.get("work-a")?.version);
    expect(externalsAfter.get("work-b")).toBe(externalsBefore.get("work-b"));
    expect(externalsAfter.get("user-between")).toBe(externalsBefore.get("user-between"));
  });

  it("keeps an earlier work group open while a subagent in it is still running", () => {
    const agent = (status: string): TimelineEntry => {
      const base = makeReadWorkEntry("agent-work", "src/a.ts", 1);
      if (base.kind !== "work") throw new Error("expected a work entry");
      return {
        ...base,
        entry: { ...base.entry, label: "Agent", subagentType: "Explore", status },
      } as TimelineEntry;
    };
    const rows = (status: string) =>
      buildRows(
        [
          makeUserEntry("agent-user", "first", 0),
          agent(status),
          makeUserEntry("agent-steer", "also check b", 2),
        ],
        createTimelineRowCache(),
      ).find((row) => row.id === "agent-work");
    expect(rows("inProgress")).toMatchObject({ kind: "work", isPriorTurn: false });
    expect(rows("completed")).toMatchObject({ kind: "work", isPriorTurn: true });
  });

  it("prunes cached rows that a rewind removed", () => {
    const cache = createTimelineRowCache();
    const user = makeUserEntry("rewind-user", "first", 0);
    const assistant = makeAssistantEntry("rewind-assistant", "reply", 1);
    const later = makeUserEntry("rewind-later", "second", 2);
    buildRows([user, assistant, later], cache);
    expect([...cache.rows.keys()]).toEqual(["rewind-user", "rewind-assistant", "rewind-later"]);

    const rewound = buildRows([user, assistant], cache);
    expect(rewound.map((row) => row.id)).toEqual(["rewind-user", "rewind-assistant"]);
    expect([...cache.rows.keys()]).toEqual(["rewind-user", "rewind-assistant"]);
  });

  it("re-renders only the streaming row and keeps earlier rows untouched", async () => {
    let api: TimelineHarnessApi | null = null;
    const user = makeUserEntry("render-user", "Question", 0);
    const firstAnswer = makeAssistantEntry("render-first", "First answer", 1);
    const followUp = makeUserEntry("render-follow-up", "Follow up", 2);
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <TimelineHarness
        initialEntries={[user, firstAnswer, followUp, makeAssistantEntry("render-live", "Str", 3)]}
        onIsAtEndChangeSpy={() => {}}
        setApi={(next) => {
          api = next;
        }}
      />,
      { container: host },
    );
    const renderCount = (rowId: string) =>
      host.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"][data-render-count]`)
        ?.dataset.renderCount;

    try {
      await vi.waitFor(() => {
        expect(renderCount("render-first")).toBeDefined();
        expect(renderCount("render-live")).toBeDefined();
      });
      const before = {
        user: renderCount("render-user"),
        first: renderCount("render-first"),
        followUp: renderCount("render-follow-up"),
        live: renderCount("render-live"),
      };

      for (const text of ["Strea", "Streami", "Streaming reply"]) {
        api!.setEntries([user, firstAnswer, followUp, makeAssistantEntry("render-live", text, 3)]);
        await vi.waitFor(() => {
          expect(host.textContent).toContain(text);
        });
      }

      expect(renderCount("render-user")).toBe(before.user);
      expect(renderCount("render-first")).toBe(before.first);
      expect(renderCount("render-follow-up")).toBe(before.followUp);
      expect(Number(renderCount("render-live"))).toBeGreaterThan(Number(before.live));
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders a fallback for a malformed entry while other rows render", async () => {
    const malformed = makeUserEntry("malformed-user", "broken", 1);
    if (malformed.kind === "message") {
      // A non-array attachment list makes the user row throw while rendering.
      (malformed.message as { attachments: unknown }).attachments = 42;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const screen = await render(
      <TimelineHarness
        initialEntries={[
          makeUserEntry("healthy-user", "Healthy question", 0),
          malformed,
          makeAssistantEntry("healthy-assistant", "Healthy answer", 2),
        ]}
        onIsAtEndChangeSpy={() => {}}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        const brokenRow = host.querySelector('[data-timeline-row-id="malformed-user"]');
        expect(brokenRow?.textContent).toContain("This entry could not be displayed");
        expect(brokenRow?.textContent).toContain("Copy error report");
        expect(host.textContent).toContain("Healthy question");
        expect(host.textContent).toContain("Healthy answer");
      });
    } finally {
      consoleError.mockRestore();
      await screen.unmount();
      host.remove();
    }
  });
});
