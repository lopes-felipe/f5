import "../../index.css";

import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

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
