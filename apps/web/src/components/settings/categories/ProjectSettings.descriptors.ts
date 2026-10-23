import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

/** The project-scope "Project" page: settings that belong to one project only. */
export const PROJECT_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["project.providers"],
    label: "Project providers",
    description: "Enable or disable configured provider instances for this project.",
    keywords: ["agent", "model", "enable", "disable"],
    targetSelector: '[data-settings-search-target="project.providers"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["project.icon"],
    label: "Project icon",
    description: "Choose an automatic favicon, emoji, or colored symbol for a project.",
    keywords: ["favicon", "emoji", "symbol", "color", "monogram"],
    targetSelector: '[data-settings-search-target="project.icon"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["project.memory"],
    label: "Project memory",
    description: "Store persistent instructions and context for a project.",
    keywords: ["feedback", "context", "reference", "instructions"],
    targetSelector: '[data-settings-search-target="project.memory"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["project.checked-in"],
    label: "Checked-in configuration",
    description: "Review the defaults this repository's f5.json provides.",
    keywords: ["f5.json", "t3.json", "repository", "checked in"],
    targetSelector: '[data-settings-search-target="project.checked-in"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["project.reset"],
    label: "Reset project overrides",
    description: "Remove every override for this project and use the global settings again.",
    keywords: ["reset", "clear", "overrides", "defaults"],
    targetSelector: '[data-settings-search-target="project.reset"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
