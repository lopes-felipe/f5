import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TimelineAnchorUnavailableError } from "../../lib/orchestrationReactQuery";
import {
  TimelineHarness,
  makeAssistantEntry,
  makeUserEntry,
  waitForTimelineLayout,
  type HarnessProps,
  type TimelineEntry,
  type TimelineHarnessApi,
} from "../../test/timeline";
import {
  ConversationNavigation,
  createConversationNavigationStore,
} from "./ConversationNavigation";

const conversation = (turns: number, prefix = "turn", startSeconds = 100): TimelineEntry[] =>
  Array.from({ length: turns }, (_, index) => [
    makeUserEntry(
      `${prefix}-user-${index}`,
      `${prefix} question ${index}`,
      startSeconds + index * 2,
    ),
    makeAssistantEntry(
      `${prefix}-assistant-${index}`,
      `${prefix} answer ${index}\n\n${"Some detail. ".repeat(30)}`,
      startSeconds + index * 2 + 1,
    ),
  ]).flat();

async function renderHarness(
  props: Omit<HarnessProps, "onIsAtEndChangeSpy"> & {
    navigation: NonNullable<HarnessProps["navigation"]>;
  },
) {
  let api: TimelineHarnessApi | null = null;
  const host = document.body.appendChild(document.createElement("div"));
  const screen = await render(
    <TimelineHarness
      initialHeight={500}
      {...props}
      onIsAtEndChangeSpy={() => {}}
      setApi={(next) => {
        api = next;
      }}
    />,
    { container: host },
  );
  const scroller = () => host.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]');
  await waitForTimelineLayout(scroller);
  return { host, screen, api: () => api!, scroller: () => scroller()! };
}

/** The row's top edge relative to the viewport, or null when it is not rendered. */
function rowOffset(host: HTMLElement, rowId: string): number | null {
  const scroller = host.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]');
  const row = host.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`);
  if (!scroller || !row) return null;
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

function isRowInView(host: HTMLElement, rowId: string) {
  const offset = rowOffset(host, rowId);
  const scroller = host.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]');
  return offset !== null && scroller !== null && offset >= -1 && offset < scroller.clientHeight;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useTimelineNavigation", () => {
  it("lands on a loaded target every time it is chosen, even the same one twice", async () => {
    const loadAround = vi.fn(() => Promise.resolve());
    const { host, screen, api } = await renderHarness({
      initialEntries: conversation(30),
      navigation: { loadAround },
    });
    try {
      expect(isRowInView(host, "turn-user-2")).toBe(false);
      api().navigate("turn-user-2", { position: 0.1 });
      await vi.waitFor(() => expect(isRowInView(host, "turn-user-2")).toBe(true));
      api().jumpToLatest();
      await vi.waitFor(() => expect(isRowInView(host, "turn-user-2")).toBe(false));
      api().navigate("turn-user-2", { position: 0.1 });
      await vi.waitFor(() => expect(isRowInView(host, "turn-user-2")).toBe(true));
      expect(loadAround).not.toHaveBeenCalled();
      expect(api().navigationStatus()).toBe("idle");
    } finally {
      await screen.unmount();
    }
  });

  it("loads an absent target once and lands after the row map commits", async () => {
    const older = conversation(3, "older", 0);
    const newer = conversation(20);
    let api: () => TimelineHarnessApi = () => {
      throw new Error("not ready");
    };
    const loadAround = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      api().setEntries([...older, ...newer]);
    });
    const rendered = await renderHarness({ initialEntries: newer, navigation: { loadAround } });
    api = rendered.api;
    try {
      api().navigate("older-user-1");
      await vi.waitFor(() => expect(isRowInView(rendered.host, "older-user-1")).toBe(true));
      expect(api().navigationStatus()).toBe("idle");
      expect(loadAround).toHaveBeenCalledTimes(1);
      expect(loadAround).toHaveBeenCalledWith("older-user-1", "message", expect.any(AbortSignal));
    } finally {
      await rendered.screen.unmount();
    }
  });

  it("reports a target that no longer exists as unavailable", async () => {
    const { screen, api } = await renderHarness({
      initialEntries: conversation(4),
      navigation: { loadAround: () => Promise.reject(new TimelineAnchorUnavailableError()) },
    });
    try {
      api().navigate("reverted-message");
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("unavailable"));
    } finally {
      await screen.unmount();
    }
  });

  it("offers a retry after a transport failure", async () => {
    const older = conversation(2, "older", 0);
    const newer = conversation(20);
    let api: () => TimelineHarnessApi = () => {
      throw new Error("not ready");
    };
    const loadAround = vi
      .fn<(entryId: string, kind: string, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockImplementation(async () => {
        api().setEntries([...older, ...newer]);
      });
    const rendered = await renderHarness({ initialEntries: newer, navigation: { loadAround } });
    api = rendered.api;
    try {
      api().navigate("older-user-0");
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("failed"));
      api().retryNavigation();
      await vi.waitFor(() => expect(isRowInView(rendered.host, "older-user-0")).toBe(true));
      expect(api().navigationStatus()).toBe("idle");
      expect(loadAround).toHaveBeenCalledTimes(2);
    } finally {
      await rendered.screen.unmount();
    }
  });

  it("places a find match deep in a long message after a retried load", async () => {
    const longAnswer = makeAssistantEntry(
      "older-long",
      `${"Filler paragraph.\n\n".repeat(80)}The retried needle.\n\n${"Tail.\n\n".repeat(10)}`,
      1,
    );
    const newer = conversation(15);
    let api: () => TimelineHarnessApi = () => {
      throw new Error("not ready");
    };
    const loadAround = vi
      .fn<(entryId: string, kind: string, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockImplementation(async () => {
        api().setEntries([makeUserEntry("older-question", "Q", 0), longAnswer, ...newer]);
      });
    const rendered = await renderHarness({ initialEntries: newer, navigation: { loadAround } });
    api = rendered.api;
    try {
      api().navigateToFind({ entryId: "older-long", query: "retried needle", occurrence: 0 });
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("failed"));
      api().retryNavigation();
      await vi.waitFor(() => {
        const range = [...(CSS.highlights.get("f5-thread-find-active") ?? [])][0] as
          | Range
          | undefined;
        expect(range?.toString()).toBe("retried needle");
        const top =
          range!.getBoundingClientRect().top - rendered.scroller().getBoundingClientRect().top;
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThan(rendered.scroller().clientHeight * 0.5);
      });
    } finally {
      await rendered.screen.unmount();
    }
  });

  it("drops a slow load once its find request is cancelled, leaving newer jumps alone", async () => {
    const older = conversation(2, "older", 0);
    const newer = conversation(20);
    let resolveLoad!: () => void;
    let api: () => TimelineHarnessApi = () => {
      throw new Error("not ready");
    };
    const loadAround = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = () => {
            api().setEntries([...older, ...newer]);
            resolve();
          };
        }),
    );
    const rendered = await renderHarness({ initialEntries: newer, navigation: { loadAround } });
    api = rendered.api;
    try {
      const findRequest = api().navigate("older-user-0", { placeRange: true });
      await vi.waitFor(() => expect(loadAround).toHaveBeenCalledTimes(1));
      // The find bar closes (or its query changes) before history arrives.
      api().cancelNavigationRequest(findRequest);
      resolveLoad();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isRowInView(rendered.host, "older-user-0")).toBe(false);
      expect(api().navigationStatus()).toBe("idle");

      const railJump = api().navigate("turn-user-3", { position: 0.1 });
      api().cancelNavigationRequest(railJump - 1);
      await vi.waitFor(() => expect(isRowInView(rendered.host, "turn-user-3")).toBe(true));
    } finally {
      await rendered.screen.unmount();
    }
  });

  it("clears a failed find jump when its request is withdrawn, so Retry does nothing", async () => {
    const loadAround = vi.fn(() => Promise.reject(new Error("socket closed")));
    const { screen, api } = await renderHarness({
      initialEntries: conversation(10),
      navigation: { loadAround },
    });
    try {
      const findRequest = api().navigate("missing-find-target", { placeRange: true });
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("failed"));
      // Closing find (or changing its query) withdraws the request.
      api().cancelNavigationRequest(findRequest);
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("idle"));
      api().retryNavigation();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(loadAround).toHaveBeenCalledTimes(1);
      expect(api().navigationStatus()).toBe("idle");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a jump that landed through another load when its own load later fails", async () => {
    const older = conversation(2, "older", 0);
    const newer = conversation(20);
    let rejectLoad!: (error: Error) => void;
    let loadSignal: AbortSignal | null = null;
    const loadAround = vi.fn(
      (_entryId: string, _kind: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          loadSignal = signal;
          rejectLoad = reject;
        }),
    );
    const rendered = await renderHarness({ initialEntries: newer, navigation: { loadAround } });
    try {
      rendered.api().navigate("older-user-0");
      await vi.waitFor(() => expect(loadAround).toHaveBeenCalledTimes(1));
      // An older-history backfill commits the target first.
      rendered.api().setEntries([...older, ...newer]);
      await vi.waitFor(() => expect(isRowInView(rendered.host, "older-user-0")).toBe(true));
      await vi.waitFor(() => expect(rendered.api().navigationStatus()).toBe("idle"));
      // The placed jump abandons its now-redundant load...
      await vi.waitFor(() => expect(loadSignal?.aborted).toBe(true));
      // ...and that load's late failure is not reported.
      rejectLoad(new Error("socket closed"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rendered.api().navigationStatus()).toBe("idle");
      expect(isRowInView(rendered.host, "older-user-0")).toBe(true);
    } finally {
      await rendered.screen.unmount();
    }
  });

  it("goes straight to a match inside an already rendered long message", async () => {
    const long = makeAssistantEntry(
      "long-answer",
      `First needle.\n\n${"Filler paragraph.\n\n".repeat(80)}Second needle.\n\n${"Tail.\n\n".repeat(5)}`,
      200,
    );
    const { screen, api, scroller } = await renderHarness({
      initialEntries: [...conversation(3), long],
      navigation: { loadAround: () => Promise.resolve() },
    });
    const activeTop = () => {
      const range = [...(CSS.highlights.get("f5-thread-find-active") ?? [])][0] as
        | Range
        | undefined;
      return range
        ? range.getBoundingClientRect().top - scroller().getBoundingClientRect().top
        : null;
    };
    try {
      api().navigateToFind({ entryId: "long-answer", query: "needle", occurrence: 0 });
      await vi.waitFor(() => {
        expect(activeTop()).not.toBeNull();
        expect(activeTop()!).toBeGreaterThanOrEqual(0);
        expect(activeTop()!).toBeLessThan(scroller().clientHeight * 0.5);
      });
      // Next within the same row: no snap back to the row's top on the way.
      const tops: number[] = [];
      const onScroll = () => tops.push(scroller().scrollTop);
      scroller().addEventListener("scroll", onScroll);
      const before = scroller().scrollTop;
      api().navigateToFind({ entryId: "long-answer", query: "needle", occurrence: 1 });
      await vi.waitFor(() => {
        const range = [...(CSS.highlights.get("f5-thread-find-active") ?? [])][0] as Range;
        expect(range.startContainer.textContent).toContain("Second needle");
        expect(activeTop()!).toBeGreaterThanOrEqual(0);
        expect(activeTop()!).toBeLessThan(scroller().clientHeight * 0.5);
      });
      scroller().removeEventListener("scroll", onScroll);
      expect(tops.every((top) => top >= before - 1)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("cancels a pending jump on manual scrolling and on a thread change", async () => {
    const signals: AbortSignal[] = [];
    const loadAround = vi.fn(
      (_entryId: string, _kind: string, signal: AbortSignal) =>
        new Promise<void>(() => {
          signals.push(signal);
        }),
    );
    const { screen, api, scroller } = await renderHarness({
      threadId: ThreadId.makeUnsafe("thread-nav-a"),
      initialEntries: conversation(10),
      navigation: { loadAround },
    });
    try {
      api().navigate("missing-1");
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("loading"));
      scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
      await vi.waitFor(() => expect(api().navigationStatus()).toBe("idle"));
      expect(signals[0]?.aborted).toBe(true);

      api().navigate("missing-2");
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      api().setThreadId(ThreadId.makeUnsafe("thread-nav-b"));
      await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
      expect(api().navigationStatus()).toBe("idle");
    } finally {
      await screen.unmount();
    }
  });

  it("places a find match once and never pulls the view back on later updates", async () => {
    const entries = conversation(12);
    const target = makeAssistantEntry(
      "find-target",
      `${"Filler line.\n\n".repeat(40)}The needle is here.\n\n${"More filler.\n\n".repeat(20)}`,
      10,
    );
    const withTarget = [...entries.slice(0, 4), target, ...entries.slice(4)];
    const { host, screen, api, scroller } = await renderHarness({
      initialEntries: withTarget,
      navigation: { loadAround: () => Promise.resolve() },
    });
    const activeRangeTop = () => {
      const range = [...(CSS.highlights.get("f5-thread-find-active") ?? [])][0] as
        | Range
        | undefined;
      return range
        ? range.getBoundingClientRect().top - scroller().getBoundingClientRect().top
        : null;
    };
    try {
      api().navigateToFind({ entryId: "find-target", query: "needle", occurrence: 0 });
      await vi.waitFor(() => {
        const top = activeRangeTop();
        expect(top).not.toBeNull();
        expect(top!).toBeGreaterThanOrEqual(0);
        expect(top!).toBeLessThan(scroller().clientHeight * 0.5);
      });

      // The reader scrolls away; a stream update to the matched row only refreshes highlights.
      scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true }));
      scroller().scrollTop += 600;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settledMatchTop = activeRangeTop()!;
      api().setEntries([
        ...entries.slice(0, 4),
        makeAssistantEntry(
          "find-target",
          `${(target as { message: { text: string } }).message.text}\n\nStreamed tail.`,
          10,
        ),
        ...entries.slice(4),
      ]);
      await vi.waitFor(() => expect(host.textContent).toContain("Streamed tail."));
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The highlight is refreshed in place; the view is not pulled back to the
      // match (the list may still re-anchor by the size of the streamed text).
      expect(settledMatchTop).toBeLessThan(-200);
      expect(activeRangeTop()!).toBeLessThanOrEqual(settledMatchTop + 2);
      expect(CSS.highlights.has("f5-thread-find-active")).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
});

describe("Conversation navigation", () => {
  it("does not subscribe while closed and lists turns once opened", async () => {
    const store = createConversationNavigationStore();
    store.publish({
      items: [
        {
          id: "u1",
          rowIndex: 0,
          createdAt: "2026-03-04T12:00:00.000Z",
          userText: "First <b>prompt</b>",
          assistantText: "**Bold** answer",
        },
        { id: "u2", rowIndex: 2, createdAt: null, userText: "Second prompt", assistantText: null },
      ],
      activeIndex: 1,
      hasOlderHistory: true,
      isLoadingOlderHistory: false,
      hasHistoryLoadError: false,
    });
    const onSelectTurn = vi.fn();
    const onOpenFind = vi.fn();
    const screen = await render(
      <ConversationNavigation
        store={store}
        disabled={false}
        timestampFormat="24-hour"
        onSelectTurn={onSelectTurn}
        onOpenFind={onOpenFind}
        onLoadOlderHistory={() => {}}
      />,
    );
    try {
      expect(store.subscriberCount()).toBe(0);
      await page.getByRole("button", { name: "Conversation navigation" }).click();
      await vi.waitFor(() => expect(store.subscriberCount()).toBe(1));
      // Previews are plain text, never Markdown or HTML.
      await expect.element(page.getByText("First <b>prompt</b>")).toBeVisible();
      await expect.element(page.getByText("**Bold** answer")).toBeVisible();
      await expect.element(page.getByText(/Loaded turns only/)).toBeVisible();
      expect(
        document.querySelector('[data-slot="conversation-navigation"] [aria-current="true"]')
          ?.textContent,
      ).toContain("Second prompt");
      await page.getByRole("button", { name: /First <b>prompt<\/b>/ }).click();
      expect(onSelectTurn).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
      await vi.waitFor(() => expect(store.subscriberCount()).toBe(0));
    } finally {
      await screen.unmount();
    }
  });

  it("is disabled for an empty conversation", async () => {
    const screen = await render(
      <ConversationNavigation
        store={createConversationNavigationStore()}
        disabled
        timestampFormat="24-hour"
        onSelectTurn={() => {}}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Conversation navigation" }))
        .toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("jumps to a chosen turn from the timeline's header control", async () => {
    const onOpenThreadFind = vi.fn();
    const { host, screen } = await renderHarness({
      initialEntries: conversation(25),
      navigation: { loadAround: () => Promise.resolve(), onOpenThreadFind },
    });
    try {
      const trigger = page.getByRole("button", { name: "Conversation navigation" });
      await expect.element(trigger).toBeEnabled();
      expect(
        host
          .querySelector('[data-testid="harness-navigation-host"] button')
          ?.getAttribute("aria-label"),
      ).toBe("Conversation navigation");
      await trigger.click();
      await page.getByRole("button", { name: /turn question 1\b/ }).click();
      await vi.waitFor(() => expect(isRowInView(host, "turn-user-1")).toBe(true));

      await trigger.click();
      await page.getByRole("button", { name: "Find in thread" }).click();
      expect(onOpenThreadFind).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
