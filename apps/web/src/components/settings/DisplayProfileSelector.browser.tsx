import "../../index.css";

import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  DISPLAY_PROFILE_CUSTOM_WARNING,
  DISPLAY_PROFILE_PRESETS,
  getDisplayProfile,
  parsePersistedAppSettings,
  useAppSettings,
} from "../../appSettings";
import { SettingsRouteContext } from "./SettingsRouteContext";
import type { SettingsRouteValue } from "./useSettingsRouteState";
import { DisplaySettings } from "./categories/DisplaySettings";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

function seedAppSettings(settings: Record<string, unknown> = {}) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...parsePersistedAppSettings(null),
      ...settings,
    }),
  );
}

function readPersistedSettings() {
  return parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
}

function clickLabeledControl(ariaLabel: string) {
  const element = document.querySelector<HTMLElement>(`[aria-label="${ariaLabel}"]`);
  if (!element) {
    throw new Error(`Missing control: ${ariaLabel}`);
  }
  element.click();
}

function DisplaySettingsHarness() {
  const { settings, defaults, updateSettings } = useAppSettings();
  const value = useMemo(
    () =>
      ({
        settings,
        defaults,
        updateSettings,
      }) as unknown as SettingsRouteValue,
    [defaults, settings, updateSettings],
  );

  return (
    <SettingsRouteContext.Provider value={value}>
      <DisplaySettings />
    </SettingsRouteContext.Provider>
  );
}

async function renderDisplaySettings(seed: Record<string, unknown> = {}) {
  seedAppSettings(seed);
  const screen = await render(<DisplaySettingsHarness />);

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Display density");
  });

  return screen;
}

describe("DisplayProfileSelector", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("selecting minimal updates all profile-owned settings", async () => {
    const screen = await renderDisplaySettings();

    try {
      await page.getByRole("button", { name: "Minimal" }).click();

      await vi.waitFor(() => {
        expect(readPersistedSettings()).toMatchObject(DISPLAY_PROFILE_PRESETS.minimal);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("selecting detailed enables the full detailed preset, including workflow expansion", async () => {
    const screen = await renderDisplaySettings();

    try {
      await page.getByRole("button", { name: "Detailed" }).click();

      await vi.waitFor(() => {
        expect(readPersistedSettings()).toMatchObject(DISPLAY_PROFILE_PRESETS.detailed);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the derived profile stable when a non-owned setting changes", async () => {
    const screen = await renderDisplaySettings();

    try {
      await page.getByRole("button", { name: "Detailed" }).click();

      await vi.waitFor(() => {
        expect(getDisplayProfile(readPersistedSettings())).toBe("detailed");
      });

      clickLabeledControl("Stream assistant messages");

      await vi.waitFor(() => {
        expect(getDisplayProfile(readPersistedSettings())).toBe("detailed");
      });
      await expect.element(page.getByText(DISPLAY_PROFILE_CUSTOM_WARNING)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows custom helper text for a mixed startup state without auto-applying a preset", async () => {
    const mixedState = {
      ...DISPLAY_PROFILE_PRESETS.detailed,
      showProviderRuntimeMetadata: false,
    };
    const screen = await renderDisplaySettings(mixedState);

    try {
      await expect.element(page.getByText(DISPLAY_PROFILE_CUSTOM_WARNING)).toBeInTheDocument();
      expect(getDisplayProfile(readPersistedSettings())).toBe("custom");
      expect(readPersistedSettings()).toMatchObject(mixedState);
    } finally {
      await screen.unmount();
    }
  });
});
