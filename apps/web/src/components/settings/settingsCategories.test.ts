import { describe, expect, it } from "vitest";

import {
  SETTINGS_ITEM_DESCRIPTORS,
  filterSettingsItems,
  getSettingsItemDescriptor,
  resolveSettingsCategoryFromSearch,
  resolveSettingsNavigationSearch,
} from "./settingsCategories";

describe("settings item descriptors", () => {
  it("uses unique IDs and known categories", () => {
    expect(new Set(SETTINGS_ITEM_DESCRIPTORS.map((descriptor) => descriptor.id)).size).toBe(
      SETTINGS_ITEM_DESCRIPTORS.length,
    );
    expect(SETTINGS_ITEM_DESCRIPTORS.every((descriptor) => descriptor.category.length > 0)).toBe(
      true,
    );
  });

  it("searches controls from categories that are not mounted", () => {
    expect(filterSettingsItems("Claude CLI arguments")[0]?.id).toBe("providers.claude-args");
    expect(filterSettingsItems("model context protocol server")[0]?.id).toBe("integrations.mcp");
    expect(filterSettingsItems("encrypted backup credentials").map(({ id }) => id)).toContain(
      "storage.backup-credentials",
    );
  });

  it("resolves only registered item IDs", () => {
    expect(getSettingsItemDescriptor("projects.memory")?.category).toBe("projects");
    expect(getSettingsItemDescriptor("missing.setting")).toBeNull();
  });
});

describe("resolveSettingsCategoryFromSearch", () => {
  it("returns the requested category when valid", () => {
    expect(resolveSettingsCategoryFromSearch({ category: "storage" })).toBe("storage");
  });

  it("falls back to general for missing or malformed values", () => {
    expect(resolveSettingsCategoryFromSearch(undefined)).toBe("general");
    expect(resolveSettingsCategoryFromSearch(null)).toBe("general");
    expect(resolveSettingsCategoryFromSearch({ category: "bogus" })).toBe("general");
    expect(resolveSettingsCategoryFromSearch({ category: 123 })).toBe("general");
  });

  it("uses a valid item deep link as the canonical category", () => {
    expect(
      resolveSettingsCategoryFromSearch({
        category: "general",
        item: "providers.claude-args",
      }),
    ).toBe("providers");
  });
});

describe("resolveSettingsNavigationSearch", () => {
  it("preserves valid category search on the settings route", () => {
    expect(
      resolveSettingsNavigationSearch({
        pathname: "/settings",
        search: { category: "integrations" },
      }),
    ).toEqual({ category: "integrations" });
  });

  it("preserves valid item and project deep links on the settings route", () => {
    expect(
      resolveSettingsNavigationSearch({
        pathname: "/settings",
        search: {
          category: "general",
          item: "projects.memory",
          projectId: "project-2",
        },
      }),
    ).toEqual({
      category: "projects",
      item: "projects.memory",
      projectId: "project-2",
    });
  });

  it("falls back to general away from the settings route", () => {
    expect(
      resolveSettingsNavigationSearch({
        pathname: "/",
        search: { category: "projects" },
      }),
    ).toEqual({ category: "general" });
  });
});
