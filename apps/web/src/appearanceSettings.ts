export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;
export const UI_FONT_SIZE_DEFAULT = 16;

export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 20;
export const CHAT_FONT_SIZE_DEFAULT = 14;

export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const TERMINAL_FONT_SIZE_DEFAULT = 12;

export const FONT_FAMILY_PREFERENCE_MAX_LENGTH = 200;
const FONT_FAMILY_PREFERENCE_MAX_COUNT = 4;

export const DEFAULT_UI_FONT_STACK =
  '"DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const DEFAULT_MONO_FONT_STACK =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';

export const CURATED_UI_FONT_FAMILIES = [
  "DM Sans",
  "SF Pro Text",
  "Segoe UI",
  "Inter",
  "Roboto",
  "Helvetica Neue",
  "Arial",
] as const;

export const CURATED_MONO_FONT_FAMILIES = [
  "JetBrains Mono",
  "SF Mono",
  "Cascadia Mono",
  "Consolas",
  "Menlo",
  "Monaco",
  "Liberation Mono",
] as const;

const GENERIC_FONT_FAMILIES = new Set([
  "-apple-system",
  "system-ui",
  "ui-sans-serif",
  "ui-monospace",
  "sans-serif",
  "serif",
  "monospace",
]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "revert", "revert-layer", "unset"]);
const SAFE_FONT_FAMILY_NAME = /^[\p{L}\p{M}\p{N} ._+-]+$/u;

export interface AppearanceSettings {
  readonly uiFontFamily: string;
  readonly uiFontSize: number;
  readonly chatFontFamily: string;
  readonly chatFontSize: number;
  readonly monoFontFamily: string;
  readonly terminalFontSize: number;
}

export type FontFamilyPreferenceResult =
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly message: string };

function stripBalancedQuotes(value: string): string | null {
  const first = value.at(0);
  const last = value.at(-1);
  if (first !== '"' && first !== "'") {
    return last === '"' || last === "'" ? null : value;
  }
  return last === first ? value.slice(1, -1) : null;
}

export function parseFontFamilyPreference(input: string): FontFamilyPreferenceResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { valid: true, value: "" };
  }
  if (trimmed.length > FONT_FAMILY_PREFERENCE_MAX_LENGTH) {
    return {
      valid: false,
      message: `Use at most ${FONT_FAMILY_PREFERENCE_MAX_LENGTH} characters.`,
    };
  }
  if (trimmed.includes("\0") || /[;:{}()[\]<>\\/\n\r]/u.test(trimmed)) {
    return { valid: false, message: "Font names cannot contain CSS syntax." };
  }

  const rawFamilies = trimmed.split(",");
  if (rawFamilies.length > FONT_FAMILY_PREFERENCE_MAX_COUNT) {
    return {
      valid: false,
      message: `Use at most ${FONT_FAMILY_PREFERENCE_MAX_COUNT} fallback families.`,
    };
  }

  const families: string[] = [];
  for (const rawFamily of rawFamilies) {
    const family = stripBalancedQuotes(rawFamily.trim());
    if (
      family === null ||
      family.length === 0 ||
      family.length > 64 ||
      !SAFE_FONT_FAMILY_NAME.test(family)
    ) {
      return { valid: false, message: "Enter plain font family names separated by commas." };
    }
    if (CSS_WIDE_KEYWORDS.has(family.toLowerCase())) {
      return { valid: false, message: `“${family}” is not a selectable font family.` };
    }
    families.push(family.replace(/\s+/gu, " "));
  }

  return { valid: true, value: families.join(", ") };
}

export function normalizeFontFamilyPreference(input: unknown): string {
  if (typeof input !== "string") return "";
  const parsed = parseFontFamilyPreference(input);
  return parsed.valid ? parsed.value : "";
}

function quoteFontFamily(family: string): string {
  return GENERIC_FONT_FAMILIES.has(family.toLowerCase())
    ? family
    : `"${family.replaceAll('"', "")}"`;
}

export function fontFamilyCssList(preference: string): string | null {
  const parsed = parseFontFamilyPreference(preference);
  if (!parsed.valid || parsed.value.length === 0) return null;
  return parsed.value
    .split(",")
    .map((family) => quoteFontFamily(family.trim()))
    .join(", ");
}

export function fontFamilyStack(preference: string, fallback: string): string {
  const custom = fontFamilyCssList(preference);
  return custom ? `${custom}, ${fallback}` : fallback;
}

export function clampFontSize(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numberValue)));
}

export function normalizeAppearanceSettings(
  settings: Partial<AppearanceSettings>,
): AppearanceSettings {
  return {
    uiFontFamily: normalizeFontFamilyPreference(settings.uiFontFamily),
    uiFontSize: clampFontSize(
      settings.uiFontSize,
      UI_FONT_SIZE_MIN,
      UI_FONT_SIZE_MAX,
      UI_FONT_SIZE_DEFAULT,
    ),
    chatFontFamily: normalizeFontFamilyPreference(settings.chatFontFamily),
    chatFontSize: clampFontSize(
      settings.chatFontSize,
      CHAT_FONT_SIZE_MIN,
      CHAT_FONT_SIZE_MAX,
      CHAT_FONT_SIZE_DEFAULT,
    ),
    monoFontFamily: normalizeFontFamilyPreference(settings.monoFontFamily),
    terminalFontSize: clampFontSize(
      settings.terminalFontSize,
      TERMINAL_FONT_SIZE_MIN,
      TERMINAL_FONT_SIZE_MAX,
      TERMINAL_FONT_SIZE_DEFAULT,
    ),
  };
}

export function applyAppearanceSettings(root: HTMLElement, input: AppearanceSettings): void {
  const settings = normalizeAppearanceSettings(input);
  const uiStack = fontFamilyStack(settings.uiFontFamily, DEFAULT_UI_FONT_STACK);
  const monoStack = fontFamilyStack(settings.monoFontFamily, DEFAULT_MONO_FONT_STACK);
  const chatStack = fontFamilyStack(settings.chatFontFamily, "var(--font-sans)");

  root.style.fontSize = `${settings.uiFontSize}px`;
  root.style.setProperty("--font-sans", uiStack);
  root.style.setProperty("--font-mono", monoStack);
  root.style.setProperty("--f5-chat-font-family", chatStack);
  root.style.setProperty("--f5-chat-font-size", `${settings.chatFontSize}px`);
  root.style.setProperty("--diffs-font-family", monoStack);
  root.style.setProperty("--diffs-header-font-family", uiStack);
}
