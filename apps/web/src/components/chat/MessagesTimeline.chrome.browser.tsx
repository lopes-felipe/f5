import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parsePersistedAppSettings } from "../../appSettings";
import { JumpToLatestButton } from "./JumpToLatestButton";
import type { TimelineTailSnapshot } from "./MessagesTimeline.logic";
import {
  TimelineHarness,
  makeAssistantEntry,
  makeUserEntry,
  type TimelineHarnessApi,
} from "../../test/timeline";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

function persistAppSettings(settings: Record<string, unknown> = {}) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...parsePersistedAppSettings(null), ...settings }),
  );
}

async function renderHarness(
  props: Omit<Parameters<typeof TimelineHarness>[0], "onIsAtEndChangeSpy" | "setApi">,
) {
  let api: TimelineHarnessApi | null = null;
  const host = document.body.appendChild(document.createElement("div"));
  const screen = await render(
    <TimelineHarness
      {...props}
      onIsAtEndChangeSpy={() => {}}
      setApi={(next) => {
        api = next;
      }}
    />,
    { container: host },
  );
  return { host, screen, api: () => api! };
}

const longCode = (lines: number) =>
  `\`\`\`ts\n${Array.from({ length: lines }, (_, index) => `const line${index} = ${index};`).join("\n")}\n\`\`\``;

beforeEach(() => {
  localStorage.clear();
  persistAppSettings();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("user message markup", () => {
  it("renders inline code when rich text is on and keeps the raw text when it is off", async () => {
    persistAppSettings({ composerRichTextEnabled: true });
    const text = "Run `bun run test` with **care**, not __init__";
    const { host, screen } = await renderHarness({
      initialEntries: [makeUserEntry("markup-user", text, 0)],
    });
    try {
      await vi.waitFor(() =>
        expect(host.querySelector("code.user-message-inline-code")?.textContent).toBe(
          "bun run test",
        ),
      );
      expect(host.querySelector('[data-message-id="markup-user"] strong')?.textContent).toBe(
        "care",
      );
      expect(host.textContent).toContain("__init__");
    } finally {
      await screen.unmount();
    }

    persistAppSettings({ composerRichTextEnabled: false });
    const plain = await renderHarness({ initialEntries: [makeUserEntry("plain-user", text, 0)] });
    try {
      await vi.waitFor(() =>
        expect(plain.host.querySelector('[data-message-id="plain-user"] pre')?.textContent).toBe(
          text,
        ),
      );
      expect(plain.host.querySelector("code.user-message-inline-code")).toBeNull();
    } finally {
      await plain.screen.unmount();
    }
  });

  it("shows a collapsed bubble as a prefix of the expanded one", async () => {
    persistAppSettings({ composerRichTextEnabled: true });
    const text = `Intro\n\`\`\`ts\n${Array.from({ length: 12 }, (_, index) => `code ${index}`).join("\n")}\n\`\`\`\nOutro`;
    const { host, screen } = await renderHarness({
      initialEntries: [makeUserEntry("prefix-user", text, 0)],
    });
    try {
      const bubbleText = () =>
        host.querySelector('[data-message-id="prefix-user"] [data-user-message-markup]')
          ?.textContent ?? "";
      await vi.waitFor(() => expect(bubbleText()).toContain("code 5"));
      const collapsed = bubbleText();
      expect(collapsed).not.toContain("code 11");
      expect(host.querySelector(".user-message-codeblock")).not.toBeNull();
      await page.getByRole("button", { name: "Show more" }).click();
      await vi.waitFor(() => expect(bubbleText()).toContain("Outro"));
      expect(bubbleText().startsWith(collapsed)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("expands a collapsed message while it holds the active find match", async () => {
    const tail = "FIND_TAIL";
    const { host, screen, api } = await renderHarness({
      initialEntries: [makeUserEntry("find-user", `${"a".repeat(620)} ${tail}`, 0)],
    });
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Show more"));
      expect(host.textContent).not.toContain(tail);
      api().setFind({ entryId: "find-user", query: tail, occurrence: 0 });
      await vi.waitFor(() => expect(host.textContent).toContain(tail));
      expect(host.textContent).not.toContain("Show less");
      expect(host.textContent).not.toContain("Show more");
      api().setFind(null);
      await vi.waitFor(() => expect(host.textContent).not.toContain(tail));
      expect(host.textContent).toContain("Show more");
    } finally {
      await screen.unmount();
    }
  });
});

describe("assistant message actions", () => {
  it("copies the raw text and quotes into the composer", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const onQuote = vi.fn();
    const raw = "## Result\n\nDone with `code`.";
    const { screen } = await renderHarness({
      initialEntries: [
        makeUserEntry("q-user", "Question", 0),
        makeAssistantEntry("q-assistant", raw, 1),
      ],
      onQuoteAssistantMessage: onQuote,
    });
    try {
      const assistant = page.getByRole("button", { name: "Copy message" }).last();
      await assistant.click();
      await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(raw));
      await page.getByRole("button", { name: "Message actions" }).click();
      await page.getByRole("menuitem", { name: "Quote in reply" }).click();
      expect(onQuote).toHaveBeenCalledWith("q-assistant", raw);
    } finally {
      await screen.unmount();
    }
  });

  it("never folds the latest assistant message and folds it once a newer one arrives", async () => {
    const first = makeAssistantEntry("fold-first", longCode(40), 1);
    const { host, screen, api } = await renderHarness({
      initialEntries: [makeUserEntry("fold-user", "Question", 0), first],
      initialHeight: 900,
    });
    const folded = (rowId: string) =>
      host.querySelector(`[data-timeline-row-id="${rowId}"] [data-folded="true"]`) !== null;
    try {
      await vi.waitFor(() =>
        expect(
          host.querySelector('[data-timeline-row-id="fold-first"] .chat-markdown-codeblock'),
        ).not.toBeNull(),
      );
      expect(folded("fold-first")).toBe(false);
      const codeBlock = host.querySelector(
        '[data-timeline-row-id="fold-first"] .chat-markdown-codeblock',
      );
      api().setEntries([
        makeUserEntry("fold-user", "Question", 0),
        first,
        makeUserEntry("fold-user-2", "Again", 2),
        makeAssistantEntry("fold-second", longCode(40), 3),
      ]);
      await vi.waitFor(() => expect(folded("fold-first")).toBe(true));
      expect(folded("fold-second")).toBe(false);
      // Folding flips a context value; the highlighted block is not remounted.
      expect(
        host.querySelector('[data-timeline-row-id="fold-first"] .chat-markdown-codeblock'),
      ).toBe(codeBlock);
    } finally {
      await screen.unmount();
    }
  });

  it("re-renders only the new row and the previous latest assistant row on append", async () => {
    const user = makeUserEntry("rc-user", "Question", 0);
    const older = makeAssistantEntry("rc-older", "Older answer", 1);
    const latest = makeAssistantEntry("rc-latest", "Latest answer", 2);
    const { host, screen, api } = await renderHarness({
      initialEntries: [user, older, latest],
      initialHeight: 900,
    });
    const renderCount = (rowId: string) =>
      host.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"][data-render-count]`)
        ?.dataset.renderCount;
    try {
      await vi.waitFor(() => expect(renderCount("rc-latest")).toBeDefined());
      const before = {
        user: renderCount("rc-user"),
        older: renderCount("rc-older"),
        latest: renderCount("rc-latest"),
      };
      api().setEntries([user, older, latest, makeAssistantEntry("rc-new", "New answer", 3)]);
      await vi.waitFor(() => expect(renderCount("rc-new")).toBeDefined());
      expect(renderCount("rc-user")).toBe(before.user);
      expect(renderCount("rc-older")).toBe(before.older);
      expect(Number(renderCount("rc-latest"))).toBeGreaterThan(Number(before.latest));
    } finally {
      await screen.unmount();
    }
  });
});

describe("row entrance", () => {
  const entering = (host: HTMLElement, rowId: string) =>
    host
      .querySelector(`[data-timeline-row-id="${rowId}"]`)
      ?.classList.contains("motion-safe:animate-rise") ?? false;

  it("animates a row appended during a turn, never mounted or prepended rows", async () => {
    const user = makeUserEntry("rise-user", "Question", 2);
    const { host, screen, api } = await renderHarness({
      initialEntries: [user],
      initialIsWorking: true,
      initialHeight: 900,
    });
    try {
      await vi.waitFor(() =>
        expect(host.querySelector('[data-timeline-row-id="rise-user"]')).not.toBeNull(),
      );
      expect(entering(host, "rise-user")).toBe(false);

      const answer = makeAssistantEntry("rise-answer", "Answer", 3);
      api().setEntries([user, answer]);
      await vi.waitFor(() => expect(entering(host, "rise-answer")).toBe(true));
      expect(entering(host, "rise-user")).toBe(false);

      api().setEntries([makeUserEntry("rise-older", "Older", 0), user, answer]);
      await vi.waitFor(() =>
        expect(host.querySelector('[data-timeline-row-id="rise-older"]')).not.toBeNull(),
      );
      expect(entering(host, "rise-older")).toBe(false);
      // The animation class is dropped once the arrival window passes.
      await vi.waitFor(() => expect(entering(host, "rise-answer")).toBe(false), {
        timeout: 2_000,
      });
    } finally {
      await screen.unmount();
    }
  });
});

describe("JumpToLatestButton", () => {
  const tail = (overrides: Partial<TimelineTailSnapshot> = {}): TimelineTailSnapshot => ({
    rowId: "tail",
    textEpoch: null,
    textRevision: null,
    text: "Streaming",
    ...overrides,
  });
  const dot = () => document.querySelector('[data-slot="jump-to-latest-new-content"]');

  it("latches the dot on same-message streaming but not on unrelated rerenders", async () => {
    const screen = await render(
      <JumpToLatestButton tail={tail()} shortcutLabel={null} onJump={() => {}} />,
    );
    try {
      // A clock tick re-renders with the same tail.
      await screen.rerender(
        <JumpToLatestButton tail={tail()} shortcutLabel={null} onJump={() => {}} />,
      );
      expect(dot()).toBeNull();
      await screen.rerender(
        <JumpToLatestButton
          tail={tail({ text: "Streaming more" })}
          shortcutLabel={null}
          onJump={() => {}}
        />,
      );
      await vi.waitFor(() => expect(dot()).not.toBeNull());
      expect(document.body.textContent).toContain("response updated");
      expect(document.body.textContent).toContain("Jump to latest");
      await screen.rerender(
        <JumpToLatestButton
          tail={tail({ rowId: "next" })}
          shortcutLabel={null}
          onJump={() => {}}
        />,
      );
      await vi.waitFor(() => expect(document.body.textContent).toContain("new messages"));
    } finally {
      await screen.unmount();
    }
  });
});
