import { describe, expect, it, vi } from "vitest";
import { appZoomMenu, selectAppZoomWindow, zoomAppContents } from "./appZoom";

describe("app zoom", () => {
  it("zooms focused recovery windows while keeping auxiliary-window fallback on the app", () => {
    const app = { kind: "app" },
      recovery = { kind: "recovery" },
      auxiliary = { kind: "auxiliary" };
    const isApp = (window: typeof app) => window.kind === "app";
    const isRecovery = (window: typeof app) => window.kind === "recovery";
    const windows = [app, recovery, auxiliary];
    expect(selectAppZoomWindow(recovery, app, windows, isApp, isRecovery)).toBe(recovery);
    expect(selectAppZoomWindow(recovery, null, [recovery], isApp, isRecovery)).toBe(recovery);
    expect(selectAppZoomWindow(auxiliary, app, windows, isApp, isRecovery)).toBe(app);
    expect(selectAppZoomWindow(null, null, [recovery], isApp, isRecovery)).toBeNull();
  });
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
