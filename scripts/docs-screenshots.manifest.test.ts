import { readdirSync, readFileSync } from "node:fs";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import { DOCS_SHOTS } from "./docs-screenshots.manifest.ts";

const repoRoot = Path.resolve(import.meta.dirname, "..");
const imagesDir = Path.join(repoRoot, "docs/images");
const manifestIds = new Set(DOCS_SHOTS.map((shot) => shot.id));

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = Path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("docs screenshot manifest", () => {
  it("uses unique shot ids", () => {
    expect(manifestIds.size).toBe(DOCS_SHOTS.length);
  });

  it("captures every image in docs/images", () => {
    const orphans = readdirSync(imagesDir)
      .filter((name) => name.endsWith(".webp"))
      .map((name) => name.slice(0, -".webp".length))
      .filter((id) => !manifestIds.has(id));
    expect(orphans).toEqual([]);
  });

  it("captures every docs image that markdown references", () => {
    const sources = [
      ...markdownFiles(Path.join(repoRoot, "docs")),
      ...["README.md", "KEYBINDINGS.md", "REMOTE.md"].map((name) => Path.join(repoRoot, name)),
    ];
    const missing: string[] = [];
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(/images\/([\w-]+)\.webp/g)) {
        if (!manifestIds.has(match[1]!)) {
          missing.push(`${Path.relative(repoRoot, file)}: ${match[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
