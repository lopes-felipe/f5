import type { SettingsItemDescriptor } from "../settingsSearch";

export const STORAGE_SETTINGS_DESCRIPTORS = [
  {
    id: "storage.backup",
    category: "storage",
    label: "Backup and restore",
    description: "Export or restore a checksummed F5 state archive.",
    keywords: ["export", "import", "archive", "recovery"],
    targetSelector: '[data-settings-search-target="storage.backup"]',
  },
  {
    id: "storage.backup-credentials",
    category: "storage",
    label: "Include encrypted credentials",
    description: "Protect credentials in an exported backup with a password.",
    keywords: ["secrets", "encryption", "AES", "password"],
    targetSelector: '[aria-label="Include encrypted credentials"]',
  },
  {
    id: "storage.usage",
    category: "storage",
    label: "Storage usage",
    description: "Inspect local data and reclaim selected storage categories.",
    keywords: ["cleanup", "disk", "database", "logs", "worktrees"],
    targetSelector: '[data-settings-search-target="storage.usage"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
