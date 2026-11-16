import "../../index.css";

import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { UsageGauge } from "./UsageGauge";
import { Button } from "../ui/button";

it("distinguishes unknown consumption from zero and animates reported updates", async () => {
  const screen = await render(<UsageGauge percent={null} />);
  try {
    const meter = screen.getByRole("progressbar", { name: "Weekly usage" });
    await expect.element(meter).toHaveAttribute("aria-valuetext", "Weekly usage unavailable");
    await expect.element(meter).not.toHaveAttribute("aria-valuenow");
    const needle = meter.element().querySelector<SVGGElement>('[data-slot="usage-gauge-needle"]')!;
    expect(needle.style.opacity).toBe("0");
    await screen.rerender(<UsageGauge percent={0} />);
    await expect.element(meter).toHaveAttribute("aria-valuenow", "0");
    await expect.element(meter).toHaveAttribute("aria-valuetext", "0% of weekly limit used");
    expect(needle.style.transform).toBe("rotate(-120deg)");
    expect(needle.style.opacity).toBe("1");
    await screen.rerender(<UsageGauge percent={40} />);
    await expect.element(meter).toHaveAttribute("aria-valuenow", "40");
    expect(meter.element().classList.contains("text-muted-foreground")).toBe(true);
    expect(needle.style.transform).toBe("rotate(-24deg)");
    expect(getComputedStyle(needle).transitionProperty).toContain("transform");
    expect(getComputedStyle(needle).transitionDuration).not.toBe("0s");
    await screen.rerender(<UsageGauge percent={120} />);
    await expect.element(meter).toHaveAttribute("aria-valuenow", "100");
    expect(needle.style.transform).toBe("rotate(120deg)");
  } finally {
    await screen.unmount();
  }
});

it.each([0, 50, 100])("positions the needle proportionally at %s%% used", async (percent) => {
  const screen = await render(<UsageGauge percent={percent} />);
  try {
    const svg = screen.getByRole("progressbar").element().querySelector("svg")!;
    const needle = svg.querySelector<SVGGElement>('[data-slot="usage-gauge-needle"]')!;
    const pivot = new DOMPoint(12, 14).matrixTransform(svg.getScreenCTM()!);
    const tip = new DOMPoint(12, 7).matrixTransform(needle.getScreenCTM()!);
    if (percent === 50) {
      expect(tip.x).toBeCloseTo(pivot.x, 1);
      expect(tip.y).toBeLessThan(pivot.y);
    } else {
      expect(tip.y).toBeGreaterThan(pivot.y);
      if (percent === 0) expect(tip.x).toBeLessThan(pivot.x);
      else expect(tip.x).toBeGreaterThan(pivot.x);
    }
  } finally {
    await screen.unmount();
  }
});

it("centers the visible dial inside the composer icon button", async () => {
  const screen = await render(
    <Button variant="ghost" size="icon-sm" aria-label="Usage limits">
      <UsageGauge percent={50} />
    </Button>,
  );
  try {
    const button = screen
      .getByRole("button", { name: "Usage limits" })
      .element()
      .getBoundingClientRect();
    const dial = screen
      .getByRole("progressbar")
      .element()
      .querySelector('[data-slot="usage-gauge-dial"]')!
      .getBoundingClientRect();
    expect(Math.abs(dial.left + dial.width / 2 - button.left - button.width / 2)).toBeLessThan(0.5);
    expect(Math.abs(dial.top + dial.height / 2 - button.top - button.height / 2)).toBeLessThan(0.5);
  } finally {
    await screen.unmount();
  }
});
