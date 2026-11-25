import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractMarkdownLinkTargets,
  findBrokenDocLinks,
  findUndocumentedBuiltInDrivers,
} from "./check-docs-links.ts";

describe("documentation hygiene", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");

  it("has no broken relative links across active docs", () => {
    expect(findBrokenDocLinks(repoRoot)).toEqual([]);
  });

  it("documents every built-in provider driver in docs/provider-prerequisites.md", () => {
    expect(findUndocumentedBuiltInDrivers(repoRoot)).toEqual([]);
  });

  it("respects CommonMark fence matching, tilde fences, inline code, and balanced parens", () => {
    const sample = [
      "Real [guide](docs/guide.md) and [parens](docs/file(v1).md).",
      "Inline `[ignored](missing-inline.md)` link.",
      "````markdown",
      "```",
      "[still-fenced](missing-nested.md)",
      "```",
      "````",
      "~~~",
      "[tilde-fenced](missing-tilde.md)",
      "~~~",
      "After [valid](docs/after.md).",
    ].join("\n");
    expect(extractMarkdownLinkTargets(sample)).toEqual([
      "docs/guide.md",
      "docs/file(v1).md",
      "docs/after.md",
    ]);
  });
});
