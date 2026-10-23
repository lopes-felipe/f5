import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

export const THREADS_SETTINGS_DESCRIPTORS = [
  {
    ...SETTINGS_ITEM_ROUTES["threads.default-permissions"],
    label: "Default permissions",
    description: "Choose what agents in new threads may do without asking first.",
    keywords: ["runtime mode", "approval", "full access", "accept edits", "auto"],
    targetSelector: '[aria-label="Default permissions"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.default-workspace"],
    label: "Default workspace",
    description: "Start new threads locally or in a new worktree.",
    keywords: ["thread", "worktree", "local", "environment", "f5.json"],
    targetSelector: '[aria-label="Default workspace"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.follow-up"],
    label: "Follow-up behavior",
    description: "Queue follow-up messages or steer the running turn.",
    keywords: ["queue", "steer", "interrupt", "running"],
    targetSelector: '[aria-label="Follow-up behavior"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.resume-turns"],
    label: "Resume active turns after restart",
    description: "Continue turns that were running when the app restarted.",
    keywords: ["restart", "crash", "recovery"],
    targetSelector: '[aria-label="Resume active turns after restart"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.auto-continue"],
    label: "Auto-continue after usage limits",
    description: "Send continue automatically after a provider usage limit resets.",
    keywords: ["rate limit", "quota", "resume"],
    targetSelector: '[aria-label="Auto-continue after usage limits"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.usage-sampling"],
    label: "Sample account limits in the background",
    description: "Keep quota history and forecasts while the Usage page is closed.",
    keywords: ["usage", "quota", "rate limit", "forecast"],
    targetSelector: '[aria-label="Sample account limits in the background"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.prompt-suggestions"],
    label: "Claude prompt suggestions",
    description: "Let Claude fill the composer with a suggested next prompt.",
    keywords: ["suggestion", "composer", "claude"],
    targetSelector: '[aria-label="Claude prompt suggestions"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.summaries"],
    label: "Thread summaries",
    description: "Choose the provider, model, and reasoning effort for all thread summaries.",
    keywords: ["summary", "notes", "luna", "cost", "reasoning"],
    targetSelector: '[data-settings-search-target="threads.summaries"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.title-model"],
    label: "Thread title model",
    description: "Choose the Codex model that writes first thread titles.",
    keywords: ["title", "naming", "codex", "model"],
    targetSelector: '[aria-label="Thread title model"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.claude-subagents"],
    label: "Enable Claude sub-agents",
    description: "Allow Claude to spawn helper agents for exploration and verification.",
    keywords: ["agents", "exploration", "verification", "helpers"],
    targetSelector: '[aria-label="Enable Claude sub-agents"]',
  },
  {
    ...SETTINGS_ITEM_ROUTES["threads.claude-subagent-model"],
    label: "Claude sub-agent model",
    description: "Choose the default model used by Claude helper agents.",
    keywords: ["agents", "model", "inherit", "helpers"],
    targetSelector: '[aria-label="Claude sub-agent model"]',
  },
] as const satisfies ReadonlyArray<SettingsItemDescriptor>;
