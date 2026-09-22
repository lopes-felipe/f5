import type { SettingsItemDescriptor } from "../settingsSearch";
export const PROFILES_SETTINGS_DESCRIPTORS = [
  {
    id: "profiles.manage",
    category: "profiles",
    label: "Profiles",
    description: "Isolated accounts, projects and chat history.",
    keywords: ["work", "personal", "account", "login", "environment", "port", "new profile"],
    targetSelector: '[data-settings-search-target="profiles.manage"]',
  },
  {
    id: "profiles.accounts",
    category: "profiles",
    label: "Profile accounts",
    description: "Sign in to the CLIs this profile uses.",
    keywords: ["sign in", "sign out", "login", "logout", "codex", "claude", "authentication"],
    targetSelector: '[data-settings-search-target="profiles.accounts"]',
  },
  {
    id: "profiles.storage",
    category: "profiles",
    label: "Profile storage",
    description: "Where profile data and removed profiles are kept on disk.",
    keywords: ["trash", "disk", "folder", "directory", "state"],
    targetSelector: '[data-settings-search-target="profiles.storage"]',
  },
] satisfies readonly SettingsItemDescriptor[];
