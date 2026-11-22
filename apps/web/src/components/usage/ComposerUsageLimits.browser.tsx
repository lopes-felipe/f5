import "../../index.css";

import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerLimitRow, PersistentUsageLimits } from "./ComposerUsageLimits";

const NOW = Date.parse("2026-11-17T21:00:00.000Z");
const HOUR = 3_600_000;

it("warns about stale persistent limits and announces data changes without clock ticks", async () => {
  const windows = [weekly()];
  const view = await render(
    <PersistentUsageLimits windows={windows} now={NOW} label="Codex" stale />,
  );
  try {
    await expect
      .element(page.getByText("Collected limits may be stale.", { exact: true }))
      .toBeVisible();
    const announcement = page.getByRole("status").element().textContent;
    await view.rerender(
      <PersistentUsageLimits windows={windows} now={NOW + 30_000} label="Codex" stale />,
    );
    expect(page.getByRole("status").element().textContent).toBe(announcement);
    await view.rerender(
      <PersistentUsageLimits
        windows={[weekly({ usedPercent: 10 })]}
        now={NOW}
        label="Codex"
        stale={false}
      />,
    );
    expect(page.getByRole("status").element().textContent).toContain("10% used");
    expect(page.getByText("Collected limits may be stale.", { exact: true }).all()).toHaveLength(0);
  } finally {
    await view.unmount();
  }
});

function weekly(overrides: Partial<Parameters<typeof ComposerLimitRow>[0]["window"]> = {}) {
  return {
    windowKey: "seven_day_fable",
    label: "Fable weekly limit",
    usedPercent: 73,
    // 56 of 168 hours remain, so two thirds of the week has elapsed.
    resetsAt: new Date(NOW + 56 * HOUR).toISOString(),
    durationMinutes: 10_080,
    observedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

it("marks elapsed time on the bar and labels the pace on the reset line", async () => {
  const screen = await render(<ComposerLimitRow window={weekly()} now={NOW} />);
  try {
    expect(page.getByTestId("quota-pace-tick").all()).toHaveLength(1);
    const tick = page.getByTestId("quota-pace-tick").element() as HTMLElement;
    expect(Number.parseFloat(tick.style.left)).toBeCloseTo(66.67, 1);
    await expect.element(page.getByText("6 pts ahead of pace")).toBeVisible();
    await expect.element(page.getByText(/^Resets in 2d 8h · /)).toBeVisible();
    await expect
      .element(page.getByRole("progressbar", { name: "Fable weekly limit" }))
      .toHaveAttribute("aria-valuetext", "73% used, 6 pts ahead of pace");
  } finally {
    await screen.unmount();
  }
});

it("reads usage within a few points of elapsed time as on pace", async () => {
  const screen = await render(<ComposerLimitRow window={weekly({ usedPercent: 63 })} now={NOW} />);
  try {
    await expect.element(page.getByText("on pace")).toBeVisible();
    expect(page.getByTestId("quota-pace-tick").all()).toHaveLength(1);
  } finally {
    await screen.unmount();
  }
});

it("omits the tick and pace when the window length is unknown", async () => {
  const screen = await render(
    <ComposerLimitRow window={weekly({ durationMinutes: null })} now={NOW} />,
  );
  try {
    expect(page.getByTestId("quota-pace-tick").all()).toHaveLength(0);
    expect(page.getByText(/pace/).all()).toHaveLength(0);
    await expect
      .element(page.getByRole("progressbar", { name: "Fable weekly limit" }))
      .toHaveAttribute("aria-valuetext", "73% used");
  } finally {
    await screen.unmount();
  }
});

it("omits the tick and pace once the reset has passed", async () => {
  const screen = await render(
    <ComposerLimitRow
      window={weekly({
        resetsAt: new Date(NOW - HOUR).toISOString(),
        observedAt: new Date(NOW - 2 * HOUR).toISOString(),
      })}
      now={NOW}
    />,
  );
  try {
    expect(page.getByTestId("quota-pace-tick").all()).toHaveLength(0);
    await expect.element(page.getByText("Reset passed · Awaiting updated usage")).toBeVisible();
    expect(page.getByText(/pace/).all()).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});
