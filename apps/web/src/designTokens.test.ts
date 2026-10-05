import { describe, expect, it } from "vitest";

import {
  DESIGN_TOKEN_RULE_NAMES,
  type DesignTokenCounts,
  countDesignTokenViolations,
  isDesignTokenScannedPath,
} from "./designTokenRules";

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx,css}", "!./**/*.test.{ts,tsx}", "!./**/*.browser.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

function scannedFiles(): Map<string, DesignTokenCounts> {
  const files = new Map<string, DesignTokenCounts>();
  for (const [key, source] of Object.entries(sources)) {
    const relativePath = key.replace(/^\.\//, "");
    if (!isDesignTokenScannedPath(relativePath)) continue;
    files.set(relativePath, countDesignTokenViolations(source));
  }
  return files;
}

describe("design tokens", () => {
  const files = scannedFiles();

  it("scans the source tree", () => {
    expect(files.size).toBeGreaterThan(100);
  });

  it("uses no banned styling patterns anywhere", () => {
    const violations: string[] = [];
    for (const [path, counts] of files) {
      for (const rule of DESIGN_TOKEN_RULE_NAMES) {
        const actual = counts[rule] ?? 0;
        if (actual > 0) violations.push(`${path}: ${rule} ${actual}`);
      }
    }
    expect(
      violations,
      "Use semantic tokens (text-2xs, text-faint-foreground, text-success-foreground, rounded-md...) instead. `bun apps/web/scripts/codemod-ui-tokens.ts --write <files>` rewrites most of them.",
    ).toEqual([]);
  });
});

describe("countDesignTokenViolations", () => {
  it("counts each banned pattern", () => {
    expect(
      countDesignTokenViolations(
        [
          "text-emerald-600 dark:bg-amber-500/10 border-l-sky-400",
          "text-[11px] text-[0.8rem] text-[var(--x)]",
          "text-muted-foreground/70 text-foreground/50 text-muted-foreground/0",
          "rounded-[10px] rounded-t-[4px] rounded-[inherit]",
        ].join(" "),
      ),
    ).toEqual({ palette: 3, arbitraryText: 2, fadedText: 2, pxRadius: 2 });
  });

  it("ignores semantic tokens", () => {
    expect(
      countDesignTokenViolations(
        "text-2xs text-faint-foreground bg-success/10 text-success-foreground rounded-md",
      ),
    ).toEqual({});
  });
});
