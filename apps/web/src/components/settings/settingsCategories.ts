export const SETTINGS_CATEGORIES = [
  "general",
  "display",
  "notifications",
  "providers",
  "integrations",
  "projects",
  "about",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  general: "General",
  display: "Display",
  notifications: "Notifications",
  providers: "Providers & Models",
  integrations: "Integrations",
  projects: "Projects",
  about: "About",
};

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

export function resolveSettingsCategoryFromSearch(search: unknown): SettingsCategory {
  const raw = (search as { category?: unknown } | null | undefined)?.category;
  return isSettingsCategory(raw) ? raw : "general";
}

export function resolveSettingsNavigationSearch(input: {
  readonly pathname: string;
  readonly search: unknown;
}): {
  readonly category: SettingsCategory;
} {
  if (input.pathname === "/settings") {
    return { category: resolveSettingsCategoryFromSearch(input.search) };
  }

  return { category: "general" };
}
