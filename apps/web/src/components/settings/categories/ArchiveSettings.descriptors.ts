import type { SettingsItemDescriptor } from "../settingsSearch";

export const ARCHIVE_SETTINGS_DESCRIPTORS = [
  {
    id: "archive.items",
    category: "archive",
    label: "Archived threads and workflows",
    description: "Review, restore, or permanently delete archived work.",
    keywords: ["unarchive", "restore", "delete", "history"],
    targetSelector: '[data-settings-search-target="archive.items"]',
  },
  {
    id: "archive.search",
    category: "archive",
    label: "Search archive",
    description: "Filter archived threads and workflows by name or project.",
    keywords: ["find", "filter", "history", "project"],
    targetSelector: '[placeholder="Search archived threads and workflows"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
