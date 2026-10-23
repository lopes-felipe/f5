import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const APPEARANCE_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["appearance.theme"],
    label: "Theme preference",
    description: "Use the system, light, or dark appearance.",
    keywords: ["appearance", "color", "dark mode", "light mode"],
    targetSelector: '[aria-label="Theme preference"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.palette"],
    label: "Color theme library",
    description: "Choose, create, import, and export color palettes.",
    keywords: ["palette", "theme", "color", "vscode", "vsix", "contrast"],
    targetSelector: '[aria-label="Color theme library"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.diff-colors"],
    label: "Diff colors",
    description: "Choose red and green or blue and orange diff colors.",
    keywords: ["diff", "accessibility", "palette", "color blind"],
    targetSelector: '[aria-label="Diff colors"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.chat-width"],
    label: "Conversation width",
    description: "Set the maximum width of messages and the composer.",
    keywords: ["width", "column", "layout", "narrow", "wide", "readability"],
    targetSelector: '[aria-label="Conversation width"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.ui-font"],
    label: "Interface font",
    description: "Choose the font used by F5 controls and navigation.",
    keywords: ["font", "typeface", "ui", "sidebar"],
    targetSelector: '[aria-label="Interface font family"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.ui-size"],
    label: "Interface font size",
    description: "Scale interface text and rem-based controls.",
    keywords: ["font", "size", "zoom", "accessibility"],
    targetSelector: '[aria-label="Interface font size"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.chat-font"],
    label: "Chat font",
    description: "Choose the font used by messages and the composer.",
    keywords: ["font", "typeface", "message", "composer", "prompt"],
    targetSelector: '[aria-label="Chat font family"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.chat-size"],
    label: "Chat font size",
    description: "Set message and composer text size.",
    keywords: ["font", "size", "message", "composer", "prompt"],
    targetSelector: '[aria-label="Chat font size"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.mono-font"],
    label: "Code font",
    description: "Choose the monospace font used by code, diffs, and terminals.",
    keywords: ["font", "monospace", "code", "diff", "terminal"],
    targetSelector: '[aria-label="Code font family"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["appearance.terminal-size"],
    label: "Terminal font size",
    description: "Set terminal text size and refit the active terminal.",
    keywords: ["font", "size", "terminal", "shell"],
    targetSelector: '[aria-label="Terminal font size"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
