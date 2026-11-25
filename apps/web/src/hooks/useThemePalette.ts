import { useLayoutEffect, useMemo } from "react";
import type { ServerConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { cachePublishedTheme, readPublishedThemeCache } from "../publishedThemeCache";
import { useThemeBackground } from "../themeBackground";

import {
  type AppSettings,
  readAppSettingsSnapshot,
  updateAppSettings,
  useAppSettingsSelector,
} from "../appSettings";
import { setThemeMode } from "./useTheme";
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
  readonly background?: string | undefined;
  readonly publishedThemesLoaded: boolean;
}

function selectThemeSettings(settings: AppSettings) {
  return { customThemes: settings.customThemes, themeId: settings.themeId };
}

function selectPublishedThemes(config: ServerConfig) {
  return {
    themes: config.settings?.environmentThemes,
    backgrounds: config.themeBackgrounds,
  };
}

export function useResolvedThemePalette(variant: ThemeVariant): ResolvedThemePalette {
  const settings = useAppSettingsSelector(selectThemeSettings);
  const { data } = useQuery({ ...serverConfigQueryOptions(), select: selectPublishedThemes });
  const cachedThemes = useMemo(readPublishedThemeCache, []);
  return useMemo(() => {
    const library = parseCustomThemeLibrary(settings.customThemes);
    const palette = resolveThemePalette(
      settings.themeId,
      settings.customThemes,
      data ? (data.themes ?? []) : cachedThemes,
    );
    return {
      palette,
      library,
      revision: themePaletteRevision(palette, variant),
      publishedThemesLoaded: !!data,
      background: palette.published ? data?.backgrounds?.[palette.id] : undefined,
    };
  }, [settings.customThemes, settings.themeId, variant, data, cachedThemes]);
}

export function useThemePaletteSync(variant: ThemeVariant): ResolvedThemePalette {
  const resolved = useResolvedThemePalette(variant);
  const { data: selection } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.settings?.environmentThemeSelection,
  });
  useLayoutEffect(() => {
    try {
      if (
        selection?.theme &&
        localStorage.getItem("f5:applied-environment-theme") !== selection.theme.generation
      ) {
        updateAppSettings({ themeId: selection.theme.value });
        if (readAppSettingsSnapshot().themeId === selection.theme.value)
          localStorage.setItem("f5:applied-environment-theme", selection.theme.generation);
      }
      if (
        selection?.appearance &&
        localStorage.getItem("f5:applied-environment-appearance") !==
          selection.appearance.generation
      ) {
        setThemeMode(selection.appearance.value);
        localStorage.setItem("f5:applied-environment-appearance", selection.appearance.generation);
      }
    } catch {
      // Existing local choices still apply when storage is unavailable.
    }
  }, [selection]);
  useLayoutEffect(() => {
    applyThemePalette(document.documentElement, resolved.palette, variant);
    if (resolved.publishedThemesLoaded) cachePublishedTheme(resolved.palette);
  }, [resolved.palette, resolved.revision, variant]);
  useThemeBackground(resolved.background);
  return resolved;
}
