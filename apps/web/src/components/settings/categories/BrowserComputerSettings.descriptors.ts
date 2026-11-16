import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const BROWSER_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["browser.pr-links"],
    label: "Open pull request links on the forge",
    description: "Choose whether PR links open beside the thread or in the system browser.",
    keywords: ["pull request", "github", "gitlab", "links", "external", "panel"],
    targetSelector: '[aria-label="Open pull request links on the forge"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.links"],
    label: "Open links in",
    description: "Open links in the system browser or the F5 preview.",
    keywords: ["links", "preview", "default browser"],
    targetSelector: '[aria-label="Open links in"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.agent-access"],
    label: "Agent browser access",
    description: "Let agents open, read, and drive pages in the F5 preview.",
    keywords: ["preview", "agent browser", "automation"],
    targetSelector: '[aria-label="Enable agent browser access"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.allowed-sites"],
    label: "Allowed external sites",
    description: "Sites besides local servers that the preview and agents may load.",
    keywords: ["allowlist", "hosts", "domains", "external"],
    targetSelector: '[data-settings-search-target="browser.allowed-sites"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.chrome"],
    label: "Claude in Chrome",
    description: "Let Claude use Google Chrome through its extension.",
    keywords: ["chrome", "extension", "claude"],
    targetSelector: '[data-settings-search-target="browser.chrome"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.codex-chrome"],
    label: "Codex Chrome control",
    description: "Let Codex use Chrome through the ChatGPT app's extension.",
    keywords: ["chrome", "extension", "codex", "chatgpt"],
    targetSelector: '[data-settings-search-target="browser.codex-chrome"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.computer-use"],
    label: "Computer use",
    description: "Let agents see and control the desktop apps you approve.",
    keywords: ["computer", "desktop", "accessibility", "screen recording", "background"],
    targetSelector: '[data-settings-search-target="browser.computer-use"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.profiles"],
    label: "Browser profiles",
    description: "Choose the preview profile, zoom, sound, and color scheme for new tabs.",
    keywords: ["preview", "incognito", "zoom", "mute", "color scheme"],
    targetSelector: '[data-settings-search-target="browser.profiles"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.cookie-import"],
    label: "Import browser cookies",
    description: "Import cookies from another browser into a new preview profile.",
    keywords: ["cookies", "safari", "chrome", "login", "session"],
    targetSelector: '[data-settings-search-target="browser.cookie-import"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["browser.snapshot"],
    label: "SnapShot",
    description: "Capture another window and its text into the composer.",
    keywords: ["screenshot", "capture", "shortcut", "window"],
    targetSelector: '[data-settings-search-target="browser.snapshot"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
