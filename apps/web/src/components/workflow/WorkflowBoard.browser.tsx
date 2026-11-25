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

  it("moves focus across step cards with ArrowRight, ArrowLeft, Home, and End", async () => {
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

    const screen = await render(<WorkflowBoard phases={phases} threadById={new Map()} />);
    try {
      const links = Array.from(
        screen.container.querySelectorAll<HTMLAnchorElement>('a[data-slot="workflow-step"]'),
      );
      expect(links).toHaveLength(3);

      links[0]!.focus();
      expect(document.activeElement).toBe(links[0]);

      links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(document.activeElement).toBe(links[1]);

      links[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      expect(document.activeElement).toBe(links[2]);

      links[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(document.activeElement).toBe(links[0]);

      links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(document.activeElement).toBe(links[2]);
    } finally {
      await screen.unmount();
    }
  });
});
