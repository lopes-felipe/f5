import type { SettingsItemDescriptor } from "../settingsSearch";

export const NOTIFICATIONS_SETTINGS_DESCRIPTORS = [
  {
    id: "notifications.thread-status",
    category: "notifications",
    label: "Thread status notifications",
    description: "Notify when a thread needs attention or finishes.",
    keywords: ["approval", "input", "completed", "browser"],
    targetSelector: '[aria-label="Thread status notifications"]',
  },
  {
    id: "notifications.pr-attention",
    category: "notifications",
    label: "PR attention notifications",
    description: "Notify when Pull Request Hub finds work needing action.",
    keywords: ["github", "pull request", "review"],
    targetSelector: '[aria-label="PR attention notifications"]',
  },
  {
    id: "notifications.git-refresh",
    category: "notifications",
    label: "Auto-refresh git status",
    description: "Control background repository status refreshes.",
    keywords: ["git", "polling", "interval"],
    targetSelector: '[aria-label="Auto-refresh git status"]',
  },
  {
    id: "notifications.git-refresh-interval",
    category: "notifications",
    label: "Git refresh interval",
    description: "Set the number of seconds between git status refreshes.",
    keywords: ["git", "polling", "seconds"],
    targetSelector: '[aria-label="Git auto-refresh interval in seconds"]',
  },
  {
    id: "notifications.pr-refresh",
    category: "notifications",
    label: "Auto-refresh PR Hub",
    description: "Control scheduled GitHub Pull Request polling.",
    keywords: ["github", "pull request", "polling", "interval"],
    targetSelector: '[aria-label="Auto-refresh PR Hub"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
