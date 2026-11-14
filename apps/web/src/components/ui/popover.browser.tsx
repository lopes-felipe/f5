import "../../index.css";

import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

it.each([false, true])(
  "keeps popovers interactive over the window drag region (tooltipStyle=%s)",
  async (tooltipStyle) => {
    let clicks = 0;
    let hovered = false;
    const screen = await render(
      <>
        <div data-testid="desktop-header" className="drag-region fixed inset-x-0 top-0 h-40" />
        <Popover>
          <PopoverTrigger className="fixed top-20 left-20">Open header popover</PopoverTrigger>
          <PopoverPopup side="top" tooltipStyle={tooltipStyle} className="custom-popup">
            <button
              type="button"
              onPointerEnter={() => {
                hovered = true;
              }}
              onClick={() => {
                clicks += 1;
              }}
            >
              Select model
            </button>
          </PopoverPopup>
        </Popover>
      </>,
    );
    try {
      await page.getByRole("button", { name: "Open header popover" }).click();
      const action = page.getByRole("button", { name: "Select model" });
      await expect.element(action).toBeVisible();
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
      const header = page.getByTestId("desktop-header").element();
      expect(getComputedStyle(header).getPropertyValue("-webkit-app-region")).toBe("drag");
      expect(getComputedStyle(popup).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      expect(popup.classList.contains("custom-popup")).toBe(true);
      const popupBounds = popup.getBoundingClientRect();
      const headerBounds = header.getBoundingClientRect();
      expect(popupBounds.top).toBeLessThan(headerBounds.bottom);
      expect(popupBounds.bottom).toBeGreaterThan(headerBounds.top);
      expect(popupBounds.left).toBeLessThan(headerBounds.right);
      expect(popupBounds.right).toBeGreaterThan(headerBounds.left);
      await action.hover();
      expect(hovered).toBe(true);
      await action.click();
      expect(clicks).toBe(1);
    } finally {
      await screen.unmount();
    }
  },
);

it("hides the popup after dismissal", async () => {
  const screen = await render(
    <Popover>
      <PopoverTrigger>Open popover</PopoverTrigger>
      <PopoverPopup>Popover content</PopoverPopup>
    </Popover>,
  );
  try {
    await page.getByRole("button", { name: "Open popover" }).click();
    await expect.element(page.getByText("Popover content")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Popover content")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it.each([false, true])(
  "lets a desktop outside click activate its target (touchBackdrop=%s)",
  async (touchBackdrop) => {
    let clicks = 0;
    const screen = await render(
      <>
        <Popover>
          <PopoverTrigger>Open popover</PopoverTrigger>
          <PopoverPopup touchBackdrop={touchBackdrop}>Popover content</PopoverPopup>
        </Popover>
        <button
          type="button"
          style={{ position: "fixed", right: 10, bottom: 10 }}
          onClick={() => {
            clicks += 1;
          }}
        >
          Outside action
        </button>
      </>,
    );
    try {
      await page.getByRole("button", { name: "Open popover" }).click();
      await expect.element(page.getByText("Popover content")).toBeVisible();
      await page.getByRole("button", { name: "Outside action" }).click();
      expect(clicks).toBe(1);
      await expect.element(page.getByText("Popover content")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  },
);
