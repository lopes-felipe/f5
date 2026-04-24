import { describe, expect, it } from "vitest";

import {
  resolveSettingsCategoryFromSearch,
  resolveSettingsNavigationSearch,
} from "./settingsCategories";

describe("resolveSettingsCategoryFromSearch", () => {
  it("returns the requested category when valid", () => {
    expect(resolveSettingsCategoryFromSearch({ category: "projects" })).toBe("projects");
  });

  it("falls back to general for missing or malformed values", () => {
    expect(resolveSettingsCategoryFromSearch(undefined)).toBe("general");
    expect(resolveSettingsCategoryFromSearch(null)).toBe("general");
    expect(resolveSettingsCategoryFromSearch({ category: "bogus" })).toBe("general");
    expect(resolveSettingsCategoryFromSearch({ category: 123 })).toBe("general");
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

  it("falls back to general away from the settings route", () => {
    expect(
      resolveSettingsNavigationSearch({
        pathname: "/",
        search: { category: "projects" },
      }),
    ).toEqual({ category: "general" });
  });
});
