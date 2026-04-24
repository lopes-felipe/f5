import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  normalizeFilePathForDiffLookup,
  shouldOpenFileInDiffPanel,
} from "./normalizeFilePathForDiff";

describe("normalizeFilePathForDiffLookup", () => {
  it("converts absolute paths within the workspace to relative paths", () => {
    expect(normalizeFilePathForDiffLookup("/repo/project/src/app.ts", "/repo/project")).toEqual({
      path: "src/app.ts",
      line: undefined,
      column: undefined,
      workspaceRelative: true,
    });
  });

  it("keeps already-relative paths and parses position suffixes", () => {
    expect(normalizeFilePathForDiffLookup("src/app.ts:42:7", "/repo/project")).toEqual({
      path: "src/app.ts",
      line: 42,
      column: 7,
      workspaceRelative: true,
    });
  });

  it("keeps absolute paths outside the workspace marked as editor-only", () => {
    expect(normalizeFilePathForDiffLookup("/tmp/snippet.ts", "/repo/project")).toEqual({
      path: "/tmp/snippet.ts",
      line: undefined,
      column: undefined,
      workspaceRelative: false,
    });
  });

  it("returns null for empty paths", () => {
    expect(normalizeFilePathForDiffLookup("", "/repo/project")).toBeNull();
  });

  it("prefers the diff panel for turn-scoped changed files without explicit positions", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const parsed = normalizeFilePathForDiffLookup("src/app.ts", "/repo/project");

    expect(
      shouldOpenFileInDiffPanel({
        parsedFilePath: parsed,
        turnId,
        diffFilePathsByTurnId: new Map([[turnId, new Set(["src/app.ts"])]]),
      }),
    ).toBe(true);
  });

  it("keeps positioned links in the raw file view even when the file changed in the turn", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const parsed = normalizeFilePathForDiffLookup("src/app.ts:42:7", "/repo/project");

    expect(
      shouldOpenFileInDiffPanel({
        parsedFilePath: parsed,
        turnId,
        diffFilePathsByTurnId: new Map([[turnId, new Set(["src/app.ts"])]]),
      }),
    ).toBe(false);
  });

  it("keeps links without a concrete turn in the raw file view", () => {
    const parsed = normalizeFilePathForDiffLookup("src/app.ts", "/repo/project");

    expect(
      shouldOpenFileInDiffPanel({
        parsedFilePath: parsed,
        turnId: undefined,
        diffFilePathsByTurnId: new Map([[TurnId.makeUnsafe("turn-1"), new Set(["src/app.ts"])]]),
      }),
    ).toBe(false);
  });
});
