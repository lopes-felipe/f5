import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useRestoreFocusOnClose } from "./useRestoreFocusOnClose";

function PanelHarness({
  unmountTriggerOnOpen = false,
}: {
  readonly unmountTriggerOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);

  useRestoreFocusOnClose({
    open,
    containerRef: panelRef,
    fallbackRef,
  });

  return (
    <div>
      <button ref={fallbackRef} type="button" data-testid="fallback">
        Fallback
      </button>
      {!unmountTriggerOnOpen || !open ? (
        <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
          Open panel
        </button>
      ) : null}
      <button type="button" data-testid="outside">
        Outside control
      </button>
      {open ? (
        <div ref={panelRef} data-testid="panel">
          <button type="button" data-testid="close" onClick={() => setOpen(false)}>
            Close panel
          </button>
        </div>
      ) : null}
    </div>
  );
}

describe("useRestoreFocusOnClose", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("restores focus to the trigger button when the panel closes", async () => {
    const screen = await render(<PanelHarness />);
    try {
      const trigger = screen.container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      trigger.click();
      await vi.waitFor(() => {
        expect(screen.container.querySelector('[data-testid="close"]')).not.toBeNull();
      });

      const closeButton =
        screen.container.querySelector<HTMLButtonElement>('[data-testid="close"]')!;
      closeButton.focus();
      closeButton.click();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(trigger);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("falls back cleanly when the original trigger unmounted while open", async () => {
    const screen = await render(<PanelHarness unmountTriggerOnOpen />);
    try {
      const trigger = screen.container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
      const fallback = screen.container.querySelector<HTMLButtonElement>(
        '[data-testid="fallback"]',
      )!;
      trigger.focus();
      trigger.click();

      await vi.waitFor(() => {
        expect(screen.container.querySelector('[data-testid="close"]')).not.toBeNull();
      });

      const closeButton =
        screen.container.querySelector<HTMLButtonElement>('[data-testid="close"]')!;
      closeButton.focus();
      closeButton.click();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(fallback);
      });
    } finally {
      await screen.unmount();
    }
  });
});
