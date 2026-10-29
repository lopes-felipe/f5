import { converter, formatHex, parse, wcagContrast } from "culori";
import { strFromU8, unzipSync } from "fflate";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import {
  createCustomThemeDefinition,
  generateThemeTokens,
  MAX_THEME_DEFINITION_BYTES,
  parseSafeThemeColor,
  parseThemeDefinitionV1,
  type ThemeDefinitionV1,
  type ThemeParameters,
  type ThemeTokenName,
  type ThemeVariant,
} from "./themePalette";
import { randomUUID } from "./lib/utils";

export const MAX_THEME_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_VSCODE_THEME_BYTES = 1024 * 1024;
const MAX_VSIX_PACKAGE_BYTES = 256 * 1024;
/**
 * Focus rings, switch tracks and input borders must clear this contrast floor
 * against every surface or state they sit next to, or they disappear.
 */
const MIN_CONTROL_SEPARATION = 1.1;
const decoder = new TextDecoder();
const toOklch = converter("oklch");
const toRgb = converter("rgb");

interface VsCodeThemeDocument {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly colors?: unknown;
  readonly tokenColors?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonDocument(text: string, label: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || value === undefined) {
    throw new Error(`${label} is not valid JSON or JSONC.`);
  }
  return value;
}

function sanitizeThemeId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  return `custom-${slug || "theme"}-${suffix}`;
}

function readSafeColor(value: unknown): string | undefined {
  try {
    return parseSafeThemeColor(value);
  } catch {
    return undefined;
  }
}

const VSCODE_COLOR_TOKEN_MAP = {
  "editor.background": ["background", "card"],
  "editor.foreground": ["foreground", "card-foreground"],
  "editorWidget.background": ["popover"],
  "editorWidget.foreground": ["popover-foreground"],
  "sideBar.background": ["secondary", "muted"],
  "sideBar.foreground": ["secondary-foreground"],
  descriptionForeground: ["muted-foreground"],
  "editorGroupHeader.tabsBackground": ["muted"],
  "editor.selectionBackground": ["accent"],
  "editor.selectionForeground": ["accent-foreground"],
  "button.foreground": ["primary-foreground"],
  "panel.border": ["border"],
  errorForeground: ["destructive", "destructive-foreground"],
} as const satisfies Readonly<Record<string, readonly ThemeTokenName[]>>;

function scopesFromTokenColor(value: unknown): readonly string[] {
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim());
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

interface MappedTokenColors {
  readonly overrides: Partial<Record<ThemeTokenName, string>>;
  /** The keyword color, an accent candidate for `primary` and `ring`. */
  readonly keyword: string | undefined;
}

function mapTokenColors(value: unknown): MappedTokenColors {
  if (!Array.isArray(value)) return { overrides: {}, keyword: undefined };
  const mapped: Partial<Record<ThemeTokenName, string>> = {};
  let keyword: string | undefined;
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue;
    const color = readSafeColor(entry.settings.foreground);
    if (!color) continue;
    const scopes = scopesFromTokenColor(entry.scope);
    if (scopes.some((scope) => scope === "comment" || scope.startsWith("comment."))) {
      mapped["muted-foreground"] ??= color;
    }
    if (scopes.some((scope) => scope.includes("keyword") || scope.includes("storage.type"))) {
      keyword ??= color;
    }
    if (scopes.some((scope) => scope.includes("string"))) {
      mapped.success ??= color;
      mapped["success-foreground"] ??= color;
    }
  }
  return { overrides: mapped, keyword };
}

/** Composites a translucent color over an opaque backdrop. */
function flattenOver(color: string, backdrop: string): string {
  const top = toRgb(parse(color));
  const bottom = toRgb(parse(backdrop));
  const alpha = top?.alpha ?? 1;
  if (!top || !bottom || alpha >= 1) return color;
  const blend = (front: number, back: number) => front * alpha + back * (1 - alpha);
  return formatHex({
    mode: "rgb",
    r: blend(top.r, bottom.r),
    g: blend(top.g, bottom.g),
    b: blend(top.b, bottom.b),
  });
}

function standsApart(color: string, surfaces: readonly (string | undefined)[]): boolean {
  return surfaces.every(
    (surface) => surface === undefined || wcagContrast(color, surface) >= MIN_CONTROL_SEPARATION,
  );
}

/**
 * The first candidate that, once flattened over `canvas`, stays distinct from
 * every listed surface. Unset surfaces are skipped.
 */
function firstApart(
  candidates: readonly (string | undefined)[],
  canvas: string,
  surfaces: readonly (string | undefined)[],
): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const flattened = flattenOver(candidate, canvas);
    if (standsApart(flattened, surfaces)) return flattened;
  }
  return undefined;
}

function baseParametersFromSeed(seed: string | undefined): ThemeParameters {
  const parsed = seed ? parse(seed) : undefined;
  const converted = parsed ? toOklch(parsed) : undefined;
  return {
    baseHue: typeof converted?.h === "number" ? converted.h : 264,
    chroma: typeof converted?.c === "number" ? Math.max(0.06, Math.min(0.24, converted.c)) : 0.16,
    contrast: 1,
  };
}

interface ControlColorSources {
  readonly keyword: string | undefined;
  readonly focusBorder: string | undefined;
  readonly buttonBackground: string | undefined;
  readonly inputBackground: string | undefined;
  readonly inputBorder: string | undefined;
}

type ControlTokenName = "primary" | "ring" | "input";

/**
 * Resolves `ring` (focus), `primary` (checked switch track) and `input`
 * (unchecked switch track, input borders). VS Code themes often set these
 * workbench keys to transparent or to the editor background, so an authored
 * color is accepted only when it stays distinct from the surfaces next to it;
 * otherwise the next candidate, then the generated value, then black or white.
 */
function resolveControlColors(
  surfaces: Readonly<Partial<Record<ThemeTokenName, string>>>,
  variant: ThemeVariant,
  sources: ControlColorSources,
): {
  readonly parameters: ThemeParameters;
  readonly controls: Partial<Record<ControlTokenName, string>>;
} {
  // The generated background's lightness does not depend on hue or chroma, so
  // any parameters give a usable stand-in when the file sets no background.
  const fallbackCanvas = generateThemeTokens(baseParametersFromSeed(undefined), variant).background;
  const canvas = surfaces.background
    ? flattenOver(surfaces.background, fallbackCanvas)
    : fallbackCanvas;
  const raised = surfaces.popover ? flattenOver(surfaces.popover, canvas) : undefined;
  const accentSurfaces = [canvas, raised];

  const ring = firstApart(
    [sources.keyword, sources.focusBorder, sources.buttonBackground],
    canvas,
    accentSurfaces,
  );
  const primary = firstApart([sources.keyword, sources.buttonBackground], canvas, accentSurfaces);
  const parameters = baseParametersFromSeed(primary ?? ring);
  const generated = generateThemeTokens(parameters, variant);

  const controls: Partial<Record<ControlTokenName, string>> = {};
  if (ring) controls.ring = ring;
  else if (!standsApart(generated.ring, accentSurfaces)) {
    controls.ring = firstApart(["#ffffff", "#000000"], canvas, accentSurfaces) ?? "#ffffff";
  }
  if (primary) controls.primary = primary;
  else if (!standsApart(generated.primary, accentSurfaces)) {
    controls.primary = controls.ring ?? generated.ring;
  }

  const inputSurfaces = [canvas, controls.primary ?? generated.primary];
  const input = firstApart([sources.inputBackground, sources.inputBorder], canvas, inputSurfaces);
  if (input) controls.input = input;
  else if (!standsApart(generated.input, inputSurfaces)) {
    controls.input =
      firstApart([generated.border, "#000000", "#ffffff"], canvas, inputSurfaces) ?? "#808080";
  }
  return { parameters, controls };
}

export function importVsCodeThemeDocument(
  value: unknown,
  fallbackName = "Imported VS Code theme",
): ThemeDefinitionV1 {
  if (!isRecord(value)) throw new Error("VS Code theme must be an object.");
  const document = value as VsCodeThemeDocument;
  const name =
    typeof document.name === "string" && document.name.trim()
      ? document.name.trim().slice(0, 80)
      : fallbackName.slice(0, 80);
  const colors = isRecord(document.colors) ? document.colors : {};
  const overrides: Partial<Record<ThemeTokenName, string>> = {};
  for (const [source, targets] of Object.entries(VSCODE_COLOR_TOKEN_MAP)) {
    const color = readSafeColor(colors[source]);
    if (!color) continue;
    for (const target of targets) overrides[target] = color;
  }
  const tokenColors = mapTokenColors(document.tokenColors);
  Object.assign(overrides, tokenColors.overrides);
  const controlSources: ControlColorSources = {
    keyword: tokenColors.keyword,
    focusBorder: readSafeColor(colors.focusBorder),
    buttonBackground: readSafeColor(colors["button.background"]),
    inputBackground: readSafeColor(colors["input.background"]),
    inputBorder: readSafeColor(colors["input.border"]),
  };
  if (
    Object.keys(overrides).length === 0 &&
    Object.values(controlSources).every((color) => color === undefined)
  ) {
    throw new Error("The VS Code theme has no supported color or token-color entries.");
  }
  const variant = document.type === "light" || document.type === "hcLight" ? "light" : "dark";
  const { parameters, controls } = resolveControlColors(overrides, variant, controlSources);
  return createCustomThemeDefinition({
    id: sanitizeThemeId(name),
    name,
    parameters,
    overrides: { [variant]: { ...overrides, ...controls } },
  });
}

function readZipEntry(bytes: Uint8Array, expectedName: string, maximumBytes: number): Uint8Array {
  let rejectedForSize = false;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name !== expectedName) return false;
      if (entry.originalSize > maximumBytes) {
        rejectedForSize = true;
        return false;
      }
      return true;
    },
  });
  if (rejectedForSize) throw new Error(`${expectedName} exceeds the import size limit.`);
  const entry = entries[expectedName];
  if (!entry) throw new Error(`VSIX is missing ${expectedName}.`);
  return entry;
}

function normalizeVsixThemePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("VSIX theme contribution has no path.");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error("VSIX theme path is unsafe.");
  }
  return `extension/${normalized}`;
}

function importVsix(bytes: Uint8Array, fallbackName: string): ThemeDefinitionV1 {
  const manifestBytes = readZipEntry(bytes, "extension/package.json", MAX_VSIX_PACKAGE_BYTES);
  const manifest = parseJsonDocument(strFromU8(manifestBytes), "VSIX package.json");
  if (!isRecord(manifest) || !isRecord(manifest.contributes)) {
    throw new Error("VSIX has no theme contribution.");
  }
  const themes = manifest.contributes.themes;
  if (!Array.isArray(themes) || themes.length === 0 || !isRecord(themes[0])) {
    throw new Error("VSIX has no theme contribution.");
  }
  const themeEntry = themes[0];
  const themePath = normalizeVsixThemePath(themeEntry.path);
  const themeBytes = readZipEntry(bytes, themePath, MAX_VSCODE_THEME_BYTES);
  const label =
    typeof themeEntry.label === "string" && themeEntry.label.trim()
      ? themeEntry.label.trim()
      : fallbackName;
  return importVsCodeThemeDocument(parseJsonDocument(strFromU8(themeBytes), "VSIX theme"), label);
}

export async function importThemeFile(file: File): Promise<ThemeDefinitionV1> {
  if (file.size > MAX_THEME_IMPORT_BYTES) {
    throw new Error("Theme imports must be 10 MiB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fallbackName = file.name.replace(/\.(jsonc?|vsix)$/i, "").trim() || "Imported theme";
  if (file.name.toLowerCase().endsWith(".vsix")) return importVsix(bytes, fallbackName);
  if (bytes.byteLength > MAX_VSCODE_THEME_BYTES) {
    throw new Error("JSON theme imports must be 1 MiB or smaller.");
  }
  const value = parseJsonDocument(decoder.decode(bytes), "Theme file");
  try {
    return parseThemeDefinitionV1(value);
  } catch (definitionError) {
    try {
      return importVsCodeThemeDocument(value, fallbackName);
    } catch {
      throw definitionError;
    }
  }
}

export function exportThemeDefinition(definition: ThemeDefinitionV1): Blob {
  const serialized = `${JSON.stringify(definition, null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_THEME_DEFINITION_BYTES) {
    throw new Error("Theme definition exceeds 64 KiB.");
  }
  return new Blob([serialized], { type: "application/json" });
}
