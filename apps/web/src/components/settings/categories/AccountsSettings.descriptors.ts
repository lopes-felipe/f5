import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const ACCOUNTS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["accounts.profiles"],
    label: "Profiles",
    description: "Isolated accounts, projects and chat history.",
    keywords: ["work", "personal", "account", "environment", "port", "new profile"],
    targetSelector: '[data-settings-search-target="accounts.profiles"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["accounts.providers"],
    label: "Provider accounts",
    description: "Sign in to the CLIs this profile uses.",
    keywords: ["sign in", "sign out", "login", "logout", "codex", "claude", "authentication"],
    targetSelector: '[data-settings-search-target="accounts.providers"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["accounts.github"],
    label: "GitHub account",
    description: "Sign in to GitHub for this profile’s agents, terminals, and pull requests.",
    keywords: ["github", "gh", "authentication", "login", "token"],
    targetSelector: '[data-settings-search-target="accounts.github"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["accounts.storage"],
    label: "Profile storage",
    description: "Where profile data and removed profiles are kept on disk.",
    keywords: ["trash", "disk", "folder", "directory", "state"],
    targetSelector: '[data-settings-search-target="accounts.storage"]',
  },
] satisfies readonly SettingsItemDescriptor[];
