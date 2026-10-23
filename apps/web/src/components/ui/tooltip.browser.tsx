import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "./tooltip";

function Fixture() {
  return (
    <TooltipScrollDismissArea>
      <div data-testid="scroller" style={{ height: 120, overflowY: "auto" }}>
        <Tooltip>
          <TooltipTrigger delay={0} render={<button type="button" />}>
            Hover me
          </TooltipTrigger>
          <TooltipPopup>Row details</TooltipPopup>
        </Tooltip>
        <div style={{ height: 600 }} />
      </div>
    </TooltipScrollDismissArea>
  );
}

// The scroll event is dispatched without moving the content: Chromium's own synthetic
// mousemove after a real scroll arrives later (and not during momentum scrolling), so only the
// dismiss area can close the tooltip here.
it("closes a hovered tooltip when its area scrolls but keeps a focused one", async () => {
  await render(<Fixture />);
  const trigger = page.getByRole("button", { name: "Hover me" });
  const scroller = page.getByTestId("scroller").element() as HTMLElement;
  const popup = page.getByText("Row details");

  await userEvent.hover(trigger);
  await expect.element(popup).toBeVisible();
  scroller.dispatchEvent(new Event("scroll"));
  await expect.element(popup).not.toBeInTheDocument();

  await userEvent.unhover(trigger);
  (trigger.element() as HTMLElement).focus();
  await expect.element(popup).toBeVisible();
  await userEvent.hover(trigger);
  scroller.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect.element(popup).toBeVisible();
});
