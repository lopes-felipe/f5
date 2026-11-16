import "../../index.css";

import { TurnId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { TurnDiffFileChange } from "../../types";
import { ChangedFilesTree } from "./ChangedFilesTree";

const turnId = TurnId.makeUnsafe("turn-1");

function file(path: string): TurnDiffFileChange {
  return { path, kind: "modified", additions: 1, deletions: 0 };
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const text = () => document.body.textContent ?? "";

function buttonWithText(label: string) {
  const button = buttons().find((element) => element.textContent?.includes(label));
  expect(button, `button ${label}`).toBeDefined();
  return button!;
}

async function nextFrame() {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}

async function scrollTo(element: HTMLElement, top: number) {
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
  await nextFrame();
}

function Scroller({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="scroller" style={{ height: 280, overflowY: "auto" }}>
      {children}
    </div>
  );
}

describe("ChangedFilesTree", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const manyFiles = Array.from({ length: 5_000 }, (_, index) =>
    file(`src/file-${index.toString().padStart(5, "0")}.ts`),
  );

  it("renders every row of a small tree", async () => {
    const screen = await render(
      <Scroller>
        <ChangedFilesTree
          turnId={turnId}
          files={manyFiles.slice(0, 10)}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      </Scroller>,
    );
    try {
      expect(buttons()).toHaveLength(11);
    } finally {
      await screen.unmount();
    }
  });

  it("mounts only the rows near the viewport of a large tree and follows scrolling", async () => {
    const onOpenTurnDiff = vi.fn();
    const screen = await render(
      <Scroller>
        <ChangedFilesTree
          turnId={turnId}
          files={manyFiles}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={onOpenTurnDiff}
        />
      </Scroller>,
    );
    try {
      await nextFrame();
      expect(buttons().length).toBeLessThan(40);
      expect(text()).toContain("file-00000.ts");
      expect(text()).not.toContain("file-04999.ts");

      const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
      await scrollTo(scroller, scroller.scrollHeight);
      expect(buttons().length).toBeLessThan(40);
      expect(text()).toContain("file-04999.ts");
      expect(text()).not.toContain("file-00000.ts");

      buttonWithText("file-04999.ts").click();
      expect(onOpenTurnDiff).toHaveBeenCalledWith(turnId, "src/file-04999.ts");
    } finally {
      await screen.unmount();
    }
  });

  it("stops virtualizing when folders collapse below the row threshold", async () => {
    const screen = await render(
      <Scroller>
        <ChangedFilesTree
          turnId={turnId}
          files={[...manyFiles.slice(0, 300), file("extra/overflow.ts")]}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      </Scroller>,
    );
    try {
      await nextFrame();
      expect(buttons().length).toBeLessThan(40);

      buttonWithText("src").click();
      await nextFrame();
      expect(buttons().map((button) => button.textContent)).toEqual([
        expect.stringContaining("extra"),
        expect.stringContaining("overflow.ts"),
        expect.stringContaining("src"),
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a focused row mounted after it scrolls out of the window", async () => {
    const screen = await render(
      <Scroller>
        <ChangedFilesTree
          turnId={turnId}
          files={manyFiles}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      </Scroller>,
    );
    try {
      await nextFrame();
      const focused = buttonWithText("file-00002.ts");
      focused.focus();
      await nextFrame();

      const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
      await scrollTo(scroller, scroller.scrollHeight / 2);
      expect(document.activeElement).toBe(focused);
      expect(text()).toContain("file-00002.ts");
    } finally {
      await screen.unmount();
    }
  });
});
