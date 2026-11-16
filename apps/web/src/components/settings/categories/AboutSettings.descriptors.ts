import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const ABOUT_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["about.cli"],
    label: "Install command-line tools",
    description: "Install the bundled f5 and t3 commands for terminal use.",
    keywords: ["terminal", "cli", "path", "symlink"],
    targetSelector: '[data-settings-search-target="about.cli"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["about.updates"],
    label: "Updates",
    description: "Check, download and install F5 updates.",
    keywords: ["update", "restart", "release"],
    targetSelector: '[data-settings-search-target="about.updates"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["about.betaUpdates"],
    label: "Beta updates",
    description: "Receive pre-release builds.",
    keywords: ["beta", "channel", "prerelease"],
    targetSelector: '[data-settings-search-target="about.betaUpdates"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["about.version"],
    label: "Application version",
    description: "View the installed F5 version and environment information.",
    keywords: ["about", "build", "release"],
    targetSelector: '[data-settings-search-target="about.version"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["about.onboarding"],
    label: "Show onboarding again",
    description: "Restart the lightweight onboarding flow.",
    keywords: ["welcome", "setup", "tutorial"],
    targetSelector: '[data-settings-search-target="about.onboarding"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
