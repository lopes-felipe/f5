import { converter, parse, wcagContrast } from "culori";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_THEME_PALETTES,
  CLASSIC_BLACK_THEME_ID,
  DEFAULT_THEME_ID,
  DERIVED_THEME_TOKEN_NAMES,
  MIN_BODY_TEXT_CONTRAST,
  MIN_DECORATIVE_CONTRAST,
  applyThemePalette,
  bodyTextContrast,
  createCustomThemeDefinition,
  deriveThemeTokens,
  generateThemeTokens,
  getAvailableThemePalettes,
  getThemeContrastWarnings,
  parseCustomThemeLibrary,
  parseThemeDefinitionV1,
  resolveThemePalette,
} from "./themePalette";

const toOklch = converter("oklch");

function hueOf(color: string): number {
  return toOklch(parse(color))?.h ?? Number.NaN;
}

function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

describe("derived theme tokens", () => {
  it("adds derived tokens to builtin and custom palettes without making them overridable", () => {
    const custom = createCustomThemeDefinition({
      id: "custom-derived",
      name: "Derived",
      parameters: { baseHue: 200, chroma: 0.12, contrast: 1 },
      overrides: { dark: { background: "#101218" } },
    });
    const palettes = getAvailableThemePalettes([custom]);
    for (const palette of palettes) {
      for (const variant of ["light", "dark"] as const) {
        for (const token of DERIVED_THEME_TOKEN_NAMES) {
          expect(palette[variant][token], `${palette.id} ${variant} ${token}`).toBeTruthy();
        }
      }
    }
    expect(() =>
      parseThemeDefinitionV1({ ...custom, overrides: { dark: { chrome: "#000000" } } }),
    ).toThrow("Unknown dark theme token");
  });

  it("keeps faint-foreground at 3:1 or better on every surface and caps the blend", () => {
    for (const palette of BUILTIN_THEME_PALETTES) {
      for (const variant of ["light", "dark"] as const) {
        const tokens = palette[variant];
        for (const surface of [tokens.background, tokens.card, tokens.accent]) {
          expect(
            wcagContrast(tokens["faint-foreground"], surface),
            `${palette.id} ${variant}`,
          ).toBeGreaterThanOrEqual(MIN_DECORATIVE_CONTRAST - 0.01);
        }
        // Faint never has more contrast than muted text (it is a blend toward the background).
        expect(wcagContrast(tokens["faint-foreground"], tokens.background)).toBeLessThanOrEqual(
          wcagContrast(tokens["muted-foreground"], tokens.background) + 0.01,
        );
      }
    }
  });

  it("falls back to muted-foreground when no blend can hold 3:1", () => {
    const parameters = { baseHue: 0, chroma: 0.05, contrast: 1 };
    const merged = {
      ...generateThemeTokens(parameters, "dark"),
      background: "#202020",
      card: "#202020",
      accent: "#202020",
      "muted-foreground": "#3a3a3a",
    };
    expect(deriveThemeTokens(parameters, "dark", merged)["faint-foreground"]).toBe("#3a3a3a");
  });

  it("derives chrome one step deeper than the canvas", () => {
    for (const palette of BUILTIN_THEME_PALETTES) {
      for (const variant of ["light", "dark"] as const) {
        const chrome = toOklch(parse(palette[variant].chrome))!.l;
        const canvas = toOklch(parse(palette[variant].background))!.l;
        expect(chrome, `${palette.id} ${variant}`).toBeLessThan(canvas);
      }
    }
  });

  it("keeps status hues at least 45 degrees apart", () => {
    for (const palette of BUILTIN_THEME_PALETTES) {
      for (const variant of ["light", "dark"] as const) {
        const tokens = palette[variant];
        const hues = [
          tokens.info,
          tokens.success,
          tokens.warning,
          tokens.destructive,
          tokens.attention,
        ].map(hueOf);
        for (let i = 0; i < hues.length; i += 1) {
          for (let j = i + 1; j < hues.length; j += 1) {
            expect(
              hueDistance(hues[i]!, hues[j]!),
              `${palette.id} ${variant}`,
            ).toBeGreaterThanOrEqual(45);
          }
        }
      }
    }
  });

  it("generates destructive-foreground as coloured text, not on-fill text", () => {
    const parameters = { baseHue: 264, chroma: 0.185, contrast: 1 };
    for (const variant of ["light", "dark"] as const) {
      const tokens = generateThemeTokens(parameters, variant);
      expect(
        wcagContrast(tokens["destructive-foreground"], tokens.background),
      ).toBeGreaterThanOrEqual(MIN_BODY_TEXT_CONTRAST);
    }
  });
});

describe("theme palette registry", () => {
  it("generates distinct light and dark OKLCH palettes", () => {
    const parameters = { baseHue: 145, chroma: 0.16, contrast: 1.1 };
    const light = generateThemeTokens(parameters, "light");
    const dark = generateThemeTokens(parameters, "dark");

    expect(light.primary).toContain("oklch(");
    expect(dark.background).not.toBe(light.background);
    expect(light.primary).toContain("145");
  });

  it("keeps the pre-redesign default as F5 Black (classic) beside the Graphite default", () => {
    const graphite = resolveThemePalette(DEFAULT_THEME_ID, []);
    const classic = resolveThemePalette(CLASSIC_BLACK_THEME_ID, []);
    expect(graphite.name).toBe("F5 Graphite");
    expect(classic.id).toBe(CLASSIC_BLACK_THEME_ID);
    expect(classic.name).toBe("F5 Black (classic)");
    expect(classic.dark.background).toBe("#161616");
    expect(BUILTIN_THEME_PALETTES.map((palette) => palette.id)).toContain(CLASSIC_BLACK_THEME_ID);
  });

  it("keeps every built-in body-text pair above WCAG AA", () => {
    for (const palette of BUILTIN_THEME_PALETTES) {
      expect(bodyTextContrast(palette, "light"), `${palette.name} light`).toBeGreaterThanOrEqual(
        MIN_BODY_TEXT_CONTRAST,
      );
      expect(bodyTextContrast(palette, "dark"), `${palette.name} dark`).toBeGreaterThanOrEqual(
        MIN_BODY_TEXT_CONTRAST,
      );
      expect(getThemeContrastWarnings(palette)).toEqual([]);
    }
  });

  it("allows only versioned definitions, known tokens, and parseable colors", () => {
    const valid = createCustomThemeDefinition({
      id: "custom-night",
      name: "Night",
      parameters: { baseHue: 250, chroma: 0.14, contrast: 1 },
      overrides: { dark: { background: "#101218" } },
    });
    expect(parseThemeDefinitionV1(valid)).toEqual(valid);

    expect(() =>
      parseThemeDefinitionV1({
        ...valid,
        overrides: { dark: { unknown: "#fff" } },
      }),
    ).toThrow("Unknown dark theme token");
    expect(() =>
      parseThemeDefinitionV1({
        ...valid,
        overrides: { dark: { background: "url(https://example.test/theme.png)" } },
      }),
    ).toThrow("Invalid theme color");
  });

  it("retains diagnostics while excluding invalid, duplicate, and reserved themes", () => {
    const valid = createCustomThemeDefinition({
      id: "custom-one",
      name: "One",
      parameters: { baseHue: 100, chroma: 0.1, contrast: 1 },
    });
    const parsed = parseCustomThemeLibrary([
      valid,
      { ...valid, name: "Duplicate" },
      { ...valid, id: DEFAULT_THEME_ID },
      { unexpected: true },
    ]);

    expect(parsed.themes).toEqual([valid]);
    expect(parsed.issues).toHaveLength(3);
  });

  it("falls back without mutating invalid source data and applies semantic variables", () => {
    const source = [{ broken: true }];
    const palette = resolveThemePalette("missing", source);
    const properties = new Map<string, string>();
    const root = {
      dataset: {},
      style: {
        colorScheme: "",
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;

    applyThemePalette(root, palette, "dark");

    expect(palette.id).toBe(DEFAULT_THEME_ID);
    expect(source).toEqual([{ broken: true }]);
    expect(properties.get("--background")).toBe(palette.dark.background);
    expect(properties.get("--chrome")).toBe(palette.dark.chrome);
    expect(properties.get("--faint-foreground")).toBe(palette.dark["faint-foreground"]);
    expect(root.dataset.themeId).toBe(DEFAULT_THEME_ID);
    expect(root.style.colorScheme).toBe("dark");
  });
});
