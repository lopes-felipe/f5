import "../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RightPanelSheet } from "../components/RightPanelSheet";

function RightPanelSheetHarness() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Open right panel
      </button>
      <button type="button" data-testid="outside">
        Outside control
      </button>
      <RightPanelSheet open={open} onClose={() => setOpen(false)}>
        <div data-testid="sheet-body">
          <button type="button" data-testid="sheet-close" onClick={() => setOpen(false)}>
            Close panel
          </button>
          <button
            type="button"
            data-testid="sheet-close-and-move-focus"
            onClick={() => {
              setOpen(false);
              const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]');
              outside?.focus();
            }}
          >
            Close and focus outside
          </button>
        </div>
      </RightPanelSheet>
    </div>
  );
}

describe("useRestoreFocusOnClose + RightPanelSheet", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("restores focus to the trigger button when RightPanelSheet closes", async () => {
    const screen = await render(<RightPanelSheetHarness />);
    try {
      const trigger = screen.container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      trigger.click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="sheet-close"]')).not.toBeNull();
      });

      const closeButton = document.querySelector<HTMLButtonElement>('[data-testid="sheet-close"]')!;
      closeButton.focus();
      closeButton.click();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(trigger);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not steal focus if another control is focused before restoration runs", async () => {
    const screen = await render(<RightPanelSheetHarness />);
    try {
      const trigger = screen.container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
      const outside = screen.container.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
      trigger.focus();
      trigger.click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="sheet-close-and-move-focus"]')).not.toBeNull();
      });

      const closeAndMove = document.querySelector<HTMLButtonElement>(
        '[data-testid="sheet-close-and-move-focus"]',
      )!;
      closeAndMove.focus();
      closeAndMove.click();

      // Wait several animation frames + exit transition window to ensure neither the hook nor Base UI steals focus.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(document.activeElement).toBe(outside);
    } finally {
      await screen.unmount();
    }
  });
});
