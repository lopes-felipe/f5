import type { SettingsItemDescriptor } from "../settingsSearch";

export const PROVIDERS_SETTINGS_DESCRIPTORS = [
  {
    id: "providers.instances",
    category: "providers",
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
    id: "providers.updates",
    category: "providers",
    label: "Automatically check for provider updates",
    description: "Refresh installed provider version and update information.",
    keywords: ["version", "upgrade", "cli"],
    targetSelector: '[aria-label="Automatically check for provider updates"]',
  },
  {
    id: "providers.legacy-overrides",
    category: "providers",
    label: "Legacy provider overrides",
    description: "Move or clear old app-wide Codex and Claude paths, arguments, and custom models.",
    keywords: ["codex binary", "claude binary", "cli arguments", "custom models", "migrate"],
    targetSelector: '[data-settings-search-target="providers.legacy-overrides"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
