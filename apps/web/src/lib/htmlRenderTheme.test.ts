import { formatHex, interpolate, wcagContrast } from "culori";
import { HTML_RENDER_CHART_COLORS } from "@t3tools/shared/htmlRender";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_PALETTES,
  createCustomThemeDefinition,
  resolveThemePalette,
  THEME_TOKEN_NAMES,
} from "../themePalette";
import { htmlRenderThemeFromPalette } from "./htmlRenderTheme";

const fonts = { sans: '"Inter", sans-serif', mono: '"JetBrains Mono", monospace' };

describe("htmlRenderThemeFromPalette", () => {
  for (const palette of BUILTIN_THEME_PALETTES)
    for (const appearance of ["light", "dark"] as const)
      it(`gives ${palette.id} ${appearance} hex tokens and legible chart colors`, () => {
        const { variables } = htmlRenderThemeFromPalette(palette[appearance], appearance, fonts);
        for (const name of THEME_TOKEN_NAMES)
          expect(variables[`--${name}`], name).toMatch(/^#[0-9a-f]{6}$/);
        for (let index = 1; index <= 6; index++) {
          const chart = variables[`--chart-${index}`]!;
          expect(chart).toMatch(/^#[0-9a-f]{6}$/);
          expect(wcagContrast(chart, variables["--background"]!)).toBeGreaterThanOrEqual(3);
        }
        expect(variables).toMatchObject({
          "--radius": "12px",
          "--font-sans": fonts.sans,
          "--font-mono": fonts.mono,
        });
      });

  it("starts the chart series with the accent and keeps the fixed hue order", () => {
    const palette = BUILTIN_THEME_PALETTES[0]!;
    const { variables } = htmlRenderThemeFromPalette(palette.dark, "dark", fonts);
    expect(variables["--chart-1"]).toBe(variables["--primary"]);
    expect(HTML_RENDER_CHART_COLORS.dark).toContain(variables["--chart-2"]);
  });

  it("composites translucent tokens over the background", () => {
    const palette = BUILTIN_THEME_PALETTES[0]!;
    const tokens = { ...palette.light, background: "#ffffff", border: "rgb(0 0 0 / 25%)" };
    const { variables } = htmlRenderThemeFromPalette(tokens, "light", fonts);
    expect(variables["--border"]).toBe(formatHex(interpolate(["#000000", "#ffffff"])(0.75)));
  });

  it("raises a fixed chart color that would vanish on the background", () => {
    const palette = BUILTIN_THEME_PALETTES[0]!;
    const tokens = { ...palette.light, background: "#0d9488" };
    const { variables } = htmlRenderThemeFromPalette(tokens, "light", fonts);
    expect(wcagContrast(variables["--chart-2"]!, "#0d9488")).toBeGreaterThanOrEqual(3);
  });

  it("carries a custom theme override", () => {
    const definition = createCustomThemeDefinition({
      id: "mine",
      name: "Mine",
      parameters: { baseHue: 200, chroma: 0.1, contrast: 1 },
      overrides: { dark: { primary: "#ff00aa" } },
    });
    const palette = resolveThemePalette(definition.id, [definition]);
    const { variables } = htmlRenderThemeFromPalette(palette.dark, "dark", fonts);
    expect(variables["--primary"]).toBe("#ff00aa");
    expect(variables["--chart-1"]).toBe("#ff00aa");
  });
});
