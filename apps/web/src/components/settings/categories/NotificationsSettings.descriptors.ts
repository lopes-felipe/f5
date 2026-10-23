import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const NOTIFICATIONS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["notifications.in-app"],
    label: "In-app thread notifications",
    description: "Show thread status toasts while F5 is open.",
    keywords: ["desktop", "preferences", "toast"],
    targetSelector: '[aria-label="In-app thread notifications"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["notifications.attention-badge"],
    label: "Show attention badge",
    description: "Count threads needing attention on the app icon and web title.",
    keywords: ["desktop", "preferences", "dock"],
    targetSelector: '[aria-label="Show attention badge"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["notifications.thread-status"],
    label: "Thread status notifications",
    description: "Choose system notifications, sounds, both, or off when a thread needs attention.",
    keywords: ["approval", "input", "completed", "browser", "sound"],
    targetSelector: '[aria-label="Thread status notifications"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["notifications.pr-attention"],
    label: "PR attention notifications",
    description: "Notify when Pull Request Hub finds work needing action.",
    keywords: ["github", "pull request", "review"],
    targetSelector: '[aria-label="PR attention notifications"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
