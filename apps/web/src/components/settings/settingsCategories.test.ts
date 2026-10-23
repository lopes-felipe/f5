import { SETTINGS_CATEGORY_ICONS } from "./settingsCategoryIcons";
import { describe, expect, it } from "vitest";

import {
  GLOBAL_SETTINGS_CATEGORIES,
  LEGACY_SETTINGS_CATEGORY_ALIASES,
  LEGACY_SETTINGS_ITEM_ALIASES,
  PROJECT_SETTINGS_CATEGORIES,
  PROJECT_SETTINGS_CATEGORY_GROUPS,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  SETTINGS_CATEGORY_LABELS,
  SETTINGS_ITEM_DESCRIPTORS,
  SETTINGS_ITEM_ROUTES,
  filterSettingsItems,
  getSettingsItemDescriptor,
  isProjectSettingsCategory,
  resolveSettingsCategoryFromSearch,
  resolveSettingsNavigationSearch,
  resolveSettingsSearch,
} from "./settingsCategories";

describe("settings navigation groups", () => {
  it("keeps every route backed by exactly one descriptor with the same scope", () => {
    expect(SETTINGS_ITEM_DESCRIPTORS.map((item) => item.id).toSorted()).toEqual(
      Object.keys(SETTINGS_ITEM_ROUTES).toSorted(),
    );
    for (const item of SETTINGS_ITEM_DESCRIPTORS) {
      const route = SETTINGS_ITEM_ROUTES[item.id as keyof typeof SETTINGS_ITEM_ROUTES];
      expect({ id: item.id, category: item.category, scope: item.scope ?? "global" }).toEqual({
        id: route.id,
        category: route.category,
        scope: "scope" in route ? route.scope : "global",
      });
    }
  });
  it("lists every global category exactly once, in category order", () => {
    expect(SETTINGS_CATEGORY_GROUPS.flatMap((group) => group.categories)).toEqual([
      ...GLOBAL_SETTINGS_CATEGORIES,
    ]);
  });

  it("lists every project-scope category exactly once, in category order", () => {
    expect(PROJECT_SETTINGS_CATEGORY_GROUPS.flatMap((group) => group.categories)).toEqual([
      ...PROJECT_SETTINGS_CATEGORIES,
    ]);
  });

  it("groups Interface, Agents, Workspace, Account & data, then About on its own", () => {
    expect(SETTINGS_CATEGORY_GROUPS.map((group) => group.label)).toEqual([
      "Interface",
      "Agents",
      "Workspace",
      "Account & data",
      null,
    ]);
    expect(SETTINGS_CATEGORY_GROUPS.at(-1)?.categories).toEqual(["about"]);
  });

  it("keeps the Project page out of global scope", () => {
    expect(GLOBAL_SETTINGS_CATEGORIES).not.toContain("project");
    expect(PROJECT_SETTINGS_CATEGORIES[0]).toBe("project");
  });

  it("has a label and icon for every category", () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(SETTINGS_CATEGORY_ICONS[category]).toBeDefined();
      expect(SETTINGS_CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
  });
});

describe("settings item descriptors", () => {
  it("uses unique IDs and known categories", () => {
    expect(new Set(SETTINGS_ITEM_DESCRIPTORS.map((descriptor) => descriptor.id)).size).toBe(
      SETTINGS_ITEM_DESCRIPTORS.length,
    );
    for (const descriptor of SETTINGS_ITEM_DESCRIPTORS) {
      expect(SETTINGS_CATEGORIES).toContain(descriptor.category);
      expect(descriptor.id.startsWith(`${descriptor.category}.`)).toBe(true);
    }
  });

  it("only marks items as project-scoped on pages that exist in project scope", () => {
    for (const descriptor of SETTINGS_ITEM_DESCRIPTORS) {
      if ((descriptor.scope ?? "global") === "global") {
        expect(descriptor.category).not.toBe("project");
      } else {
        expect(isProjectSettingsCategory(descriptor.category)).toBe(true);
      }
    }
  });

  it("searches controls from categories that are not mounted", () => {
    expect(filterSettingsItems("terminal font size")[0]?.id).toBe("appearance.terminal-size");
    expect(filterSettingsItems("Claude CLI arguments")[0]?.id).toBe("providers.legacy-overrides");
    expect(filterSettingsItems("model context protocol server")[0]?.id).toBe("tools.mcp");
    expect(filterSettingsItems("encrypted backup credentials").map(({ id }) => id)).toContain(
      "storage.backup-credentials",
    );
    expect(filterSettingsItems("merge method")[0]?.id).toBe("git.merge-method");
    expect(filterSettingsItems("manage worktrees")[0]?.id).toBe("git.manage-worktrees");
  });

  it("limits search to the items the current scope renders", () => {
    expect(filterSettingsItems("project memory").map(({ id }) => id)).not.toContain(
      "project.memory",
    );
    expect(filterSettingsItems("project memory", { scope: "project" })[0]?.id).toBe(
      "project.memory",
    );
    expect(filterSettingsItems("timestamp", { scope: "project" })).toEqual([]);
    expect(filterSettingsItems("merge method", { scope: "project" })[0]?.id).toBe(
      "git.merge-method",
    );
  });

  it("resolves only registered item IDs", () => {
    expect(getSettingsItemDescriptor("project.memory")?.category).toBe("project");
    expect(getSettingsItemDescriptor("general.theme")?.id).toBe("appearance.theme");
    expect(getSettingsItemDescriptor("missing.setting")).toBeNull();
  });

  it("keeps Agent Bridge out of search and current or legacy deep links", () => {
    expect(filterSettingsItems("Agent Bridge")).toEqual([]);
    expect(filterSettingsItems("bots")).toEqual([]);
    for (const item of ["tools.agent-bridge", "integrations.agent-bridge"]) {
      expect(getSettingsItemDescriptor(item)).toBeNull();
      expect(resolveSettingsSearch({ category: "tools", item })).toEqual({ category: "tools" });
      expect(resolveSettingsSearch({ category: "integrations", item })).toEqual({
        category: "tools",
      });
    }
  });
});

describe("legacy aliases", () => {
  it("maps every legacy category to an existing category", () => {
    for (const target of Object.values(LEGACY_SETTINGS_CATEGORY_ALIASES)) {
      expect(SETTINGS_CATEGORIES).toContain(target);
    }
  });

  it("maps every legacy item ID to an existing descriptor", () => {
    for (const [legacy, target] of Object.entries(LEGACY_SETTINGS_ITEM_ALIASES)) {
      expect(getSettingsItemDescriptor(legacy)?.id, legacy).toBe(target);
    }
  });

  it("does not shadow a current item ID", () => {
    const currentIds = new Set(SETTINGS_ITEM_DESCRIPTORS.map((descriptor) => descriptor.id));
    for (const legacy of Object.keys(LEGACY_SETTINGS_ITEM_ALIASES)) {
      expect(currentIds.has(legacy), legacy).toBe(false);
    }
  });
});

describe("resolveSettingsCategoryFromSearch", () => {
  it("returns the requested category when valid", () => {
    expect(resolveSettingsCategoryFromSearch({ category: "storage" })).toBe("storage");
  });

  it("resolves legacy category names", () => {
    expect(resolveSettingsCategoryFromSearch({ category: "display" })).toBe("conversation");
    expect(resolveSettingsCategoryFromSearch({ category: "integrations" })).toBe("tools");
    expect(resolveSettingsCategoryFromSearch({ category: "profiles" })).toBe("accounts");
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

describe("resolveSettingsSearch", () => {
  it("rewrites legacy item deep links to the new page", () => {
    expect(
      resolveSettingsSearch({ category: "integrations", item: "integrations.keybindings" }),
    ).toEqual({ category: "keyboard", item: "keyboard.keybindings" });
  });

  it("rewrites the old projectId param to the project scope", () => {
    expect(
      resolveSettingsSearch({ category: "projects", item: "projects.icon", projectId: "p-1" }),
    ).toEqual({ category: "project", item: "project.icon", project: "p-1" });
    expect(resolveSettingsSearch({ category: "projects", projectId: "p-1" })).toEqual({
      category: "project",
      project: "p-1",
    });
  });

  it("keeps project scope only for pages that exist there", () => {
    expect(resolveSettingsSearch({ category: "git", project: "p-1" })).toEqual({
      category: "git",
      project: "p-1",
    });
    expect(resolveSettingsSearch({ category: "appearance", project: "p-1" })).toEqual({
      category: "appearance",
    });
    expect(resolveSettingsSearch({ item: "general.timestamp-format", project: "p-1" })).toEqual({
      category: "general",
      item: "general.timestamp-format",
    });
  });

  it("sends project-only destinations without a project to the Projects list", () => {
    expect(resolveSettingsSearch({ category: "project" })).toEqual({ category: "projects" });
    expect(resolveSettingsSearch({ item: "project.memory" })).toEqual({ category: "projects" });
  });
});

describe("resolveSettingsNavigationSearch", () => {
  it("preserves valid category search on the settings route", () => {
    expect(
      resolveSettingsNavigationSearch({
        pathname: "/settings",
        search: { category: "tools" },
      }),
    ).toEqual({ category: "tools" });
  });

  it("preserves valid item and project deep links on the settings route", () => {
    expect(
      resolveSettingsNavigationSearch({
        pathname: "/settings",
        search: { category: "general", item: "project.memory", project: "project-2" },
      }),
    ).toEqual({ category: "project", item: "project.memory", project: "project-2" });
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
