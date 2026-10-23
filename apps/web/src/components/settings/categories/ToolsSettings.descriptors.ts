import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const TOOLS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["tools.mcp"],
    label: "MCP servers",
    description: "Configure common and project-scoped Model Context Protocol servers.",
    keywords: ["tools", "model context protocol", "stdio", "http", "server"],
    targetSelector: '[data-settings-search-target="tools.mcp"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
