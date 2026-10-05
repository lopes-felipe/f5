import "../../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerDock, ComposerDockColumn } from "./ComposerDock";
import { ComposerTray } from "./ComposerTray";

const HOST_HEIGHT = 320;
const COMPOSER_HEIGHT = 140;

function DockFixture(props: { readonly trayRows: number }) {
  return (
    <div
      data-composer-dock-host
      data-testid="dock-host"
      className="relative flex flex-col"
      style={{ width: 1000, height: HOST_HEIGHT }}
    >
      <div data-testid="timeline" className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: 2_000 }} />
      </div>
      <ComposerDock>
        <ComposerDockColumn>
          <ComposerTray>
            {Array.from({ length: props.trayRows }, (_, index) => (
              <div key={index} className="h-16 px-3">
                Pending question {index + 1}
              </div>
            ))}
          </ComposerTray>
          <form data-testid="composer" className="shrink-0" style={{ height: COMPOSER_HEIGHT }}>
            <button type="button">Send</button>
          </form>
        </ComposerDockColumn>
      </ComposerDock>
    </div>
  );
}

describe("ComposerDock", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("never grows past its host: the tray scrolls and the composer stays in view", async () => {
    await page.viewport(1_100, 700);
    const screen = await render(<DockFixture trayRows={12} />);
    try {
      const host = document.querySelector<HTMLElement>('[data-testid="dock-host"]')!;
      const dock = document.querySelector<HTMLElement>('[data-slot="composer-dock"]')!;
      const tray = document.querySelector<HTMLElement>('[data-slot="composer-tray"]')!;
      const composer = document.querySelector<HTMLElement>('[data-testid="composer"]')!;
      const hostRect = host.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();

      expect(dockRect.height).toBeLessThanOrEqual(HOST_HEIGHT + 0.5);
      expect(dockRect.top).toBeGreaterThanOrEqual(hostRect.top - 0.5);
      expect(composerRect.height).toBeCloseTo(COMPOSER_HEIGHT, 0);
      expect(composerRect.top).toBeGreaterThanOrEqual(hostRect.top);
      expect(composerRect.bottom).toBeLessThanOrEqual(hostRect.bottom + 0.5);
      // Twelve 64px rows cannot fit; the tray holds them in its own scroll.
      expect(tray.scrollHeight).toBeGreaterThan(tray.clientHeight);
      tray.scrollTop = tray.scrollHeight;
      expect(tray.scrollTop).toBeGreaterThan(0);
      await expect.element(page.getByText("Pending question 12")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("lets pointer events over the side gutters reach the timeline", async () => {
    await page.viewport(1_100, 700);
    const screen = await render(<DockFixture trayRows={1} />);
    try {
      const host = document.querySelector<HTMLElement>('[data-testid="dock-host"]')!;
      const timeline = document.querySelector<HTMLElement>('[data-testid="timeline"]')!;
      const composer = document.querySelector<HTMLElement>('[data-testid="composer"]')!;
      const hostRect = host.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const y = composerRect.top + composerRect.height / 2;

      // The column is capped at the chat width, so a 1000px host has gutters.
      expect(composerRect.left).toBeGreaterThan(hostRect.left + 20);
      expect(document.elementFromPoint(hostRect.left + 8, y)).toBe(timeline.firstElementChild);
      expect(composer.contains(document.elementFromPoint(composerRect.left + 20, y))).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
});
