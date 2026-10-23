import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const TOOLS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["tools.agent-bridge"],
    label: "Agent Bridge",
    description: "Connect a local MCP client and explicitly grant scheduled task access.",
    keywords: ["schedules", "MCP", "local", "agent", "permissions"],
    targetSelector: '[data-settings-search-target="tools.agent-bridge"]',
    scope: "global",
  },
  {
    ...SETTINGS_ITEM_ROUTES["tools.mcp"],
    label: "MCP servers",
    description: "Configure common and project-scoped Model Context Protocol servers.",
    keywords: ["tools", "model context protocol", "stdio", "http", "server"],
    targetSelector: '[data-settings-search-target="tools.mcp"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
