import { ProjectId } from "@t3tools/contracts";

import { ABOUT_SETTINGS_DESCRIPTORS } from "./categories/AboutSettings.descriptors";
import { ARCHIVE_SETTINGS_DESCRIPTORS } from "./categories/ArchiveSettings.descriptors";
import { DISPLAY_SETTINGS_DESCRIPTORS } from "./categories/DisplaySettings.descriptors";
import { GENERAL_SETTINGS_DESCRIPTORS } from "./categories/GeneralSettings.descriptors";
import { INTEGRATIONS_SETTINGS_DESCRIPTORS } from "./categories/IntegrationsSettings.descriptors";
import { NOTIFICATIONS_SETTINGS_DESCRIPTORS } from "./categories/NotificationsSettings.descriptors";
import { PROJECTS_SETTINGS_DESCRIPTORS } from "./categories/ProjectsSettings.descriptors";
import { PROVIDERS_SETTINGS_DESCRIPTORS } from "./categories/ProvidersSettings.descriptors";
import { STORAGE_SETTINGS_DESCRIPTORS } from "./categories/StorageSettings.descriptors";
import { searchSettingsItems, type SettingsItemDescriptor } from "./settingsSearch";

export const SETTINGS_CATEGORIES = [
  "general",
  "display",
  "notifications",
  "providers",
  "integrations",
  "projects",
  "archive",
  "storage",
  "about",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_CATEGORY_LABELS = {
  general: "General",
  display: "Display",
  notifications: "Notifications",
  providers: "Providers & Models",
  integrations: "Integrations",
  projects: "Projects",
  archive: "Archive",
  storage: "Storage",
  about: "About",
} as const satisfies Record<SettingsCategory, string>;

export const SETTINGS_ITEM_DESCRIPTORS = [
  ...GENERAL_SETTINGS_DESCRIPTORS,
  ...DISPLAY_SETTINGS_DESCRIPTORS,
  ...NOTIFICATIONS_SETTINGS_DESCRIPTORS,
  ...PROVIDERS_SETTINGS_DESCRIPTORS,
  ...INTEGRATIONS_SETTINGS_DESCRIPTORS,
  ...PROJECTS_SETTINGS_DESCRIPTORS,
  ...ARCHIVE_SETTINGS_DESCRIPTORS,
  ...STORAGE_SETTINGS_DESCRIPTORS,
  ...ABOUT_SETTINGS_DESCRIPTORS,
] satisfies ReadonlyArray<SettingsItemDescriptor>;

const SETTINGS_ITEM_BY_ID = new Map<string, SettingsItemDescriptor>();
for (const descriptor of SETTINGS_ITEM_DESCRIPTORS) {
  if (SETTINGS_ITEM_BY_ID.has(descriptor.id)) {
    throw new Error(`Duplicate settings item descriptor: ${descriptor.id}`);
  }
  SETTINGS_ITEM_BY_ID.set(descriptor.id, descriptor);
}

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

export function getSettingsItemDescriptor(value: unknown): SettingsItemDescriptor | null {
  if (typeof value !== "string") return null;
  return SETTINGS_ITEM_BY_ID.get(value) ?? null;
}

export function isSettingsItemId(value: unknown): value is string {
  return getSettingsItemDescriptor(value) !== null;
}

export function filterSettingsItems(query: string, limit?: number): SettingsItemDescriptor[] {
  return searchSettingsItems(SETTINGS_ITEM_DESCRIPTORS, query, limit);
}

export function resolveSettingsProjectIdFromSearch(search: unknown): ProjectId | undefined {
  const raw = (search as { projectId?: unknown } | null | undefined)?.projectId;
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256
    ? ProjectId.makeUnsafe(raw)
    : undefined;
}

export function resolveSettingsCategoryFromSearch(search: unknown): SettingsCategory {
  const rawSearch = search as { category?: unknown; item?: unknown } | null | undefined;
  const item = getSettingsItemDescriptor(rawSearch?.item);
  if (item) return item.category;
  const raw = rawSearch?.category;
  return isSettingsCategory(raw) ? raw : "general";
}

export function resolveSettingsNavigationSearch(input: {
  readonly pathname: string;
  readonly search: unknown;
}): {
  readonly category: SettingsCategory;
  readonly item?: string;
  readonly projectId?: ProjectId;
} {
  if (input.pathname === "/settings") {
    const rawSearch = input.search as { item?: unknown } | null | undefined;
    const item = getSettingsItemDescriptor(rawSearch?.item);
    const projectId = resolveSettingsProjectIdFromSearch(input.search);
    return {
      category: item?.category ?? resolveSettingsCategoryFromSearch(input.search),
      ...(item ? { item: item.id } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }

  return { category: "general" };
}
