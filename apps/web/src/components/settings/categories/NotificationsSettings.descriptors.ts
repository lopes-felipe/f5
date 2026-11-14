import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const NOTIFICATIONS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["notifications.in-app"],
    label: "Notification sources",
    description:
      "Choose in-app toasts, system notifications and sounds for threads, pull requests, scheduled runs, upstream, updates and errors.",
    keywords: ["desktop", "preferences", "toast", "system", "sound", "in-app"],
    targetSelector: '[data-settings-search-target="notifications.in-app"]',
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
    label: "Thread notifications",
    description: "Toast, system notification or sound when a thread needs attention or finishes.",
    keywords: ["approval", "input", "completed", "browser", "sound"],
    targetSelector: '[data-settings-search-target="notifications.thread-status"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["notifications.pr-attention"],
    label: "Pull request notifications",
    description: "Notify when Pull Request Hub finds work needing action.",
    keywords: ["github", "pull request", "review"],
    targetSelector: '[data-settings-search-target="notifications.pr-attention"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["notifications.do-not-disturb"],
    label: "Do Not Disturb",
    description: "Pause toasts, system notifications and sounds for a while.",
    keywords: ["mute", "snooze", "quiet", "focus", "silence"],
    targetSelector: '[aria-label="Do Not Disturb"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["notifications.toast-position"],
    label: "Toast position",
    description: "Show in-app notifications at the top or bottom right.",
    keywords: ["toast", "corner", "placement"],
    targetSelector: '[aria-label="Toast position"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
