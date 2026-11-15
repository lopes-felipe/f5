import "../../index.css";

import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { UsageRing } from "./UsageRing";

it("distinguishes unknown consumption from zero and animates reported updates", async () => {
  const screen = await render(<UsageRing percent={null} />);
  try {
    const meter = screen.getByRole("progressbar", { name: "Weekly usage" });
    await expect.element(meter).toHaveAttribute("aria-valuetext", "Weekly usage unavailable");
    await expect.element(meter).not.toHaveAttribute("aria-valuenow");
    await screen.rerender(<UsageRing percent={0} />);
    await expect.element(meter).toHaveAttribute("aria-valuenow", "0");
    await expect.element(meter).toHaveAttribute("aria-valuetext", "0% of weekly limit used");
    await screen.rerender(<UsageRing percent={40} />);
    await expect.element(meter).toHaveAttribute("aria-valuenow", "40");
    const arc = meter.element().querySelector("circle:last-child")!;
    expect(arc.getAttribute("stroke-dashoffset")).toBe("60");
    expect(getComputedStyle(arc).transitionProperty).toContain("stroke-dashoffset");
    expect(getComputedStyle(arc).transitionDuration).not.toBe("0s");
    await screen.rerender(<UsageRing percent={120} />);
    await expect.element(meter).toHaveAttribute("aria-valuenow", "100");
    expect(arc.getAttribute("stroke-dashoffset")).toBe("0");
  } finally {
    await screen.unmount();
  }
});
