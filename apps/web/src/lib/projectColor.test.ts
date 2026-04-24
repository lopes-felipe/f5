import { describe, expect, it } from "vitest";

import { getProjectColorClasses } from "./projectColor";

describe("getProjectColorClasses", () => {
  it("returns deterministic classes for the same key", () => {
    const a = getProjectColorClasses("project-abc");
    const b = getProjectColorClasses("project-abc");
    expect(a).toEqual(b);
  });

  it("produces different classes for different keys (best-effort)", () => {
    // Not a cryptographic guarantee, but across a handful of realistic
    // project ids we want visual separation.
    const classes = new Set(
      ["f3-code", "wolt", "t3-code", "sandbox", "docs-site"].map(
        (key) => getProjectColorClasses(key).bg,
      ),
    );
    // Palette has 10 entries; at minimum we expect >= 3 distinct buckets.
    expect(classes.size).toBeGreaterThanOrEqual(3);
  });

  it("returns a neutral fallback for empty keys", () => {
    const fallback = getProjectColorClasses("");
    expect(fallback.bg).toMatch(/muted/);
  });
});
