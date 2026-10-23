export * from "./settingsRouting";
import {
  LEGACY_SETTINGS_ITEM_ALIASES,
  type SettingsCategory,
  type SettingsScope,
} from "./settingsRouting";
import { ABOUT_SETTINGS_DESCRIPTORS } from "./categories/AboutSettings.descriptors";
import { ACCOUNTS_SETTINGS_DESCRIPTORS } from "./categories/AccountsSettings.descriptors";
import { APPEARANCE_SETTINGS_DESCRIPTORS } from "./categories/AppearanceSettings.descriptors";
import { ARCHIVE_SETTINGS_DESCRIPTORS } from "./categories/ArchiveSettings.descriptors";
import { BROWSER_SETTINGS_DESCRIPTORS } from "./categories/BrowserComputerSettings.descriptors";
import { CONVERSATION_SETTINGS_DESCRIPTORS } from "./categories/ConversationSettings.descriptors";
import { GENERAL_SETTINGS_DESCRIPTORS } from "./categories/GeneralSettings.descriptors";
import { GIT_SETTINGS_DESCRIPTORS } from "./categories/GitSettings.descriptors";
import { KEYBOARD_SETTINGS_DESCRIPTORS } from "./categories/KeyboardSettings.descriptors";
import { NOTIFICATIONS_SETTINGS_DESCRIPTORS } from "./categories/NotificationsSettings.descriptors";
import { PROJECT_SETTINGS_DESCRIPTORS } from "./categories/ProjectSettings.descriptors";
import { PROJECTS_SETTINGS_DESCRIPTORS } from "./categories/ProjectsSettings.descriptors";
import { PROVIDERS_SETTINGS_DESCRIPTORS } from "./categories/ProvidersSettings.descriptors";
import { STORAGE_SETTINGS_DESCRIPTORS } from "./categories/StorageSettings.descriptors";
import { THREADS_SETTINGS_DESCRIPTORS } from "./categories/ThreadsSettings.descriptors";
import { TOOLS_SETTINGS_DESCRIPTORS } from "./categories/ToolsSettings.descriptors";
import {
  searchSettingsItems,
  settingsItemVisibleInScope,
  type SettingsItemDescriptor,
} from "./settingsSearch";

export const SETTINGS_ITEM_DESCRIPTORS: ReadonlyArray<SettingsItemDescriptor> = [
  ...GENERAL_SETTINGS_DESCRIPTORS,
  ...APPEARANCE_SETTINGS_DESCRIPTORS,
  ...CONVERSATION_SETTINGS_DESCRIPTORS,
  ...KEYBOARD_SETTINGS_DESCRIPTORS,
  ...NOTIFICATIONS_SETTINGS_DESCRIPTORS,
  ...PROVIDERS_SETTINGS_DESCRIPTORS,
  ...THREADS_SETTINGS_DESCRIPTORS,
  ...TOOLS_SETTINGS_DESCRIPTORS,
  ...BROWSER_SETTINGS_DESCRIPTORS,
  ...PROJECTS_SETTINGS_DESCRIPTORS,
  ...GIT_SETTINGS_DESCRIPTORS,
  ...ACCOUNTS_SETTINGS_DESCRIPTORS,
  ...STORAGE_SETTINGS_DESCRIPTORS,
  ...ARCHIVE_SETTINGS_DESCRIPTORS,
  ...ABOUT_SETTINGS_DESCRIPTORS,
  ...PROJECT_SETTINGS_DESCRIPTORS,
];

const SETTINGS_ITEM_BY_ID = new Map<string, SettingsItemDescriptor>();
for (const descriptor of SETTINGS_ITEM_DESCRIPTORS) {
  if (SETTINGS_ITEM_BY_ID.has(descriptor.id)) {
    throw new Error(`Duplicate settings item descriptor: ${descriptor.id}`);
  }
  SETTINGS_ITEM_BY_ID.set(descriptor.id, descriptor);
}

export function getSettingsItemDescriptor(value: unknown): SettingsItemDescriptor | null {
  if (typeof value !== "string") return null;
  const canonicalId = Object.hasOwn(LEGACY_SETTINGS_ITEM_ALIASES, value)
    ? LEGACY_SETTINGS_ITEM_ALIASES[value]!
    : value;
  return SETTINGS_ITEM_BY_ID.get(canonicalId) ?? null;
}

export function isSettingsItemId(value: unknown): value is string {
  return getSettingsItemDescriptor(value) !== null;
}

export function filterSettingsItems(
  query: string,
  options: { readonly limit?: number; readonly scope?: SettingsScope } = {},
): SettingsItemDescriptor[] {
  const scope = options.scope ?? "global";
  return searchSettingsItems(
    SETTINGS_ITEM_DESCRIPTORS.filter((descriptor) => settingsItemVisibleInScope(descriptor, scope)),
    query,
    options.limit,
  );
}
