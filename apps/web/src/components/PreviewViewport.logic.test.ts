import { describe, expect, it } from "vitest";

import {
  clampPreviewViewport,
  orientPreviewViewport,
  PREVIEW_VIEWPORT_PRESETS,
  resizePreviewViewport,
} from "./PreviewViewport.logic";

describe("preview viewport layout", () => {
  it("keeps the required preset dimensions", () => {
    expect(PREVIEW_VIEWPORT_PRESETS).toEqual([
      { id: "responsive", label: "Responsive", dimensions: null },
      { id: "phone", label: "375 × 812", dimensions: { width: 375, height: 812 } },
      { id: "tablet", label: "768 × 1024", dimensions: { width: 768, height: 1024 } },
      { id: "desktop", label: "1280 × 720", dimensions: { width: 1280, height: 720 } },
    ]);
  });

  it("swaps width and height when orientation changes", () => {
    expect(orientPreviewViewport({ width: 375, height: 812 }, "landscape")).toEqual({
      width: 812,
      height: 375,
    });
    expect(orientPreviewViewport({ width: 1280, height: 720 }, "portrait")).toEqual({
      width: 720,
      height: 1280,
    });
  });

  it("clamps custom sizes to minimums and panel bounds", () => {
    expect(
      clampPreviewViewport({
        requested: { width: 200, height: 2_000 },
        bounds: { width: 900, height: 700 },
      }),
    ).toEqual({ width: 320, height: 700 });
  });

  it("preserves aspect ratio only while viewport linking is enabled", () => {
    expect(
      resizePreviewViewport({
        initial: { width: 800, height: 400 },
        delta: { width: 200, height: 300 },
        linked: true,
        bounds: { width: 1_200, height: 900 },
      }),
    ).toEqual({ width: 1_000, height: 500 });
    expect(
      resizePreviewViewport({
        initial: { width: 800, height: 400 },
        delta: { width: 200, height: 300 },
        linked: false,
        bounds: { width: 1_200, height: 900 },
      }),
    ).toEqual({ width: 1_000, height: 700 });
  });
});
