import type { SettingsItemDescriptor } from "../settingsSearch";

export const STORAGE_SETTINGS_DESCRIPTORS = [
  {
    id: "storage.automation",
    category: "storage",
    label: "Automatic cleanup",
    description: "Remove idle worktrees and old logs automatically, with a preview and history.",
    keywords: ["worktree", "cleanup", "retention", "logs", "screenshots", "recordings", "audit"],
    targetSelector: '[data-settings-search-target="storage.automation"]',
  },
  {
    id: "storage.auto-pull",
    category: "storage",
    label: "Auto-pull default branches",
    description: "Fast-forward clean default-branch checkouts in the background.",
    keywords: ["git", "pull", "fetch", "main", "fast-forward", "sync"],
    targetSelector: '[data-settings-search-target="storage.auto-pull"]',
  },
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
