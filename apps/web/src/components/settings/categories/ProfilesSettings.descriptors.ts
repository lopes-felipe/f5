import type { SettingsItemDescriptor } from "../settingsSearch";
export const PROFILES_SETTINGS_DESCRIPTORS = [
  {
    id: "profiles.manage",
    category: "profiles",
    label: "Profiles",
    description: "Isolated accounts, projects and chat history.",
    keywords: ["work", "personal", "account", "login", "environment"],
    targetSelector: '[data-settings-search-target="profiles.manage"]',
  },
] satisfies readonly SettingsItemDescriptor[];
