import { converter, parse } from "culori";
import { strFromU8, unzipSync } from "fflate";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import {
  createCustomThemeDefinition,
  MAX_THEME_DEFINITION_BYTES,
  parseSafeThemeColor,
  parseThemeDefinitionV1,
  type ThemeDefinitionV1,
  type ThemeTokenName,
} from "./themePalette";

export const MAX_THEME_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_VSCODE_THEME_BYTES = 1024 * 1024;
const MAX_VSIX_PACKAGE_BYTES = 256 * 1024;
const decoder = new TextDecoder();
const toOklch = converter("oklch");

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
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
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
  "button.background": ["primary", "ring"],
  "button.foreground": ["primary-foreground"],
  focusBorder: ["ring"],
  "panel.border": ["border"],
  "input.background": ["input"],
  errorForeground: ["destructive", "destructive-foreground"],
} as const satisfies Readonly<Record<string, readonly ThemeTokenName[]>>;

function scopesFromTokenColor(value: unknown): readonly string[] {
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim());
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function mapTokenColors(value: unknown): Partial<Record<ThemeTokenName, string>> {
  if (!Array.isArray(value)) return {};
  const mapped: Partial<Record<ThemeTokenName, string>> = {};
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue;
    const color = readSafeColor(entry.settings.foreground);
    if (!color) continue;
    const scopes = scopesFromTokenColor(entry.scope);
    if (scopes.some((scope) => scope === "comment" || scope.startsWith("comment."))) {
      mapped["muted-foreground"] ??= color;
    }
    if (scopes.some((scope) => scope.includes("keyword") || scope.includes("storage.type"))) {
      mapped.primary ??= color;
      mapped.ring ??= color;
    }
    if (scopes.some((scope) => scope.includes("string"))) {
      mapped.success ??= color;
      mapped["success-foreground"] ??= color;
    }
  }
  return mapped;
}

function baseParametersFromColors(colors: Readonly<Partial<Record<ThemeTokenName, string>>>): {
  baseHue: number;
  chroma: number;
  contrast: number;
} {
  const seed = colors.primary ?? colors.ring;
  const parsed = seed ? parse(seed) : undefined;
  const converted = parsed ? toOklch(parsed) : undefined;
  return {
    baseHue: typeof converted?.h === "number" ? converted.h : 264,
    chroma: typeof converted?.c === "number" ? Math.max(0.06, Math.min(0.24, converted.c)) : 0.16,
    contrast: 1,
  };
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
  Object.assign(overrides, mapTokenColors(document.tokenColors));
  if (Object.keys(overrides).length === 0) {
    throw new Error("The VS Code theme has no supported color or token-color entries.");
  }
  const variant = document.type === "light" || document.type === "hcLight" ? "light" : "dark";
  return createCustomThemeDefinition({
    id: sanitizeThemeId(name),
    name,
    parameters: baseParametersFromColors(overrides),
    overrides: { [variant]: overrides },
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
