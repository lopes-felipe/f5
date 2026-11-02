import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import {
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  fontFamilyStack,
  type AppearanceSettings,
} from "../appearanceSettings";
import { htmlRenderThemeFromPalette } from "../lib/htmlRenderTheme";
import {
  DEFAULT_THEME_ID,
  resolveThemePalette,
  themePaletteRevision,
  type ThemePalette,
  type ThemeVariant,
} from "../themePalette";

export interface HtmlRenderThemes {
  readonly appearance: ThemeVariant;
  readonly light: HtmlRenderTheme;
  readonly dark: HtmlRenderTheme;
}

const buildThemes = (
  palette: ThemePalette,
  fonts: { readonly sans: string; readonly mono: string },
) => ({
  light: htmlRenderThemeFromPalette(palette.light, "light", fonts),
  dark: htmlRenderThemeFromPalette(palette.dark, "dark", fonts),
});

let fallback: HtmlRenderThemes | undefined;
/** For frames rendered outside the app root, such as isolated component tests. */
const fallbackThemes = () =>
  (fallback ??= {
    appearance: "dark",
    ...buildThemes(resolveThemePalette(DEFAULT_THEME_ID, []), {
      sans: DEFAULT_UI_FONT_STACK,
      mono: DEFAULT_MONO_FONT_STACK,
    }),
  });

const HtmlRenderThemeContext = createContext<HtmlRenderThemes | null>(null);

/**
 * Built once at the root from palette and font settings, not computed styles,
 * so every frame shares one snapshot and none reads a stale palette.
 */
export function HtmlRenderThemeProvider(props: {
  readonly palette: ThemePalette;
  readonly settings: Pick<AppearanceSettings, "uiFontFamily" | "monoFontFamily">;
  readonly appearance: ThemeVariant;
  readonly children: ReactNode;
}) {
  const { palette, appearance } = props;
  const sans = fontFamilyStack(props.settings.uiFontFamily, DEFAULT_UI_FONT_STACK);
  const mono = fontFamilyStack(props.settings.monoFontFamily, DEFAULT_MONO_FONT_STACK);
  const revision = `${themePaletteRevision(palette, "light")}\n${themePaletteRevision(palette, "dark")}`;
  // The revisions stand in for the palette, which is rebuilt on unrelated settings writes.
  const themes = useMemo(() => buildThemes(palette, { sans, mono }), [revision, sans, mono]);
  const value = useMemo(() => ({ appearance, ...themes }), [appearance, themes]);
  return createElement(HtmlRenderThemeContext.Provider, { value }, props.children);
}

/** Both appearances, for requests that name their own, such as desktop previews. */
export function useHtmlRenderThemes(): HtmlRenderThemes {
  return useContext(HtmlRenderThemeContext) ?? fallbackThemes();
}

export function useHtmlRenderTheme(): HtmlRenderTheme {
  const themes = useHtmlRenderThemes();
  return themes[themes.appearance];
}
