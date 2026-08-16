import { useLayoutEffect, useMemo } from "react";

import { useAppSettings } from "../appSettings";
import {
  applyAppearanceSettings,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from "../appearanceSettings";

export function useAppearanceSettings(): AppearanceSettings {
  const { settings } = useAppSettings();
  return useMemo(
    () => normalizeAppearanceSettings(settings),
    [
      settings.chatFontFamily,
      settings.chatFontSize,
      settings.monoFontFamily,
      settings.terminalFontSize,
      settings.uiFontFamily,
      settings.uiFontSize,
    ],
  );
}

export function useAppearanceSettingsSync(): AppearanceSettings {
  const settings = useAppearanceSettings();
  useLayoutEffect(() => {
    applyAppearanceSettings(document.documentElement, settings);
  }, [settings]);
  return settings;
}
