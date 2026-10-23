import { describe, expect, it } from "vitest";

import {
  batchLiteralPathspecs,
  isGitImport,
  parseNumstatPaths,
  parseTurnDiffFilesFromUnifiedDiff,
} from "./Diffs.ts";

describe("git import filtering helpers", () => {
  it("parses numstat records, keeping both sides of a rename", () => {
    expect(
      parseNumstatPaths("1\t2\ta.txt\0-\t-\timage.png\0" + "3\t0\t\0old.ts\0new.ts\0"),
    ).toEqual([
      { path: "a.txt" },
      { path: "image.png" },
      { path: "new.ts", previousPath: "old.ts" },
    ]);
  });

  it("keeps a rename when either side was authored", () => {
    const authored = new Set(["old.ts"]);
    expect(isGitImport({ path: "new.ts", previousPath: "old.ts" }, authored)).toBe(false);
    expect(isGitImport({ path: "pulled.ts" }, authored)).toBe(true);
  });

  it("batches literal pathspecs without splitting a rename", () => {
    const long = "x".repeat(12_000);
    expect(batchLiteralPathspecs([])).toEqual([]);
    expect(batchLiteralPathspecs([[`${long}1`], [`${long}2`, `${long}3`]])).toEqual([
      [`:(literal)${long}1`],
      [`:(literal)${long}2`, `:(literal)${long}3`],
    ]);
  });
});

describe("parseTurnDiffFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", () => {
    expect(parseTurnDiffFilesFromUnifiedDiff("")).toEqual([]);
  });

  it("parses per-file additions and deletions", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
    ]);
  });
});
