import {
  converter,
  formatCss,
  formatHex,
  formatHex8,
  interpolate,
  parse,
  wcagContrast,
} from "culori";

export const THEME_DEFINITION_VERSION = 1 as const;
export const DEFAULT_THEME_ID = "f5-black";
export const MAX_CUSTOM_THEMES = 20;
export const MAX_THEME_DEFINITION_BYTES = 64 * 1024;
export const MIN_BODY_TEXT_CONTRAST = 4.5;
export const MIN_DECORATIVE_CONTRAST = 3;

export const THEME_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
] as const;

/**
 * Tokens computed from every theme after overrides merge. They are not
 * user-overridable, so custom and imported VS Code themes always get them.
 */
export const DERIVED_THEME_TOKEN_NAMES = [
  "faint-foreground",
  "attention",
  "attention-foreground",
  "chrome",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type DerivedThemeTokenName = (typeof DERIVED_THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;
export type DerivedThemeTokens = Readonly<Record<DerivedThemeTokenName, string>>;
export type ResolvedThemeTokens = ThemeTokens & DerivedThemeTokens;
export type ThemeVariant = "light" | "dark";

export interface ThemeParameters {
  readonly baseHue: number;
  readonly chroma: number;
  readonly contrast: number;
}

export interface ThemeDefinitionV1 {
  readonly version: typeof THEME_DEFINITION_VERSION;
  readonly id: string;
  readonly name: string;
  readonly parameters: ThemeParameters;
  readonly overrides?: {
    readonly light?: Readonly<Partial<Record<ThemeTokenName, string>>>;
    readonly dark?: Readonly<Partial<Record<ThemeTokenName, string>>>;
  };
}

export interface ThemePalette {
  readonly id: string;
  readonly name: string;
  readonly light: ResolvedThemeTokens;
  readonly dark: ResolvedThemeTokens;
  readonly builtin: boolean;
  readonly definition?: ThemeDefinitionV1;
}

export interface ThemeDefinitionIssue {
  readonly index: number;
  readonly message: string;
}

export interface ParsedThemeLibrary {
  readonly themes: readonly ThemeDefinitionV1[];
  readonly issues: readonly ThemeDefinitionIssue[];
}

const THEME_TOKEN_SET = new Set<string>(THEME_TOKEN_NAMES);
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_COLOR_MAX_LENGTH = 128;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function oklch(lightness: number, chroma: number, hue: number): string {
  return `oklch(${round(clamp(lightness, 0, 1))} ${round(clamp(chroma, 0, 0.4))} ${round(
    ((hue % 360) + 360) % 360,
    2,
  )})`;
}

function semanticChromaFor(chroma: number): number {
  return Math.max(0.13, Math.min(chroma, 0.22));
}

export function normalizeThemeParameters(value: ThemeParameters): ThemeParameters {
  return {
    baseHue: round(((value.baseHue % 360) + 360) % 360, 2),
    chroma: round(clamp(value.chroma, 0.02, 0.3), 4),
    contrast: round(clamp(value.contrast, 0.75, 1.25), 3),
  };
}

export function generateThemeTokens(
  parameters: ThemeParameters,
  variant: ThemeVariant,
): ThemeTokens {
  const { baseHue: hue, chroma, contrast } = normalizeThemeParameters(parameters);
  const surfaceChroma = Math.min(chroma * 0.08, 0.018);
  const subtleChroma = Math.min(chroma * 0.18, 0.038);
  const foregroundChroma = Math.min(chroma * 0.14, 0.03);
  const semanticChroma = semanticChromaFor(chroma);

  if (variant === "light") {
    const foregroundLightness = clamp(0.27 - (contrast - 1) * 0.18, 0.18, 0.32);
    const mutedForegroundLightness = clamp(0.49 - (contrast - 1) * 0.12, 0.4, 0.56);
    return {
      background: oklch(0.985, surfaceChroma, hue),
      foreground: oklch(foregroundLightness, foregroundChroma, hue),
      card: oklch(0.997, surfaceChroma * 0.35, hue),
      "card-foreground": oklch(foregroundLightness, foregroundChroma, hue),
      popover: oklch(0.997, surfaceChroma * 0.35, hue),
      "popover-foreground": oklch(foregroundLightness, foregroundChroma, hue),
      primary: oklch(clamp(0.5 - (contrast - 1) * 0.08, 0.43, 0.55), chroma, hue),
      "primary-foreground": oklch(0.99, surfaceChroma * 0.2, hue),
      secondary: oklch(0.955, subtleChroma, hue),
      "secondary-foreground": oklch(foregroundLightness, foregroundChroma, hue),
      muted: oklch(0.955, subtleChroma * 0.7, hue),
      "muted-foreground": oklch(mutedForegroundLightness, foregroundChroma, hue),
      accent: oklch(0.94, subtleChroma * 1.15, hue),
      "accent-foreground": oklch(foregroundLightness, foregroundChroma, hue),
      destructive: oklch(0.59, semanticChroma, 27),
      // Coloured text on neutral surfaces; on-fill pairs use white text.
      "destructive-foreground": oklch(0.45, semanticChroma, 27),
      border: oklch(0.885, subtleChroma * 0.65, hue),
      input: oklch(0.84, subtleChroma * 0.8, hue),
      ring: oklch(0.52, chroma, hue),
      info: oklch(0.61, semanticChroma, 250),
      "info-foreground": oklch(0.43, semanticChroma, 250),
      success: oklch(0.62, semanticChroma, 152),
      "success-foreground": oklch(0.41, semanticChroma, 152),
      warning: oklch(0.72, semanticChroma, 75),
      "warning-foreground": oklch(0.45, semanticChroma, 75),
    };
  }

  const foregroundLightness = clamp(0.91 + (contrast - 1) * 0.12, 0.86, 0.97);
  const mutedForegroundLightness = clamp(0.69 + (contrast - 1) * 0.1, 0.62, 0.78);
  return {
    background: oklch(0.155, surfaceChroma, hue),
    foreground: oklch(foregroundLightness, foregroundChroma, hue),
    card: oklch(0.185, surfaceChroma * 1.1, hue),
    "card-foreground": oklch(foregroundLightness, foregroundChroma, hue),
    popover: oklch(0.195, surfaceChroma * 1.2, hue),
    "popover-foreground": oklch(foregroundLightness, foregroundChroma, hue),
    primary: oklch(clamp(0.7 + (contrast - 1) * 0.08, 0.64, 0.77), chroma * 0.88, hue),
    "primary-foreground": oklch(0.16, surfaceChroma, hue),
    secondary: oklch(0.235, subtleChroma, hue),
    "secondary-foreground": oklch(foregroundLightness, foregroundChroma, hue),
    muted: oklch(0.225, subtleChroma * 0.7, hue),
    "muted-foreground": oklch(mutedForegroundLightness, foregroundChroma, hue),
    accent: oklch(0.27, subtleChroma * 1.2, hue),
    "accent-foreground": oklch(foregroundLightness, foregroundChroma, hue),
    destructive: oklch(0.68, semanticChroma, 27),
    "destructive-foreground": oklch(0.78, semanticChroma * 0.7, 27),
    border: oklch(0.305, subtleChroma * 0.8, hue),
    input: oklch(0.35, subtleChroma, hue),
    ring: oklch(0.7, chroma * 0.88, hue),
    info: oklch(0.72, semanticChroma, 250),
    "info-foreground": oklch(0.78, semanticChroma * 0.7, 250),
    success: oklch(0.72, semanticChroma, 152),
    "success-foreground": oklch(0.79, semanticChroma * 0.7, 152),
    warning: oklch(0.78, semanticChroma, 75),
    "warning-foreground": oklch(0.82, semanticChroma * 0.65, 75),
  };
}

const FAINT_FOREGROUND_MAX_BLEND = 0.6;
const CHROME_LIGHTNESS_DELTA: Record<ThemeVariant, number> = { light: 0.05, dark: 0.037 };
const toOklch = converter("oklch");

function safeContrast(foreground: string, background: string): number {
  const value = wcagContrast(foreground, background);
  return Number.isFinite(value) ? value : 0;
}

/**
 * `faint-foreground`: blend `muted-foreground` toward `background` in oklab and
 * keep the largest blend (capped at 0.6) that still holds 3:1 against the
 * background, card and accent surfaces. Non-text use only (icons, separators).
 */
function deriveFaintForeground(
  tokens: Pick<ThemeTokens, "muted-foreground" | "background" | "card" | "accent">,
): string {
  const surfaces = [tokens.background, tokens.card, tokens.accent];
  let mix: ((t: number) => unknown) | null = null;
  try {
    mix = interpolate([tokens["muted-foreground"], tokens.background], "oklab");
  } catch {
    return tokens["muted-foreground"];
  }
  const colorAt = (t: number) => formatCss(mix!(t) as Parameters<typeof formatCss>[0]) ?? "";
  const passes = (t: number) => {
    const candidate = colorAt(t);
    return (
      candidate !== "" &&
      surfaces.every((surface) => safeContrast(candidate, surface) >= MIN_DECORATIVE_CONTRAST)
    );
  };
  if (!passes(0)) return tokens["muted-foreground"];
  if (passes(FAINT_FOREGROUND_MAX_BLEND)) return colorAt(FAINT_FOREGROUND_MAX_BLEND);
  let low = 0;
  let high = FAINT_FOREGROUND_MAX_BLEND;
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    if (passes(middle)) low = middle;
    else high = middle;
  }
  return colorAt(low);
}

function deriveChrome(background: string, variant: ThemeVariant): string {
  const parsed = toOklch(parse(background));
  if (!parsed) return background;
  return oklch(parsed.l - CHROME_LIGHTNESS_DELTA[variant], parsed.c ?? 0, parsed.h ?? 0);
}

/**
 * Derived tokens for a merged (generated + overridden) token set. Exported for
 * tests; `paletteFromDefinition` is the only production caller.
 */
export function deriveThemeTokens(
  parameters: ThemeParameters,
  variant: ThemeVariant,
  merged: ThemeTokens,
): DerivedThemeTokens {
  const semanticChroma = semanticChromaFor(normalizeThemeParameters(parameters).chroma);
  return {
    "faint-foreground": deriveFaintForeground(merged),
    attention:
      variant === "light" ? oklch(0.58, semanticChroma, 300) : oklch(0.72, semanticChroma, 300),
    "attention-foreground":
      variant === "light"
        ? oklch(0.42, semanticChroma, 300)
        : oklch(0.8, semanticChroma * 0.7, 300),
    chrome: deriveChrome(merged.background, variant),
  };
}

function resolveVariantTokens(
  definition: ThemeDefinitionV1,
  variant: ThemeVariant,
): ResolvedThemeTokens {
  const merged: ThemeTokens = {
    ...generateThemeTokens(definition.parameters, variant),
    ...definition.overrides?.[variant],
  };
  return { ...merged, ...deriveThemeTokens(definition.parameters, variant, merged) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function parseSafeThemeColor(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Theme colors must be strings.");
  }
  const color = value.trim();
  const parsed = color ? parse(color) : undefined;
  if (!color || color.length > SAFE_COLOR_MAX_LENGTH || !parsed) {
    throw new Error(`Invalid theme color: ${color || "(empty)"}.`);
  }
  return parsed.alpha !== undefined && parsed.alpha < 1 ? formatHex8(parsed) : formatHex(parsed);
}

function parseThemeOverrides(value: unknown): ThemeDefinitionV1["overrides"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["light", "dark"]))) {
    throw new Error("Theme overrides may contain only light and dark variants.");
  }

  const result: {
    light?: Partial<Record<ThemeTokenName, string>>;
    dark?: Partial<Record<ThemeTokenName, string>>;
  } = {};
  for (const variant of ["light", "dark"] as const) {
    const candidate = value[variant];
    if (candidate === undefined) continue;
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, THEME_TOKEN_SET)) {
      throw new Error(`Unknown ${variant} theme token.`);
    }
    result[variant] = Object.fromEntries(
      Object.entries(candidate).map(([token, color]) => [token, parseSafeThemeColor(color)]),
    );
  }
  return result;
}

export function parseThemeDefinitionV1(value: unknown): ThemeDefinitionV1 {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized ?? "").byteLength > MAX_THEME_DEFINITION_BYTES) {
    throw new Error("Theme definition exceeds 64 KiB.");
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["version", "id", "name", "parameters", "overrides"]))
  ) {
    throw new Error("Theme definition contains unknown fields.");
  }
  if (value.version !== THEME_DEFINITION_VERSION) {
    throw new Error(`Unsupported theme version: ${String(value.version)}.`);
  }
  if (typeof value.id !== "string" || !THEME_ID_PATTERN.test(value.id)) {
    throw new Error("Theme id must use 1–64 lowercase letters, numbers, or hyphens.");
  }
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80) {
    throw new Error("Theme name must contain 1–80 characters.");
  }
  if (!isRecord(value.parameters)) {
    throw new Error("Theme parameters are required.");
  }
  if (!hasOnlyKeys(value.parameters, new Set(["baseHue", "chroma", "contrast"]))) {
    throw new Error("Theme parameters contain unknown fields.");
  }
  const parameters = normalizeThemeParameters({
    baseHue: parseFiniteNumber(value.parameters.baseHue, "Base hue"),
    chroma: parseFiniteNumber(value.parameters.chroma, "Chroma"),
    contrast: parseFiniteNumber(value.parameters.contrast, "Contrast"),
  });
  const overrides = parseThemeOverrides(value.overrides);
  return {
    version: THEME_DEFINITION_VERSION,
    id: value.id,
    name: value.name.trim(),
    parameters,
    ...(overrides ? { overrides } : {}),
  };
}

export function parseCustomThemeLibrary(value: unknown): ParsedThemeLibrary {
  if (!Array.isArray(value)) {
    return { themes: [], issues: [{ index: -1, message: "Custom themes must be an array." }] };
  }

  const themes: ThemeDefinitionV1[] = [];
  const issues: ThemeDefinitionIssue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (themes.length >= MAX_CUSTOM_THEMES) {
      issues.push({
        index,
        message: `Only the first ${MAX_CUSTOM_THEMES} valid themes are active.`,
      });
      continue;
    }
    try {
      const definition = parseThemeDefinitionV1(value[index]);
      if (definition.id === DEFAULT_THEME_ID || BUILTIN_THEME_BY_ID.has(definition.id)) {
        throw new Error(`Theme id “${definition.id}” is reserved.`);
      }
      if (seen.has(definition.id)) {
        throw new Error(`Duplicate theme id “${definition.id}”.`);
      }
      seen.add(definition.id);
      themes.push(definition);
    } catch (error) {
      issues.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { themes, issues };
}

function paletteFromDefinition(definition: ThemeDefinitionV1, builtin: boolean): ThemePalette {
  return {
    id: definition.id,
    name: definition.name,
    light: resolveVariantTokens(definition, "light"),
    dark: resolveVariantTokens(definition, "dark"),
    builtin,
    definition,
  };
}

const BUILTIN_THEME_DEFINITIONS: readonly ThemeDefinitionV1[] = [
  {
    version: THEME_DEFINITION_VERSION,
    id: DEFAULT_THEME_ID,
    // Graphite + Cobalt (docs/design/direction.md). The id predates the
    // redesign and stays so stored settings keep pointing at the default.
    name: "F5 Graphite",
    parameters: normalizeThemeParameters({ baseHue: 262, chroma: 0.16, contrast: 1 }),
    overrides: {
      light: {
        background: "oklch(0.993 0.0015 260)",
        foreground: "oklch(0.21 0.008 260)",
        card: "oklch(1 0 0)",
        "card-foreground": "oklch(0.21 0.008 260)",
        popover: "oklch(1 0 0)",
        "popover-foreground": "oklch(0.21 0.008 260)",
        primary: "oklch(0.52 0.2 262)",
        "primary-foreground": "oklch(0.99 0 0)",
        secondary: "oklch(0.962 0.004 260)",
        "secondary-foreground": "oklch(0.21 0.008 260)",
        muted: "oklch(0.965 0.003 260)",
        "muted-foreground": "oklch(0.5 0.012 260)",
        accent: "oklch(0.948 0.005 260)",
        "accent-foreground": "oklch(0.21 0.008 260)",
        border: "oklch(0.905 0.005 260)",
        input: "oklch(0.865 0.007 260)",
        ring: "oklch(0.56 0.2 262)",
      },
      dark: {
        background: "oklch(0.192 0.006 260)",
        foreground: "oklch(0.95 0.003 260)",
        card: "oklch(0.222 0.007 260)",
        "card-foreground": "oklch(0.95 0.003 260)",
        popover: "oklch(0.25 0.008 260)",
        "popover-foreground": "oklch(0.95 0.003 260)",
        primary: "oklch(0.56 0.2 262)",
        "primary-foreground": "oklch(0.99 0 0)",
        secondary: "oklch(0.255 0.007 260)",
        "secondary-foreground": "oklch(0.95 0.003 260)",
        muted: "oklch(0.24 0.006 260)",
        "muted-foreground": "oklch(0.69 0.01 260)",
        accent: "oklch(0.275 0.008 260)",
        "accent-foreground": "oklch(0.95 0.003 260)",
        border: "oklch(0.295 0.008 260)",
        input: "oklch(0.34 0.01 260)",
        ring: "oklch(0.68 0.17 262)",
      },
    },
  },
  {
    version: THEME_DEFINITION_VERSION,
    id: "f5-default",
    name: "F5 Blue",
    parameters: normalizeThemeParameters({ baseHue: 264, chroma: 0.185, contrast: 1 }),
  },
  {
    version: THEME_DEFINITION_VERSION,
    id: "f5-ocean",
    name: "Ocean",
    parameters: normalizeThemeParameters({ baseHue: 232, chroma: 0.16, contrast: 1.04 }),
  },
  {
    version: THEME_DEFINITION_VERSION,
    id: "f5-grove",
    name: "Grove",
    parameters: normalizeThemeParameters({ baseHue: 150, chroma: 0.145, contrast: 1.02 }),
  },
  {
    version: THEME_DEFINITION_VERSION,
    id: "f5-ember",
    name: "Ember",
    parameters: normalizeThemeParameters({ baseHue: 35, chroma: 0.17, contrast: 1.04 }),
  },
  {
    version: THEME_DEFINITION_VERSION,
    id: "f5-iris",
    name: "Iris",
    parameters: normalizeThemeParameters({ baseHue: 305, chroma: 0.17, contrast: 1.02 }),
  },
];

export const BUILTIN_THEME_PALETTES: readonly ThemePalette[] = BUILTIN_THEME_DEFINITIONS.map(
  (theme) => paletteFromDefinition(theme, true),
);

const BUILTIN_THEME_BY_ID = new Map(BUILTIN_THEME_PALETTES.map((theme) => [theme.id, theme]));

export function getAvailableThemePalettes(customThemes: unknown): readonly ThemePalette[] {
  return [
    ...BUILTIN_THEME_PALETTES,
    ...parseCustomThemeLibrary(customThemes).themes.map((theme) =>
      paletteFromDefinition(theme, false),
    ),
  ];
}

export function resolveThemePalette(themeId: unknown, customThemes: unknown): ThemePalette {
  const palettes = getAvailableThemePalettes(customThemes);
  return (
    palettes.find((theme) => theme.id === themeId) ??
    BUILTIN_THEME_BY_ID.get(DEFAULT_THEME_ID) ??
    palettes[0]!
  );
}

export function applyThemePalette(
  root: HTMLElement,
  palette: ThemePalette,
  variant: ThemeVariant,
): void {
  const tokens = palette[variant];
  for (const token of THEME_TOKEN_NAMES) {
    root.style.setProperty(`--${token}`, tokens[token]);
  }
  for (const token of DERIVED_THEME_TOKEN_NAMES) {
    root.style.setProperty(`--${token}`, tokens[token]);
  }
  root.dataset.themeId = palette.id;
  root.style.colorScheme = variant;
}

export function themePaletteRevision(palette: ThemePalette, variant: ThemeVariant): string {
  return `${palette.id}:${variant}:${[...THEME_TOKEN_NAMES, ...DERIVED_THEME_TOKEN_NAMES]
    .map((token) => palette[variant][token])
    .join(";")}`;
}

export function bodyTextContrast(palette: ThemePalette, variant: ThemeVariant): number {
  return wcagContrast(palette[variant].foreground, palette[variant].background);
}

type ContrastPair = readonly [
  label: string,
  foreground: keyof ResolvedThemeTokens,
  background: keyof ResolvedThemeTokens,
  minimum: number,
];

const CONTRAST_PAIRS: ReadonlyArray<ContrastPair> = [
  ["body text", "foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["primary button", "primary-foreground", "primary", MIN_BODY_TEXT_CONTRAST],
  ["destructive text", "destructive-foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["secondary text", "muted-foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["secondary text on cards", "muted-foreground", "card", MIN_BODY_TEXT_CONTRAST],
  ["secondary text on hover", "muted-foreground", "accent", MIN_BODY_TEXT_CONTRAST],
  ["info text", "info-foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["success text", "success-foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["warning text", "warning-foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["attention text", "attention-foreground", "background", MIN_BODY_TEXT_CONTRAST],
  ["decorative icons", "faint-foreground", "background", MIN_DECORATIVE_CONTRAST],
];

export function getThemeContrastWarnings(palette: ThemePalette): readonly string[] {
  const warnings: string[] = [];
  for (const variant of ["light", "dark"] as const) {
    for (const [label, foreground, background, minimum] of CONTRAST_PAIRS) {
      const contrast = wcagContrast(palette[variant][foreground], palette[variant][background]);
      if (!Number.isFinite(contrast) || contrast < minimum) {
        warnings.push(
          `${variant === "light" ? "Light" : "Dark"} ${label} contrast is ${contrast.toFixed(
            2,
          )}:1; WCAG AA requires ${minimum}:1.`,
        );
      }
    }
  }
  return warnings;
}

export function createCustomThemeDefinition(input: {
  readonly id: string;
  readonly name: string;
  readonly parameters: ThemeParameters;
  readonly overrides?: ThemeDefinitionV1["overrides"];
}): ThemeDefinitionV1 {
  return parseThemeDefinitionV1({ version: 1, ...input });
}
