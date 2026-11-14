import { render } from "vitest-browser-react";
import type { LegendListRef } from "@legendapp/list/react";
import {
  TimelineHarness,
  makeUserEntry,
  makeAssistantEntry,
  waitForTimelineLayout,
  type TimelineHarnessApi,
  type TimelineEntry,
} from "../test/timeline";
import {
  readTimelineScrollAnchor,
  preserveTimelineAnchorDuringHistoryLoad,
} from "./chat/timelineScrollAnchors";
import "../index.css";
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountConnectionSurface } from "../test/connectionSurface";
import {
  resetComposerDraftBaseStorageForTesting,
  useComposerDraftStore,
} from "../composerDraftStore";
import { resetProtocolStateForTests } from "../protocolState";
import { useStore } from "../store";
import { createOrchestrationEventRouter } from "../orchestration/eventRouter";
import { WEB_LOCAL_FLAG_KEYS } from "../webLocalFlags";
import {
  noteWsConnectionClosed,
  noteWsConnectionOpened,
  noteWsResynchronizing,
  noteWsSynchronized,
  noteWsSynchronizationError,
  resetWsConnectionStateForTests,
} from "../wsConnectionState";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => null,
}));
const threadId = ThreadId.makeUnsafe("degraded-draft");
function Draft() {
  const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
  return (
    <textarea
      aria-label="Draft"
      value={prompt}
      onChange={(event) => useComposerDraftStore.getState().setPrompt(threadId, event.target.value)}
    />
  );
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WEB_LOCAL_FLAG_KEYS.wsDisconnectSurfaceEnabled, "true");
  resetComposerDraftBaseStorageForTesting();
  useComposerDraftStore.setState({ draftsByThreadId: {}, imageImportsByThreadId: {} });
  resetProtocolStateForTests();
  resetWsConnectionStateForTests();
  noteWsConnectionOpened();
  noteWsSynchronized();
  useComposerDraftStore.getState().setPrompt(threadId, "unfinished prompt");
});
afterEach(() => {
  resetComposerDraftBaseStorageForTesting();
  resetProtocolStateForTests();
  resetWsConnectionStateForTests();
  vi.restoreAllMocks();
});

it.each(["reconnecting", "resynchronizing", "backend replacement"])(
  "preserves draft editing and focus through %s and recovery",
  async (phase) => {
    const mounted = await mountConnectionSurface(<Draft />);
    try {
      const editor = mounted.host.querySelector("textarea")!;
      editor.focus();
      if (phase === "reconnecting") noteWsConnectionClosed();
      else {
        if (phase === "backend replacement")
          useStore.getState().resetBackendState("replacement-with-lower-head");
        noteWsResynchronizing();
      }
      await vi.waitFor(() =>
        expect(document.querySelector('[role="status"]')?.textContent).toContain(
          phase === "reconnecting" ? "Reconnecting" : "Resynchronizing",
        ),
      );
      expect(document.activeElement).toBe(editor);
      await page.getByRole("textbox", { name: "Draft" }).fill("unfinished prompt, still editable");
      noteWsConnectionOpened();
      noteWsSynchronized();
      await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
      expect(mounted.host.querySelector("textarea")).toBe(editor);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
        "unfinished prompt, still editable",
      );
      expect(document.activeElement).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  },
);

it("shows the actual poison breaker with a reload action while retaining the editable draft", async () => {
  let head = 0;
  const router = createOrchestrationEventRouter({
    api: {
      readSnapshot: async () => ({
        sequence: head,
        provisional: false,
        merge: () => {},
        finish: async () => {},
      }),
    },
    scheduler: {
      raf: (callback) => requestAnimationFrame(callback),
      cancelRaf: (id) => window.cancelAnimationFrame(id),
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      queueMicrotask: (callback) => window.queueMicrotask(callback),
    },
    now: performance.now.bind(performance),
    actions: {
      applyBatch: () => {
        throw new Error("injected reducer failure");
      },
      applyEvent: () => {},
      onGap: () => {},
      onResynchronizing: noteWsResynchronizing,
      onSynchronized: noteWsSynchronized,
      onRecoveryError: noteWsSynchronizationError,
      repairThreads: () => {},
      logPoison: () => {},
    },
  });
  const mounted = await mountConnectionSurface(<Draft />);
  try {
    await router.syncSnapshot();
    const editor = mounted.host.querySelector("textarea")!;
    editor.focus();
    for (head = 1; head <= 3; head++) {
      router.receive({
        sequence: head,
        type: "thread.meta-updated",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: { threadId, title: "poison" },
      } as OrchestrationEvent);
      router.flushPending();
      if (head < 3) await vi.waitFor(() => expect(router.committedSequence).toBe(head));
    }
    await vi.waitFor(() => expect(document.body.textContent).toContain("Reload"));
    expect(router.breakerOpen).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Reload");
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("unfinished prompt");
  } finally {
    router.dispose();
    await mounted.cleanup();
  }
});

it("keeps long recovery errors scrollable while the draft remains reachable by keyboard", async () => {
  const mounted = await mountConnectionSurface(<Draft />);
  try {
    noteWsSynchronizationError("Recovery failed. ".repeat(1_000));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')).not.toBeNull());
    const status = document.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.8 + 1);
    expect(status.scrollHeight).toBeGreaterThan(status.clientHeight);
    const editor = mounted.host.querySelector("textarea")!;
    editor.focus();
    await page.getByRole("textbox", { name: "Draft" }).fill("draft survives long errors");
    expect(document.activeElement).toBe(editor);
    expect(editor.closest("[inert]")).toBeNull();
  } finally {
    await mounted.cleanup();
  }
});

it.each([1200, 420])(
  "keeps a 2,000-message thread usable through streaming and history at %ipx",
  async (width) => {
    await page.viewport(width, 860);
    const host = document.createElement("div");
    document.body.append(host);
    let api: TimelineHarnessApi | null = null;
    let list: LegendListRef | null = null;
    let isAtEnd = false;
    let entries: TimelineEntry[] = Array.from({ length: 2000 }, (_, index) =>
      index % 2 === 0
        ? makeUserEntry(`large-user-${index}`, `Question ${index}`, index)
        : makeAssistantEntry(
            `large-assistant-${index}`,
            `Answer ${index} with enough text to wrap on narrow windows.`,
            index,
          ),
    );
    const mounted = await render(
      <TimelineHarness
        threadId={ThreadId.makeUnsafe(`degraded-large-${width}`)}
        initialEntries={entries}
        initialHeight={420}
        onIsAtEndChangeSpy={(value) => {
          isAtEnd = value;
        }}
        onListRefChange={(ref) => {
          list = ref;
        }}
        setApi={(value) => {
          api = value;
        }}
      />,
      { container: host },
    );
    try {
      const container = host.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]')!;
      const distance = () => container.scrollHeight - container.clientHeight - container.scrollTop;
      await expect.poll(() => distance()).toBeLessThan(8);
      await expect
        .poll(() => host.querySelector('[data-message-id="large-assistant-1999"]'))
        .not.toBeNull();
      const tail = entries.at(-1)!;
      if (tail.kind !== "message") throw new Error("Expected a message tail");
      entries = [
        ...entries.slice(0, -1),
        {
          ...tail,
          message: {
            ...tail.message,
            text: tail.message.text + " streamed suffix",
            streaming: true,
          },
        },
      ];
      api!.setEntries(entries);
      await expect.poll(() => distance()).toBeLessThan(8);
      await expect.poll(() => host.textContent!.includes("streamed suffix")).toBe(true);
      await list!.scrollToOffset({ offset: container.scrollHeight / 2, animated: false });
      container.dispatchEvent(new Event("scroll"));
      await expect.poll(() => isAtEnd).toBe(false);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const before = readTimelineScrollAnchor(container);
      const updated = entries.at(-1)!;
      if (updated.kind !== "message") throw new Error("Expected a message tail");
      entries = [
        ...entries.slice(0, -1),
        {
          ...updated,
          message: { ...updated.message, text: updated.message.text + " more output" },
        },
      ];
      api!.setEntries(entries);
      await expect.poll(() => isAtEnd).toBe(false);
      await expect.poll(() => distance()).toBeGreaterThan(container.clientHeight);
      entries = [
        ...Array.from({ length: 50 }, (_, index) =>
          makeUserEntry(`older-${index}`, `Earlier message ${index}`, index - 50),
        ),
        ...entries,
      ];
      api!.setEntries(entries);
      await expect
        .poll(() => {
          const after = readTimelineScrollAnchor(container);
          return after.rowId === before.rowId ? Math.abs(after.top - before.top) : Infinity;
        })
        .toBeLessThan(3);
      api!.followNewTurn([
        ...entries,
        makeUserEntry("new-submission", "Follow the submitted turn", 2001),
      ]);
      await expect.poll(() => distance()).toBeLessThan(8);
      await expect
        .poll(() => host.querySelector('[data-message-id="new-submission"]'))
        .not.toBeNull();
    } finally {
      await mounted.unmount();
      host.remove();
    }
  },
);

it.each(["restore", "pending layout", "wheel", "abort", "replacement", "tail"] as const)(
  "preserves a history-load anchor unless %s changes the reading intent",
  async (mode) => {
    const host = document.createElement("div");
    document.body.append(host);
    let api: TimelineHarnessApi | null = null;
    let list: LegendListRef | null = null;
    let entries: TimelineEntry[] = Array.from({ length: 80 }, (_, index) =>
      makeUserEntry(`anchor-${index}`, `Message ${index}`, index),
    );
    const mounted = await render(
      <TimelineHarness
        initialEntries={entries}
        initialHeight={420}
        onIsAtEndChangeSpy={() => {}}
        onListRefChange={(value) => {
          list = value;
        }}
        setApi={(value) => {
          api = value;
        }}
      />,
      { container: host },
    );
    try {
      const node = host.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]')!;
      await expect
        .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
        .toBeLessThan(8);
      await expect.poll(() => list).not.toBeNull();
      await expect.poll(() => host.querySelector('[data-message-id="anchor-79"]')).not.toBeNull();
      // Wait for measured end settling before setting up the history-reading
      // position; two frames can still overlap the initial end correction.
      await waitForTimelineLayout(() => node);
      await list!.scrollToOffset({ offset: 0, animated: false });
      node.dispatchEvent(new Event("scroll"));
      await expect.poll(() => readTimelineScrollAnchor(node).atEnd).toBe(false);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const before = readTimelineScrollAnchor(node);
      expect(before.atEnd).toBe(false);
      expect(before.rowId).not.toBeNull();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const currentList = list as LegendListRef | null;
      const scroll = vi.spyOn(currentList!, "scrollToIndex");
      let replaced = false;
      if (mode === "pending layout")
        vi.spyOn(node, "querySelectorAll").mockReturnValueOnce(
          [] as unknown as NodeListOf<Element>,
        );
      const loading = preserveTimelineAnchorDuringHistoryLoad({
        getList: () => (replaced ? null : currentList),
        getRowIndex: (id) => {
          const index = entries.findIndex((entry) => entry.id === id);
          return index < 0 ? undefined : index;
        },
        signal: controller.signal,
        load: async () => {
          await gate;
          entries = [
            ...Array.from({ length: 40 }, (_, index) =>
              makeUserEntry(`earlier-${index}`, `Earlier ${index}`, index - 40),
            ),
            ...entries,
          ];
          api!.setEntries(entries);
        },
      });
      if (mode === "wheel") node.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 }));
      else if (mode === "abort") controller.abort();
      else if (mode === "replacement") replaced = true;
      else if (mode === "tail") {
        await currentList!.scrollToEnd({ animated: false });
        await expect.poll(() => readTimelineScrollAnchor(node).atEnd).toBe(true);
        node.dispatchEvent(new Event("scroll"));
      }
      release();
      await loading;
      if (mode === "restore" || mode === "pending layout") {
        expect(scroll).toHaveBeenCalledTimes(1);

        await expect
          .poll(() => {
            const row = Array.from(
              node.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
            ).find((row) => row.dataset.timelineRowId === before.rowId);
            return row
              ? Math.abs(
                  row.getBoundingClientRect().top - node.getBoundingClientRect().top - before.top,
                )
              : Infinity;
          })
          .toBeLessThan(3);
      } else expect(scroll).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
      host.remove();
    }
  },
);

it("remembers tail navigation when a history prepend changes the scroll geometry", async () => {
  const node = document.createElement("div");
  node.style.cssText = "height:120px;width:320px;overflow:auto";
  const row = document.createElement("div");
  row.dataset.timelineRowId = "history-anchor";
  row.style.height = "400px";
  node.append(row);
  document.body.append(node);
  const scroll = vi.fn();
  const list = {
    getScrollableNode: () => node,
    scrollToIndex: scroll,
  } as unknown as LegendListRef;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    await gate;
    // The tail was reached while the request was pending. Prepending history
    // now makes a one-time check of the distance to the tail miss that intent.
    row.style.height = "800px";
  });
  const loading = preserveTimelineAnchorDuringHistoryLoad({
    getList: () => list,
    getRowIndex: () => 0,
    signal: new AbortController().signal,
    load,
  });
  try {
    expect(load).toHaveBeenCalledOnce();
    node.scrollTop = node.scrollHeight;
    expect(readTimelineScrollAnchor(node).atEnd).toBe(true);
    node.dispatchEvent(new Event("scroll"));
    release();
    await loading;
    expect(readTimelineScrollAnchor(node).atEnd).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    release();
    await loading;
    node.remove();
  }
});
