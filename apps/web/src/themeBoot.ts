import { APP_SETTINGS_STORAGE_KEY, parsePersistedAppSettings } from "./appSettings";
import { applyAppearanceSettings, normalizeAppearanceSettings } from "./appearanceSettings";
import { applyThemeMode, readStoredThemeMode, resolveThemeMode } from "./themeMode";
import { applyThemePalette, resolveThemePalette } from "./themePalette";

const settings = parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
const themeMode = readStoredThemeMode();

applyThemeMode(themeMode);
applyThemePalette(
  document.documentElement,
  resolveThemePalette(settings.themeId, settings.customThemes),
  resolveThemeMode(themeMode),
);
applyAppearanceSettings(document.documentElement, normalizeAppearanceSettings(settings));
