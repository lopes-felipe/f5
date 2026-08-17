import {
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  parseCustomThemeLibrary,
  parseThemeDefinitionV1,
  type ThemeDefinitionV1,
  type ThemePalette,
} from "./themePalette";
import { randomUUID } from "./lib/utils";

function rawThemeId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

export function addCustomTheme(
  rawThemes: readonly unknown[],
  definition: ThemeDefinitionV1,
): readonly unknown[] {
  const valid = parseCustomThemeLibrary(rawThemes);
  if (valid.themes.length >= MAX_CUSTOM_THEMES) {
    throw new Error(`F5 supports at most ${MAX_CUSTOM_THEMES} custom themes.`);
  }
  const parsed = parseThemeDefinitionV1(definition);
  const candidate = parseCustomThemeLibrary([parsed]);
  if (candidate.themes.length !== 1) {
    throw new Error(candidate.issues[0]?.message ?? "Theme cannot be added.");
  }
  if (valid.themes.some((theme) => theme.id === parsed.id)) {
    throw new Error(`A theme with id “${parsed.id}” already exists.`);
  }
  return [...rawThemes, parsed];
}

export function updateCustomTheme(
  rawThemes: readonly unknown[],
  definition: ThemeDefinitionV1,
): readonly unknown[] {
  const parsed = parseThemeDefinitionV1(definition);
  const candidate = parseCustomThemeLibrary([parsed]);
  if (candidate.themes.length !== 1) {
    throw new Error(candidate.issues[0]?.message ?? "Theme cannot be updated.");
  }
  let replaced = false;
  const next = rawThemes.map((value) => {
    if (!replaced && rawThemeId(value) === parsed.id) {
      replaced = true;
      return parsed;
    }
    return value;
  });
  if (!replaced) throw new Error(`Custom theme “${parsed.id}” no longer exists.`);
  return next;
}

export function removeCustomTheme(rawThemes: readonly unknown[], id: string): readonly unknown[] {
  return rawThemes.filter((value) => rawThemeId(value) !== id);
}

export function duplicateThemeDefinition(palette: ThemePalette): ThemeDefinitionV1 {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  return parseThemeDefinitionV1({
    version: 1,
    id: `custom-${palette.id.replace(/^f5-/, "").slice(0, 38)}-${suffix}`,
    name: `${palette.name} copy`.slice(0, 80),
    parameters: palette.definition?.parameters ?? { baseHue: 264, chroma: 0.16, contrast: 1 },
    overrides: palette.definition?.overrides,
  });
}

export function resolveThemeIdAfterRemoval(selectedThemeId: string, removedId: string): string {
  return selectedThemeId === removedId ? DEFAULT_THEME_ID : selectedThemeId;
}
