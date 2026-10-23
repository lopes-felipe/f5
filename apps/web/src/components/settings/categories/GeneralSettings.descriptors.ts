import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const GENERAL_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["general.diagnostics"],
    label: "Diagnostics",
    description: "Configure OpenTelemetry traces, metrics and collector headers.",
    keywords: ["otlp", "traces", "metrics", "observability", "telemetry"],
    targetSelector: '[aria-label="traces collector URL"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.sidebar-preview"],
    label: "Sidebar thread preview count",
    description: "Set how many threads appear before Show more.",
    keywords: ["sidebar", "threads", "limit"],
    targetSelector: '[aria-label="Sidebar thread preview count"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.task-sidebar"],
    label: "Open task sidebar automatically",
    description: "Show task and plan sidebars when a thread starts tracking steps.",
    keywords: ["tasks", "plan", "panel", "auto open"],
    targetSelector: '[aria-label="Open task sidebar automatically"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.file-tree-limit"],
    label: "File tree entry limit",
    description: "Set the maximum number of entries loaded in the Files panel.",
    keywords: ["files", "explorer", "performance"],
    targetSelector: '[aria-label="File tree entry limit"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.file-links"],
    label: "Open file links in code panel",
    description: "Open file links inside F5 instead of an external editor.",
    keywords: ["files", "editor", "preview"],
    targetSelector: '[aria-label="Open file links in code panel"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.timestamp-format"],
    label: "Timestamp format",
    description: "Choose system, 12-hour, or 24-hour timestamps.",
    keywords: ["time", "clock", "locale"],
    targetSelector: '[aria-label="Timestamp format"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.window-title"],
    label: "Window title",
    description: "Show the project name or the thread title in window and tab titles.",
    keywords: ["title", "screen share", "privacy", "tab"],
    targetSelector: '[aria-label="Window title"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.quit-shortcut"],
    label: "Quit shortcut",
    description: "Hold the quit shortcut, press twice, or quit immediately.",
    keywords: ["desktop", "preferences"],
    targetSelector: '[aria-label="Quit shortcut"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["general.confirm-delete"],
    label: "Confirm thread deletion",
    description: "Ask before deleting a thread and its chat history.",
    keywords: ["safety", "delete", "destructive", "confirmation"],
    targetSelector: '[aria-label="Confirm thread deletion"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
