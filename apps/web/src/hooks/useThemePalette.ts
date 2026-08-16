import { useLayoutEffect, useMemo } from "react";

import { useAppSettings } from "../appSettings";
import {
  applyThemePalette,
  parseCustomThemeLibrary,
  resolveThemePalette,
  themePaletteRevision,
  type ParsedThemeLibrary,
  type ThemePalette,
  type ThemeVariant,
} from "../themePalette";

export interface ResolvedThemePalette {
  readonly palette: ThemePalette;
  readonly library: ParsedThemeLibrary;
  readonly revision: string;
}

export function useResolvedThemePalette(variant: ThemeVariant): ResolvedThemePalette {
  const { settings } = useAppSettings();
  return useMemo(() => {
    const library = parseCustomThemeLibrary(settings.customThemes);
    const palette = resolveThemePalette(settings.themeId, settings.customThemes);
    return { palette, library, revision: themePaletteRevision(palette, variant) };
  }, [settings.customThemes, settings.themeId, variant]);
}

export function useThemePaletteSync(variant: ThemeVariant): ResolvedThemePalette {
  const resolved = useResolvedThemePalette(variant);
  useLayoutEffect(() => {
    applyThemePalette(document.documentElement, resolved.palette, variant);
  }, [resolved.palette, resolved.revision, variant]);
  return resolved;
}
