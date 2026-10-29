import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { readAppSettingsSnapshot, updateAppSettings } from "../../appSettings";
import { DEFAULT_SNOOZE_PRESETS, MAX_SNOOZE_PRESETS } from "../../lib/snoozePresets";
import { SnoozePresetsSettings } from "./SnoozePresetsSettings";

afterEach(() => {
  updateAppSettings({ snoozePresets: DEFAULT_SNOOZE_PRESETS });
});

it("adds, edits and removes snooze options, up to the limit", async () => {
  const view = await render(<SnoozePresetsSettings />);
  try {
    await expect.element(page.getByText("In 3 hours", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Restore defaults" }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "Add option" }).click();
    expect(readAppSettingsSnapshot().snoozePresets).toHaveLength(4);
    expect(readAppSettingsSnapshot().snoozePresets[3]).toEqual({ kind: "after", minutes: 60 });

    const amount = page.getByRole("group", { name: "Snooze option 4" }).getByLabelText("Amount");
    await amount.fill("90");
    await amount.click();
    await page.getByRole("button", { name: "Add option" }).click();
    expect(readAppSettingsSnapshot().snoozePresets[3]).toEqual({ kind: "after", minutes: 5400 });

    await page.getByRole("button", { name: "Remove snooze option 1" }).click();
    expect(readAppSettingsSnapshot().snoozePresets[0]).toEqual(DEFAULT_SNOOZE_PRESETS[1]);

    while (readAppSettingsSnapshot().snoozePresets.length < MAX_SNOOZE_PRESETS) {
      await page.getByRole("button", { name: "Add option" }).click();
    }
    await expect.element(page.getByRole("button", { name: "Add option" })).toBeDisabled();

    await page.getByRole("button", { name: "Restore defaults" }).click();
    expect(readAppSettingsSnapshot().snoozePresets).toEqual(DEFAULT_SNOOZE_PRESETS);
  } finally {
    await view.unmount();
  }
});
