import { describe, expect, it } from "vitest";

import {
  BUILTIN_THEME_PALETTES,
  DEFAULT_THEME_ID,
  MIN_BODY_TEXT_CONTRAST,
  applyThemePalette,
  bodyTextContrast,
  createCustomThemeDefinition,
  generateThemeTokens,
  getThemeContrastWarnings,
  parseCustomThemeLibrary,
  parseThemeDefinitionV1,
  resolveThemePalette,
} from "./themePalette";

describe("theme palette registry", () => {
  it("generates distinct light and dark OKLCH palettes", () => {
    const parameters = { baseHue: 145, chroma: 0.16, contrast: 1.1 };
    const light = generateThemeTokens(parameters, "light");
    const dark = generateThemeTokens(parameters, "dark");

    expect(light.primary).toContain("oklch(");
    expect(dark.background).not.toBe(light.background);
    expect(light.primary).toContain("145");
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
    expect(root.dataset.themeId).toBe(DEFAULT_THEME_ID);
    expect(root.style.colorScheme).toBe("dark");
  });
});
