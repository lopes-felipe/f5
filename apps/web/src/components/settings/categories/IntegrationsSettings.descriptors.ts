import type { SettingsItemDescriptor } from "../settingsSearch";

export const INTEGRATIONS_SETTINGS_DESCRIPTORS = [
  {
    id: "integrations.keybindings",
    category: "integrations",
    label: "Keybindings",
    description: "Review keyboard shortcuts and edit the persisted keybindings file.",
    keywords: ["shortcuts", "commands", "keyboard", "keybindings.json"],
    targetSelector: '[data-settings-search-target="integrations.keybindings"]',
  },
  {
    id: "integrations.search-keybindings",
    category: "integrations",
    label: "Search keybindings",
    description: "Find a keyboard shortcut by command, key, or context.",
    keywords: ["shortcuts", "commands", "keyboard", "conflicts"],
    targetSelector: '[aria-label="Search keybindings"]',
  },
  {
    id: "integrations.mcp",
    category: "integrations",
    label: "MCP servers",
    description: "Configure common and project-scoped Model Context Protocol servers.",
    keywords: ["tools", "model context protocol", "stdio", "http", "server"],
    targetSelector: '[data-settings-search-target="integrations.mcp"]',
    projectScoped: true,
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
