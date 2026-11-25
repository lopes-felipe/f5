import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkflowBoard } from "./WorkflowBoard";
import type { WorkflowTimelinePhase } from "./workflowTimelineTypes";

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({
      to: _to,
      params: _params,
      children,
      ...rest
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: unknown; params?: unknown }) => (
      <a href="#" {...rest}>
        {children}
      </a>
    ),
  };
});

describe("WorkflowBoard keyboard navigation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves focus across focusable step card links, skips placeholder div cards, and ignores modified or outside keys", async () => {
    const phases: WorkflowTimelinePhase[] = [
      {
        id: "drafting",
        label: "Drafting",
        state: "completed",
        steps: [
          {
            key: "a",
            label: "Branch A",
            threadId: ThreadId.makeUnsafe("t-a"),
            state: "completed",
            modelSlot: null,
          },
          {
            key: "placeholder",
            label: "Pending step",
            threadId: null,
            state: "pending",
            modelSlot: null,
          },
          {
            key: "b",
            label: "Branch B",
            threadId: ThreadId.makeUnsafe("t-b"),
            state: "completed",
            modelSlot: null,
          },
        ],
      },
      {
        id: "merge",
        label: "Merge",
        state: "active",
        steps: [
          {
            key: "merge",
            label: "Merge plan",
            threadId: ThreadId.makeUnsafe("t-m"),
            state: "active",
            modelSlot: null,
          },
        ],
      },
    ];

    const screen = await render(
      <div>
        <button type="button" data-testid="outside">
          Outside
        </button>
        <WorkflowBoard phases={phases} threadById={new Map()} />
      </div>,
    );
    try {
      const links = Array.from(
        screen.container.querySelectorAll<HTMLAnchorElement>('a[data-slot="workflow-step"]'),
      );
      const placeholderCards = screen.container.querySelectorAll('div[data-slot="workflow-step"]');
      expect(links).toHaveLength(3);
      expect(placeholderCards).toHaveLength(1);

      links[0]!.focus();
      expect(document.activeElement).toBe(links[0]);

      // Plain arrow / Home / End keys navigate across focusable link cards (skipping placeholder divs).
      links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(document.activeElement).toBe(links[1]);

      links[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      expect(document.activeElement).toBe(links[2]);

      links[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(document.activeElement).toBe(links[0]);

      links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(document.activeElement).toBe(links[2]);

      // Modified keys (browser Back/Forward, Ctrl+Home, Meta+End, Shift+ArrowRight) must NOT be swallowed.
      for (const init of [
        { key: "ArrowLeft", altKey: true },
        { key: "ArrowRight", altKey: true },
        { key: "Home", ctrlKey: true },
        { key: "End", metaKey: true },
        { key: "ArrowRight", shiftKey: true },
      ]) {
        const event = new KeyboardEvent("keydown", {
          ...init,
          bubbles: true,
          cancelable: true,
        });
        links[2]!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(links[2]);
      }

      // Keydown on the board when focus is outside step cards must not hijack focus or preventDefault.
      const outside = screen.container.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
      const board = screen.container.querySelector<HTMLOListElement>(
        '[data-slot="workflow-board"]',
      )!;
      outside.focus();
      const outsideEvent = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      board.dispatchEvent(outsideEvent);
      expect(outsideEvent.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);
    } finally {
      await screen.unmount();
    }
  });
});
