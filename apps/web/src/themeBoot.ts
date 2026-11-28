import { APP_SETTINGS_STORAGE_KEY, parsePersistedAppSettings } from "./appSettings";
import { applyAppearanceSettings, normalizeAppearanceSettings } from "./appearanceSettings";
import { applyThemeMode, readStoredThemeMode, resolveThemeMode } from "./themeMode";
import { applyThemePalette, resolveThemePalette } from "./themePalette";
import { readPublishedThemeCache } from "./publishedThemeCache";

try {
  const settings = parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
  const themeMode = readStoredThemeMode();

  applyThemeMode(themeMode);
  applyThemePalette(
    document.documentElement,
    resolveThemePalette(settings.themeId, settings.customThemes, readPublishedThemeCache()),
    resolveThemeMode(themeMode),
  );
  applyAppearanceSettings(document.documentElement, normalizeAppearanceSettings(settings));
} catch {
  // Storage can be unavailable in hardened browser contexts. The mounted app
  // reapplies normalized defaults, so boot should never block rendering.
  applyThemeMode("system");
}
