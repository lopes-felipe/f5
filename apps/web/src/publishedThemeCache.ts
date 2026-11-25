import { parseThemeDefinitionV1, type ThemePalette } from "./themePalette";

const CACHE_KEY = "f5:published-theme";

export function readPublishedThemeCache(): readonly unknown[] {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return cached ? [parseThemeDefinitionV1(JSON.parse(cached))] : [];
  } catch {
    return [];
  }
}

export function cachePublishedTheme(palette: ThemePalette): void {
  try {
    if (palette.published && palette.definition) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(palette.definition));
    } else {
      localStorage.removeItem(CACHE_KEY);
    }
  } catch {
    // The live theme remains usable with storage disabled.
  }
}
