import type { SettingsItemDescriptor } from "../settingsSearch";

export const GENERAL_SETTINGS_DESCRIPTORS = [
  {
    id: "general.theme",
    category: "general",
    label: "Theme preference",
    description: "Use the system, light, or dark appearance.",
    keywords: ["appearance", "color", "dark mode", "light mode"],
    targetSelector: '[aria-label="Theme preference"]',
  },
  {
    id: "general.timestamp-format",
    category: "general",
    label: "Timestamp format",
    description: "Choose system, 12-hour, or 24-hour timestamps.",
    keywords: ["time", "clock", "locale"],
    targetSelector: '[aria-label="Timestamp format"]',
  },
  {
    id: "general.default-worktree",
    category: "general",
    label: "Default new thread workspace",
    description: "Start new threads locally or in a new worktree.",
    keywords: ["thread", "worktree", "local", "environment"],
    targetSelector: '[aria-label="Default new threads to New worktree mode"]',
  },
  {
    id: "general.task-sidebar",
    category: "general",
    label: "Open task sidebar automatically",
    description: "Show task and plan sidebars when a thread starts tracking steps.",
    keywords: ["tasks", "plan", "panel", "auto open"],
    targetSelector: '[aria-label="Open task sidebar automatically"]',
  },
  {
    id: "general.confirm-delete",
    category: "general",
    label: "Confirm thread deletion",
    description: "Ask before deleting a thread and its chat history.",
    keywords: ["safety", "delete", "destructive", "confirmation"],
    targetSelector: '[aria-label="Confirm thread deletion"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
