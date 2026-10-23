import { describe, expect, it } from "vitest";

import {
  materializeUsageSearch,
  needsSearchNormalization,
  validateUsageSearch,
} from "./usageSearch";

describe("validateUsageSearch", () => {
  it("keeps valid params and drops invalid or default values and the retired provider param", () => {
    expect(
      validateUsageSearch({
        tab: "limits",
        range: "30d",
        provider: "codex",
        projectId: " project-1 ",
        metric: "cost",
      }),
    ).toEqual({
      tab: "limits",
      range: "30d",
      projectId: "project-1",
      metric: "cost",
    });
    expect(
      validateUsageSearch({
        tab: "x",
        range: "1y",
        provider: "nope",
        projectId: " ",
        metric: "tokens",
      }),
    ).toEqual({});
  });

  it("materializes tab and range that fell back to saved defaults", () => {
    const defaults = { tab: "activity", range: "7d" } as const;
    expect(materializeUsageSearch({}, defaults)).toEqual({ tab: "activity", range: "7d" });
    expect(materializeUsageSearch({ range: "30d", metric: "cost" }, defaults)).toEqual({
      tab: "activity",
      range: "30d",
      metric: "cost",
    });
    expect(materializeUsageSearch({ tab: "limits", range: "24h" }, defaults)).toBeNull();
  });

  it("detects URLs that need canonical replacement", () => {
    expect(needsSearchNormalization({ metric: "tokens" }, {})).toBe(true);
    expect(needsSearchNormalization({ range: "7d" }, { range: "7d" })).toBe(false);
  });
});
