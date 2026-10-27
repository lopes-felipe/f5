import { describe, expect, it, vi } from "vitest";
import { appZoomMenu, zoomAppContents } from "./appZoom";

describe("app zoom", () => {
  it("routes every accelerator to the app rather than a focused Electron role", () => {
    const zoom = vi.fn();
    const items = appZoomMenu(zoom);
    expect(items.map((item) => item.accelerator)).toEqual([
      "CmdOrCtrl+0",
      "CmdOrCtrl+=",
      "CmdOrCtrl+Plus",
      "CmdOrCtrl+-",
    ]);
    for (const item of items) {
      expect(item.role).toBeUndefined();
      item.click?.({} as never, undefined, {} as never);
    }
    expect(zoom.mock.calls).toEqual([["reset"], ["in"], ["in"], ["out"]]);
  });
  it("changes only the supplied app contents in Electron's half-level steps", () => {
    let level = 0;
    const contents = {
      getZoomLevel: () => level,
      setZoomLevel: (next: number) => {
        level = next;
      },
    };
    zoomAppContents(contents, "out");
    expect(level).toBe(-0.5);
    zoomAppContents(contents, "in");
    expect(level).toBe(0);
    zoomAppContents(contents, "in");
    expect(level).toBe(0.5);
    zoomAppContents(contents, "reset");
    expect(level).toBe(0);
  });
});
