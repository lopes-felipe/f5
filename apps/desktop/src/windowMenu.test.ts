import { describe, expect, it } from "vitest";
import { desktopCloseWindowItem, desktopWindowMenu, selectAppMenuWindow } from "./windowMenu";

describe("desktop window menu", () => {
  it("excludes recovery windows from focused and main-window fallbacks", () => {
    const auxiliary = { app: false },
      app = { app: true };
    const isApp = (window: typeof app) => window.app;
    expect(selectAppMenuWindow(auxiliary, null, [auxiliary], isApp)).toBeNull();
    expect(selectAppMenuWindow(auxiliary, auxiliary, [auxiliary, app], isApp)).toBe(app);
  });
  it.each(["darwin", "linux", "win32"] as const)("leaves Cmd/Ctrl+W to tabs on %s", (platform) => {
    const menu = desktopWindowMenu(platform);
    expect(Array.isArray(menu.submenu)).toBe(true);
    const items = [
      desktopCloseWindowItem(),
      ...(menu.submenu as Electron.MenuItemConstructorOptions[]),
    ];
    expect(items.some((item) => item.role === "close")).toBe(false);
    expect(items.some((item) => item.accelerator?.toLowerCase().endsWith("+w"))).toBe(false);
  });
});
