import "../../index.css";

import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { UsageGauge, describeWeeklyUsage } from "./UsageGauge";
import { Button } from "../ui/button";

const gauge = () => document.querySelector<HTMLElement>('[data-slot="usage-gauge"]')!;

it("describes unknown, zero and clamped weekly usage", () => {
  expect(describeWeeklyUsage(null)).toBe("Weekly usage unavailable");
  expect(describeWeeklyUsage(Number.NaN)).toBe("Weekly usage unavailable");
  expect(describeWeeklyUsage(0)).toBe("0% of weekly limit used");
  expect(describeWeeklyUsage(37.4)).toBe("37% of weekly limit used");
  expect(describeWeeklyUsage(120)).toBe("100% of weekly limit used");
});

it("distinguishes unknown consumption from zero and animates reported updates", async () => {
  const screen = await render(<UsageGauge percent={null} />);
  try {
    expect(gauge().getAttribute("aria-hidden")).toBe("true");
    expect(gauge().hasAttribute("data-used")).toBe(false);
    const needle = gauge().querySelector<SVGGElement>('[data-slot="usage-gauge-needle"]')!;
    expect(needle.style.opacity).toBe("0");
    await screen.rerender(<UsageGauge percent={0} />);
    expect(gauge().getAttribute("data-used")).toBe("0");
    expect(needle.style.transform).toBe("rotate(-120deg)");
    expect(needle.style.opacity).toBe("1");
    await screen.rerender(<UsageGauge percent={40} />);
    expect(gauge().getAttribute("data-used")).toBe("40");
    expect(gauge().classList.contains("text-muted-foreground")).toBe(true);
    expect(needle.style.transform).toBe("rotate(-24deg)");
    expect(getComputedStyle(needle).transitionProperty).toContain("transform");
    expect(getComputedStyle(needle).transitionDuration).not.toBe("0s");
    await screen.rerender(<UsageGauge percent={120} />);
    expect(gauge().getAttribute("data-used")).toBe("100");
    expect(needle.style.transform).toBe("rotate(120deg)");
  } finally {
    await screen.unmount();
  }
});

it.each([0, 50, 100])("positions the needle proportionally at %s%% used", async (percent) => {
  const screen = await render(<UsageGauge percent={percent} />);
  try {
    const svg = gauge().querySelector("svg")!;
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

it("centers the visible dial inside the composer icon button and announces usage there", async () => {
  const name = `Codex usage limits, ${describeWeeklyUsage(50)}`;
  const screen = await render(
    <Button variant="ghost" size="icon-sm" aria-label={name}>
      <UsageGauge percent={50} />
    </Button>,
  );
  try {
    const button = screen.getByRole("button", { name }).element().getBoundingClientRect();
    const dial = gauge().querySelector('[data-slot="usage-gauge-dial"]')!.getBoundingClientRect();
    expect(Math.abs(dial.left + dial.width / 2 - button.left - button.width / 2)).toBeLessThan(0.5);
    expect(Math.abs(dial.top + dial.height / 2 - button.top - button.height / 2)).toBeLessThan(0.5);
    // The decorative gauge adds no nested, unannounced progressbar.
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  } finally {
    await screen.unmount();
  }
});
