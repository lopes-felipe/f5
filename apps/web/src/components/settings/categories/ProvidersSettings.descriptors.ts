import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const PROVIDERS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["providers.instances"],
    label: "Provider instances",
    description:
      "Manage provider runtimes and each instance's binary, home directory, launch arguments, and models.",
    keywords: [
      "codex",
      "claude",
      "cursor",
      "opencode",
      "grok",
      "muse",
      "runtime",
      "binary path",
      "launch args",
      "CODEX_HOME",
      "custom models",
      "favorite models",
    ],
    targetSelector: '[data-settings-search-target="providers.instances"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["providers.updates"],
    label: "Automatically check for provider updates",
    description: "Refresh installed provider version and update information.",
    keywords: ["version", "upgrade", "cli"],
    targetSelector: '[aria-label="Automatically check for provider updates"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["providers.legacy-overrides"],
    label: "Legacy provider overrides",
    description: "Move or clear old app-wide Codex and Claude paths, arguments, and custom models.",
    keywords: ["codex binary", "claude binary", "cli arguments", "custom models", "migrate"],
    targetSelector: '[data-settings-search-target="providers.legacy-overrides"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
