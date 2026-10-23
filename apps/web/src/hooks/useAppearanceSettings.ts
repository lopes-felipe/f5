import { useLayoutEffect, useMemo } from "react";

import { type AppSettings, useAppSettingsSelector } from "../appSettings";
import {
  applyAppearanceSettings,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from "../appearanceSettings";

function selectAppearanceSettings(settings: AppSettings) {
  return {
    chatContentWidth: settings.chatContentWidth,
    chatFontFamily: settings.chatFontFamily,
    chatFontSize: settings.chatFontSize,
    monoFontFamily: settings.monoFontFamily,
    terminalFontSize: settings.terminalFontSize,
    uiFontFamily: settings.uiFontFamily,
    uiFontSize: settings.uiFontSize,
  };
}

export function useAppearanceSettings(): AppearanceSettings {
  // The selection keeps its identity until an appearance field changes.
  const settings = useAppSettingsSelector(selectAppearanceSettings);
  return useMemo(() => normalizeAppearanceSettings(settings), [settings]);
}

export function useAppearanceSettingsSync(): AppearanceSettings {
  const settings = useAppearanceSettings();
  useLayoutEffect(() => {
    applyAppearanceSettings(document.documentElement, settings);
  }, [settings]);
  return settings;
}
