import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
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

  it("respects CommonMark fence matching, tilde fences, inline code, balanced parens, and reference links", () => {
    const sample = [
      "Real [guide](docs/guide.md) and [parens](docs/file(v1).md) and [ref][missing-ref].",
      "Inline `[ignored](missing-inline.md)` link.",
      "````markdown",
      "```",
      "[still-fenced](missing-nested.md)",
      "[fenced-ref]: missing-fenced-ref.md",
      "```",
      "````",
      "~~~",
      "[tilde-fenced](missing-tilde.md)",
      "~~~",
      "After [valid](docs/after.md).",
      "[missing-ref]: docs/missing-ref.md",
    ].join("\n");
    expect(extractMarkdownLinkTargets(sample)).toEqual([
      "docs/guide.md",
      "docs/file(v1).md",
      "docs/after.md",
      "docs/missing-ref.md",
    ]);
  });

  it("handles percent-encoded paths, malformed escapes, and unclosed parens without backtracking", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "f5-docs-links-"));
    try {
      mkdirSync(path.join(tmpRoot, "docs"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "docs", "My Guide.md"), "# Guide\n");
      writeFileSync(path.join(tmpRoot, "docs", "ordinary.md"), "# Ordinary\n");
      writeFileSync(
        path.join(tmpRoot, "README.md"),
        [
          "[Encoded](docs/My%20Guide.md?ref=1#top)",
          "[Ordinary](docs/ordinary.md)",
          "[Malformed](docs/bad%E0%A4%A.md)",
          "[Ref][broken-ref]",
          "[Unclosed](aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "",
          "[broken-ref]: docs/missing.md",
        ].join("\n"),
      );

      const started = performance.now();
      const broken = findBrokenDocLinks(tmpRoot);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(broken).toEqual(["README.md -> docs/bad%E0%A4%A.md", "README.md -> docs/missing.md"]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
