import { describe, expect, it } from "vitest";

import { resolveContextMenuPopupPosition } from "./contextMenuPosition";

describe("resolveContextMenuPopupPosition", () => {
  it("converts renderer CSS pixels with the active zoom factor", () => {
    expect(resolveContextMenuPopupPosition({ x: 120.8, y: 80.4 }, 1.5)).toEqual({
      x: 181,
      y: 120,
    });
  });

  it("uses unscaled coordinates when the zoom factor is invalid", () => {
    expect(resolveContextMenuPopupPosition({ x: 12.9, y: 8.9 }, Number.NaN)).toEqual({
      x: 12,
      y: 8,
    });
  });

  it("rejects invalid or negative renderer coordinates", () => {
    expect(resolveContextMenuPopupPosition({ x: -1, y: 1 }, 1.5)).toBeNull();
    expect(resolveContextMenuPopupPosition({ x: 1, y: Number.POSITIVE_INFINITY }, 1.5)).toBeNull();
    expect(resolveContextMenuPopupPosition(undefined, 1.5)).toBeNull();
  });
});
