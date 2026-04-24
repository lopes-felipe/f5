import { describe, expect, it } from "vitest";

import {
  clearDiffSearchParams,
  clearFileViewSearchParams,
  parseDiffRouteSearch,
} from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops diff-only values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffFilePath: "src/app.ts",
    });
  });

  it("parses file view parameters", () => {
    const parsed = parseDiffRouteSearch({
      fileViewPath: "src/app.ts",
      fileLine: "42",
      fileEndLine: 48,
      fileColumn: "7",
    });

    expect(parsed).toEqual({
      fileViewPath: "src/app.ts",
      fileLine: 42,
      fileEndLine: 48,
      fileColumn: 7,
    });
  });

  it("preserves file-view parameters even when diff is explicitly closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/diff.ts",
      fileViewPath: "src/app.ts",
      fileLine: "42",
    });

    expect(parsed).toEqual({
      fileViewPath: "src/app.ts",
      fileLine: 42,
    });
  });

  it("preserves diff selection while raw file view is active", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/diff.ts",
      fileViewPath: "src/app.ts",
      fileLine: "42",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/diff.ts",
      fileViewPath: "src/app.ts",
      fileLine: 42,
    });
  });

  it("drops file position without a raw file path", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      fileLine: "42",
      fileEndLine: "48",
      fileColumn: "7",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("clears diff and file-view search params with explicit undefined values", () => {
    expect(
      clearDiffSearchParams({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/diff.ts",
        fileViewPath: "src/app.ts",
        fileLine: 42,
        fileEndLine: 48,
        fileColumn: 7,
        preserveMe: "ok",
      }),
    ).toEqual({
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      fileViewPath: undefined,
      fileLine: undefined,
      fileEndLine: undefined,
      fileColumn: undefined,
      preserveMe: "ok",
    });
  });

  it("clears only file-view search params while preserving diff selection", () => {
    expect(
      clearFileViewSearchParams({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/diff.ts",
        fileViewPath: "src/app.ts",
        fileLine: 42,
        fileEndLine: 48,
        fileColumn: 7,
        preserveMe: "ok",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/diff.ts",
      fileViewPath: undefined,
      fileLine: undefined,
      fileEndLine: undefined,
      fileColumn: undefined,
      preserveMe: "ok",
    });
  });
});
