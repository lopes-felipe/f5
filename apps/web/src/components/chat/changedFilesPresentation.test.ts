import { describe, expect, it } from "vitest";

import {
  isChangedFileExpandedByDefault,
  resolveChangedFilesPresentation,
} from "./changedFilesPresentation";

describe("resolveChangedFilesPresentation", () => {
  it("expands a small newest result", () => {
    expect(
      resolveChangedFilesPresentation({ fileCount: 5, changedLineCount: 200, isNewest: true }),
    ).toBe("expanded");
  });

  it("compacts a large newest result to a three-file preview", () => {
    expect(
      resolveChangedFilesPresentation({ fileCount: 6, changedLineCount: 40, isNewest: true }),
    ).toBe("compact");
    expect(isChangedFileExpandedByDefault({ presentation: "compact", fileIndex: 2 })).toBe(true);
    expect(isChangedFileExpandedByDefault({ presentation: "compact", fileIndex: 3 })).toBe(false);
  });

  it("collapses older results regardless of size", () => {
    expect(
      resolveChangedFilesPresentation({ fileCount: 1, changedLineCount: 1, isNewest: false }),
    ).toBe("collapsed");
  });
});
