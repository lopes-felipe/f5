import { describe, expect, it } from "vitest";
import {
  desktopCloseWindowItem,
  desktopRuntimeName,
  desktopWindowMenu,
  selectAppMenuWindow,
  selectReloadContents,
} from "./windowMenu";

describe("desktop window menu", () => {
  it("uses RFC 9110 product tokens in development and packaged builds", () => {
    for (const development of [true, false]) {
      expect(desktopRuntimeName(development).replaceAll(" ", "")).toMatch(
        /^[!#$%&'*+\-.^_|~0-9A-Za-z]+$/,
      );
    }
  });
  it("reloads a focused preview and otherwise the owning app window", () => {
    const page = { preview: true },
      app = { preview: false };
    expect(selectReloadContents(page, app, (contents) => contents.preview)).toBe(page);
    expect(selectReloadContents(app, app, (contents) => contents.preview)).toBe(app);
    expect(
      selectReloadContents(null, undefined, (contents: typeof page) => contents.preview),
    ).toBeUndefined();
  });
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
