import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const KEYBOARD_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["keyboard.keybindings"],
    label: "Keybindings",
    description: "Review keyboard shortcuts and edit the persisted keybindings file.",
    keywords: ["shortcuts", "commands", "keyboard", "keybindings.json"],
    targetSelector: '[data-settings-search-target="keyboard.keybindings"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["keyboard.search"],
    label: "Search keybindings",
    description: "Find a keyboard shortcut by command, key, or context.",
    keywords: ["shortcuts", "commands", "keyboard", "conflicts"],
    targetSelector: '[aria-label="Search keybindings"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
