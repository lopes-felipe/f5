import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const ARCHIVE_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["archive.items"],
    label: "Archived threads and workflows",
    description: "Review, restore, or permanently delete archived work.",
    keywords: ["unarchive", "restore", "delete", "history"],
    targetSelector: '[data-settings-search-target="archive.items"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["archive.search"],
    label: "Search archive",
    description: "Filter archived threads and workflows by name or project.",
    keywords: ["find", "filter", "history", "project"],
    targetSelector: '[placeholder="Search archived threads and workflows"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
