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
      background:
        palette.published && palette.definition
          ? data?.backgrounds?.[palette.definition.id]
          : undefined,
    };
  }, [settings.customThemes, settings.themeId, variant, data, cachedThemes]);
}

export function useThemePaletteSync(variant: ThemeVariant): ResolvedThemePalette {
  const resolved = useResolvedThemePalette(variant);
  const { data: selection } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.settings,
  });
  useLayoutEffect(() => {
    try {
      if (
        selection?.environmentThemeSelection.theme &&
        localStorage.getItem("f5:applied-environment-theme") !==
          selection.environmentThemeSelection.theme.generation
      ) {
        const { value, generation } = selection.environmentThemeSelection.theme;
        const published = selection.environmentThemes.some((theme) => theme.id === value);
        const themeId = published ? "published:" + value : value;
        const target = resolveThemePalette(themeId, [], selection.environmentThemes);
        if (target.id === themeId && (published || target.builtin)) {
          updateAppSettings({ themeId });
          if (readAppSettingsSnapshot().themeId === themeId)
            localStorage.setItem("f5:applied-environment-theme", generation);
        }
      }
      const appearance = selection?.environmentThemeSelection.appearance;
      if (
        appearance &&
        localStorage.getItem("f5:applied-environment-appearance") !== appearance.generation
      ) {
        setThemeMode(appearance.value);
        localStorage.setItem("f5:applied-environment-appearance", appearance.generation);
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
