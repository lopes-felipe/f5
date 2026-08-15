import type { SettingsItemDescriptor } from "../settingsSearch";

export const ABOUT_SETTINGS_DESCRIPTORS = [
  {
    id: "about.version",
    category: "about",
    label: "Application version",
    description: "View the installed F5 version and environment information.",
    keywords: ["about", "build", "release"],
    targetSelector: '[data-settings-search-target="about.version"]',
  },
  {
    id: "about.onboarding",
    category: "about",
    label: "Show onboarding again",
    description: "Restart the lightweight onboarding flow.",
    keywords: ["welcome", "setup", "tutorial"],
    targetSelector: '[data-settings-search-target="about.version"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
