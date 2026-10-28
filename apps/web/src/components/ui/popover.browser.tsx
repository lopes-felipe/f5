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
