import {
  safeLocalStorageGetItem,
  safeLocalStorageRemoveItem,
  safeLocalStorageSetItem,
} from "./lib/safeStorage";
import { parseThemeDefinitionV1, type ThemePalette } from "./themePalette";

const CACHE_KEY = "f5:published-theme";

export function readPublishedThemeCache(): readonly unknown[] {
  try {
    const cached = safeLocalStorageGetItem(CACHE_KEY);
    return cached ? [parseThemeDefinitionV1(JSON.parse(cached))] : [];
  } catch {
    return [];
  }
}

export function cachePublishedTheme(palette: ThemePalette): void {
  if (palette.published && palette.definition) {
    safeLocalStorageSetItem(CACHE_KEY, JSON.stringify(palette.definition));
  } else {
    safeLocalStorageRemoveItem(CACHE_KEY);
  }
}
