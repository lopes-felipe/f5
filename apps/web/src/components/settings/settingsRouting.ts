import { ProjectId } from "@t3tools/contracts";
export const SETTINGS_CATEGORIES = [
  "general",
  "appearance",
  "conversation",
  "keyboard",
  "notifications",
  "providers",
  "threads",
  "tools",
  "browser",
  "projects",
  "git",
  "accounts",
  "storage",
  "archive",
  "about",
  // Only exists while a project scope is selected.
  "project",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export type SettingsScope = "global" | "project";

/** Categories rendered in global scope, in navigation order. */
export const GLOBAL_SETTINGS_CATEGORIES = SETTINGS_CATEGORIES.filter(
  (category): category is Exclude<SettingsCategory, "project"> => category !== "project",
);

/** Categories that have project content, in project-scope navigation order. */
export const PROJECT_SETTINGS_CATEGORIES = [
  "project",
  "threads",
  "tools",
  "browser",
  "git",
] as const satisfies ReadonlyArray<SettingsCategory>;

export type ProjectSettingsCategory = (typeof PROJECT_SETTINGS_CATEGORIES)[number];

export interface SettingsCategoryGroup {
  readonly id: "interface" | "agents" | "workspace" | "account" | "about" | "project" | "overrides";
  /** null renders the group without a heading (About stands alone). */
  readonly label: string | null;
  readonly categories: ReadonlyArray<SettingsCategory>;
}

/** Global-scope navigation groups, in `GLOBAL_SETTINGS_CATEGORIES` order. */
export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<SettingsCategoryGroup> = [
  {
    id: "interface",
    label: "Interface",
    categories: ["general", "appearance", "conversation", "keyboard", "notifications"],
  },
  { id: "agents", label: "Agents", categories: ["providers", "threads", "tools", "browser"] },
  { id: "workspace", label: "Workspace", categories: ["projects", "git"] },
  { id: "account", label: "Account & data", categories: ["accounts", "storage", "archive"] },
  { id: "about", label: null, categories: ["about"] },
];

/** Project-scope navigation groups, in `PROJECT_SETTINGS_CATEGORIES` order. */
export const PROJECT_SETTINGS_CATEGORY_GROUPS: ReadonlyArray<SettingsCategoryGroup> = [
  { id: "project", label: null, categories: ["project"] },
  { id: "overrides", label: "Overrides", categories: ["threads", "tools", "browser", "git"] },
];

export function settingsCategoryGroupsForScope(
  scope: SettingsScope,
): ReadonlyArray<SettingsCategoryGroup> {
  return scope === "project" ? PROJECT_SETTINGS_CATEGORY_GROUPS : SETTINGS_CATEGORY_GROUPS;
}

export function settingsCategoriesForScope(scope: SettingsScope): ReadonlyArray<SettingsCategory> {
  return scope === "project" ? PROJECT_SETTINGS_CATEGORIES : GLOBAL_SETTINGS_CATEGORIES;
}

export function isProjectSettingsCategory(
  category: SettingsCategory,
): category is ProjectSettingsCategory {
  return (PROJECT_SETTINGS_CATEGORIES as readonly string[]).includes(category);
}

export const SETTINGS_CATEGORY_LABELS = {
  general: "General",
  appearance: "Appearance",
  conversation: "Conversation",
  keyboard: "Keyboard",
  notifications: "Notifications",
  providers: "Providers",
  threads: "Threads",
  tools: "Tools",
  browser: "Browser & Computer",
  projects: "Projects",
  git: "Git & GitHub",
  accounts: "Profiles & Accounts",
  storage: "Storage",
  archive: "Archive",
  about: "About",
  project: "Project",
} as const satisfies Record<SettingsCategory, string>;

/** Category names from before the settings reorganization, kept so old deep links resolve. */
export const LEGACY_SETTINGS_CATEGORY_ALIASES: Readonly<Record<string, SettingsCategory>> = {
  display: "conversation",
  integrations: "tools",
  profiles: "accounts",
};

/** Item IDs from before the settings reorganization, kept so old deep links resolve. */
export const LEGACY_SETTINGS_ITEM_ALIASES: Readonly<Record<string, string>> = {
  "general.theme": "appearance.theme",
  // General
  "general.composer-collapse": "conversation.composer-collapse",
  "general.composer-editor": "conversation.composer-editor",
  "general.send-shortcut": "conversation.send-shortcut",
  "general.pr-merge-method": "git.merge-method",
  "general.default-worktree": "threads.default-workspace",
  // Display
  "display.diff-default": "conversation.diff-default",
  "display.diff-colors": "appearance.diff-colors",
  "display.streaming": "conversation.streaming",
  "display.file-links": "general.file-links",
  "display.word-wrap": "conversation.word-wrap",
  "display.file-tree-limit": "general.file-tree-limit",
  "display.work-log-detail": "conversation.work-log-detail",
  "display.work-log-category": "conversation.work-log-category",
  "display.workflow-expand": "conversation.workflow-expand",
  "display.command-output": "conversation.command-output",
  "display.command-expand": "conversation.command-expand",
  "display.mcp-details": "conversation.mcp-details",
  "display.mcp-expand": "conversation.mcp-expand",
  "display.reasoning": "conversation.reasoning",
  "display.inline-diffs": "conversation.inline-diffs",
  "display.runtime-warnings": "conversation.runtime-warnings",
  "display.provider-metadata": "conversation.provider-metadata",
  "display.sidebar-preview": "general.sidebar-preview",
  // Notifications
  "notifications.git-refresh": "git.status-refresh",
  "notifications.git-refresh-interval": "git.status-refresh-interval",
  "notifications.pr-refresh": "git.pr-refresh",
  "notifications.pr-refresh-interval": "git.pr-refresh-interval",
  "notifications.pr-stalled": "git.pr-stalled",
  "notifications.pr-discovery": "git.pr-discovery",
  // Providers & Models
  "providers.session-notes": "threads.summaries",
  "providers.codex-binary": "providers.instances",
  "providers.codex-home": "providers.instances",
  "providers.claude-binary": "providers.instances",
  "providers.claude-args": "providers.instances",
  "providers.custom-models": "providers.instances",
  "providers.git-model": "git.text-model",
  "providers.source-control-writing": "git.writing",
  // Integrations
  "integrations.browser": "browser.agent-access",
  "integrations.github": "accounts.github",
  "integrations.keybindings": "keyboard.keybindings",
  "integrations.search-keybindings": "keyboard.search",
  "integrations.mcp": "tools.mcp",
  // Projects
  "projects.active-project": "projects.list",
  "projects.default-env-mode": "threads.default-workspace",
  "projects.icon": "project.icon",
  "projects.memory": "project.memory",
  "projects.claude-subagents": "threads.claude-subagents",
  "projects.claude-subagent-model": "threads.claude-subagent-model",
  // Profiles
  "profiles.manage": "accounts.profiles",
  "profiles.accounts": "accounts.providers",
  "profiles.storage": "accounts.storage",
  // Storage
  "storage.auto-pull": "git.auto-pull",
};

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** Canonical category for a current or legacy category name, or null. */
export function resolveSettingsCategoryAlias(value: unknown): SettingsCategory | null {
  if (isSettingsCategory(value)) return value;
  if (typeof value !== "string") return null;
  return Object.hasOwn(LEGACY_SETTINGS_CATEGORY_ALIASES, value)
    ? LEGACY_SETTINGS_CATEGORY_ALIASES[value]!
    : null;
}

export interface SettingsItemRoute {
  readonly id: string;
  readonly category: SettingsCategory;
  readonly scope?: "global" | "project" | "both";
}
function defineItemRoutes<const T extends Record<string, Omit<SettingsItemRoute, "id">>>(
  input: T,
): { readonly [K in keyof T]: T[K] & { readonly id: K } } {
  return Object.fromEntries(Object.entries(input).map(([id, value]) => [id, { ...value, id }])) as {
    readonly [K in keyof T]: T[K] & { readonly id: K };
  };
}
/** Route identity and scope are shared with the full descriptors; descriptive search text loads with Settings. */
export const SETTINGS_ITEM_ROUTES = defineItemRoutes({
  "about.cli": {
    category: "about",
  },
  "about.updates": {
    category: "about",
  },
  "about.betaUpdates": {
    category: "about",
  },
  "about.version": {
    category: "about",
  },
  "about.onboarding": {
    category: "about",
  },
  "accounts.profiles": {
    category: "accounts",
  },
  "accounts.providers": {
    category: "accounts",
  },
  "accounts.github": {
    category: "accounts",
  },
  "accounts.storage": {
    category: "accounts",
  },
  "appearance.theme": {
    category: "appearance",
  },
  "appearance.palette": {
    category: "appearance",
  },
  "appearance.diff-colors": {
    category: "appearance",
  },
  "appearance.chat-width": {
    category: "appearance",
  },
  "appearance.ui-font": {
    category: "appearance",
  },
  "appearance.ui-size": {
    category: "appearance",
  },
  "appearance.chat-font": {
    category: "appearance",
  },
  "appearance.chat-size": {
    category: "appearance",
  },
  "appearance.mono-font": {
    category: "appearance",
  },
  "appearance.terminal-size": {
    category: "appearance",
  },
  "archive.items": {
    category: "archive",
  },
  "archive.search": {
    category: "archive",
  },
  "browser.pr-links": {
    category: "browser",
  },
  "browser.links": {
    category: "browser",
  },
  "browser.agent-access": {
    category: "browser",
    scope: "both",
  },
  "browser.allowed-sites": {
    category: "browser",
    scope: "both",
  },
  "browser.chrome": {
    category: "browser",
    scope: "both",
  },
  "browser.codex-chrome": {
    category: "browser",
    scope: "both",
  },
  "browser.computer-use": {
    category: "browser",
    scope: "both",
  },
  "browser.profiles": {
    category: "browser",
  },
  "browser.cookie-import": {
    category: "browser",
  },
  "browser.snapshot": {
    category: "browser",
  },
  "conversation.send-shortcut": {
    category: "conversation",
  },
  "conversation.composer-editor": {
    category: "conversation",
  },
  "conversation.composer-collapse": {
    category: "conversation",
  },
  "conversation.compact-layout": {
    category: "conversation",
  },
  "conversation.streaming": {
    category: "conversation",
  },
  "conversation.remote-images": {
    category: "conversation",
  },
  "conversation.word-wrap": {
    category: "conversation",
  },
  "conversation.diff-default": {
    category: "conversation",
  },
  "conversation.work-log-detail": {
    category: "conversation",
  },
  "conversation.work-log-category": {
    category: "conversation",
  },
  "conversation.workflow-expand": {
    category: "conversation",
  },
  "conversation.command-output": {
    category: "conversation",
  },
  "conversation.command-expand": {
    category: "conversation",
  },
  "conversation.mcp-details": {
    category: "conversation",
  },
  "conversation.mcp-expand": {
    category: "conversation",
  },
  "conversation.reasoning": {
    category: "conversation",
  },
  "conversation.collapse-work-logs": {
    category: "conversation",
  },
  "conversation.inline-diffs": {
    category: "conversation",
  },
  "conversation.runtime-warnings": {
    category: "conversation",
  },
  "conversation.provider-metadata": {
    category: "conversation",
  },
  "conversation.display-density": {
    category: "conversation",
  },
  "general.diagnostics": {
    category: "general",
  },
  "general.sidebar-preview": {
    category: "general",
  },
  "general.task-sidebar": {
    category: "general",
  },
  "general.file-tree-limit": {
    category: "general",
  },
  "general.file-links": {
    category: "general",
  },
  "general.timestamp-format": {
    category: "general",
  },
  "general.window-title": {
    category: "general",
  },
  "general.quit-shortcut": {
    category: "general",
  },
  "general.confirm-delete": {
    category: "general",
  },
  "git.merge-agent-credits": {
    category: "git",
  },
  "git.review-guide-model": {
    category: "git",
  },
  "git.manage-worktrees": {
    category: "git",
  },
  "git.submodules": {
    category: "git",
    scope: "both",
  },
  "git.worktree-cleanup": {
    category: "git",
    scope: "both",
  },
  "git.worktree-disposable-paths": {
    category: "git",
    scope: "both",
  },
  "git.status-refresh": {
    category: "git",
  },
  "git.status-refresh-interval": {
    category: "git",
  },
  "git.auto-pull": {
    category: "git",
    scope: "both",
  },
  "git.text-model": {
    category: "git",
    scope: "both",
  },
  "git.writing": {
    category: "git",
    scope: "both",
  },
  "git.merge-method": {
    category: "git",
    scope: "both",
  },
  "git.pr-refresh": {
    category: "git",
  },
  "git.pr-refresh-interval": {
    category: "git",
  },
  "git.pr-discovery": {
    category: "git",
  },
  "git.pr-stalled": {
    category: "git",
  },
  "git.pr-exclude": {
    category: "git",
  },
  "keyboard.keybindings": {
    category: "keyboard",
  },
  "keyboard.search": {
    category: "keyboard",
  },
  "notifications.in-app": {
    category: "notifications",
  },
  "notifications.attention-badge": {
    category: "notifications",
  },
  "notifications.thread-status": {
    category: "notifications",
  },
  "notifications.pr-attention": {
    category: "notifications",
  },
  "project.providers": {
    category: "project",
    scope: "project",
  },
  "project.icon": {
    category: "project",
    scope: "project",
  },
  "project.memory": {
    category: "project",
    scope: "project",
  },
  "project.checked-in": {
    category: "project",
    scope: "project",
  },
  "project.reset": {
    category: "project",
    scope: "project",
  },
  "projects.base-directory": {
    category: "projects",
  },
  "projects.projects-root": {
    category: "projects",
  },
  "projects.list": {
    category: "projects",
  },
  "providers.instances": {
    category: "providers",
  },
  "providers.updates": {
    category: "providers",
  },
  "providers.legacy-overrides": {
    category: "providers",
  },
  "storage.attachments": {
    category: "storage",
  },
  "storage.automation": {
    category: "storage",
  },
  "storage.backup": {
    category: "storage",
  },
  "storage.backup-credentials": {
    category: "storage",
  },
  "storage.overview": {
    category: "storage",
  },
  "threads.default-permissions": {
    category: "threads",
    scope: "both",
  },
  "threads.default-workspace": {
    category: "threads",
    scope: "both",
  },
  "threads.follow-up": {
    category: "threads",
  },
  "threads.resume-turns": {
    category: "threads",
    scope: "both",
  },
  "threads.auto-continue": {
    category: "threads",
    scope: "both",
  },
  "threads.usage-sampling": {
    category: "threads",
  },
  "threads.prompt-suggestions": {
    category: "threads",
    scope: "project",
  },
  "threads.summaries": {
    category: "threads",
  },
  "threads.title-model": {
    category: "threads",
  },
  "threads.claude-subagents": {
    category: "threads",
    scope: "both",
  },
  "threads.claude-subagent-model": {
    category: "threads",
    scope: "both",
  },
  "tools.mcp": {
    category: "tools",
    scope: "both",
  },
});
const SETTINGS_ROUTE_BY_ID: ReadonlyMap<string, SettingsItemRoute> = new Map(
  Object.values(SETTINGS_ITEM_ROUTES).map((route) => [route.id, route]),
);
export function getSettingsItemRoute(value: unknown): SettingsItemRoute | null {
  if (typeof value !== "string") return null;
  const canonicalId = Object.hasOwn(LEGACY_SETTINGS_ITEM_ALIASES, value)
    ? LEGACY_SETTINGS_ITEM_ALIASES[value]!
    : value;
  return SETTINGS_ROUTE_BY_ID.get(canonicalId) ?? null;
}
/** Reads the project scope, accepting the pre-reorganization `projectId` param as well. */
export function resolveSettingsProjectIdFromSearch(search: unknown): ProjectId | undefined {
  const rawSearch = search as { project?: unknown; projectId?: unknown } | null | undefined;
  for (const raw of [rawSearch?.project, rawSearch?.projectId]) {
    if (typeof raw === "string" && raw.length > 0 && raw.length <= 256) {
      return ProjectId.makeUnsafe(raw);
    }
  }
  return undefined;
}

export interface SettingsSearch {
  readonly category: SettingsCategory;
  readonly item?: string;
  readonly project?: ProjectId;
}

/**
 * Canonical settings search for any raw search object. Resolves legacy category
 * and item names, and keeps the project scope only when the destination exists
 * in project scope.
 */
export function resolveSettingsSearch(search: unknown): SettingsSearch {
  const rawSearch = search as { category?: unknown; item?: unknown } | null | undefined;
  const project = resolveSettingsProjectIdFromSearch(search);
  const item = getSettingsItemRoute(rawSearch?.item);
  if (item) {
    const itemScope = item.scope ?? "global";
    if (itemScope === "project" && !project) return { category: "projects" };
    return {
      category: item.category,
      item: item.id,
      ...(project && itemScope !== "global" ? { project } : {}),
    };
  }

  const category = resolveSettingsCategoryAlias(rawSearch?.category);
  if (project) {
    if (category === null || category === "projects") return { category: "project", project };
    if (isProjectSettingsCategory(category)) return { category, project };
    return { category };
  }
  if (category === null) return { category: "general" };
  if (category === "project") return { category: "projects" };
  return { category };
}

export function resolveSettingsCategoryFromSearch(search: unknown): SettingsCategory {
  return resolveSettingsSearch(search).category;
}

export function resolveSettingsNavigationSearch(input: {
  readonly pathname: string;
  readonly search: unknown;
}): SettingsSearch {
  if (input.pathname === "/settings") return resolveSettingsSearch(input.search);
  return { category: "general" };
}
