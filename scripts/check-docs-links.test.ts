import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findBrokenDocLinks, findUndocumentedBuiltInDrivers } from "./check-docs-links.ts";

describe("documentation hygiene", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");

  it("has no broken relative links across active docs", () => {
    expect(findBrokenDocLinks(repoRoot)).toEqual([]);
  });

  it("documents every built-in provider driver in docs/provider-prerequisites.md", () => {
    expect(findUndocumentedBuiltInDrivers(repoRoot)).toEqual([]);
  });
});
