import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const STORAGE_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["storage.attachments"],
    label: "Attachments",
    description: "Review unowned images and files before reclaiming space.",
    keywords: ["images", "files", "orphan", "screenshots"],
    targetSelector: '[data-settings-search-target="storage.attachments"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["storage.automation"],
    label: "Automatic cleanup",
    description:
      "Remove idle worktrees, old logs and old threads automatically, with a preview and history.",
    keywords: [
      "worktree",
      "cleanup",
      "retention",
      "logs",
      "screenshots",
      "recordings",
      "audit",
      "purge",
      "archived",
      "deleted",
      "database",
    ],
    targetSelector: '[data-settings-search-target="storage.automation"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["storage.backup"],
    label: "Backup and restore",
    description: "Export or restore a checksummed F5 state archive.",
    keywords: ["export", "import", "archive", "recovery"],
    targetSelector: '[data-settings-search-target="storage.backup"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["storage.backup-credentials"],
    label: "Include encrypted credentials",
    description: "Protect credentials in an exported backup with a password.",
    keywords: ["secrets", "encryption", "AES", "password"],
    targetSelector: '[aria-label="Include encrypted credentials"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["storage.overview"],
    label: "Storage usage",
    description: "Inspect local data and reclaim selected storage categories.",
    keywords: [
      "disk",
      "free space",
      "usage",
      "size",
      "cleanup",
      "database",
      "logs",
      "worktrees",
      "codex",
      "marketplace",
    ],
    targetSelector: '[data-settings-search-target="storage.overview"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
