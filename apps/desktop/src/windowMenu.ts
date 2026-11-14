import type { MenuItemConstructorOptions } from "electron";

/** Electron strips spaces when constructing its User-Agent product token. */
export function desktopRuntimeName(development: boolean): string {
  return development ? "F5 Dev" : "F5";
}

export function selectReloadContents<T>(
  focused: T | null,
  owner: T | undefined,
  isPreview: (contents: T) => boolean,
): T | undefined {
  return focused && isPreview(focused) ? focused : owner;
}

/** Tab-close belongs to the renderer on every platform, including when no tab is open. */
export function desktopWindowMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
  return {
    role: "windowMenu",
    submenu: [
      { role: "minimize" },
      ...(platform === "darwin"
        ? [{ role: "zoom" as const }, { type: "separator" as const }, { role: "front" as const }]
        : []),
    ],
  };
}

export function desktopCloseWindowItem(): MenuItemConstructorOptions {
  return { label: "Close Window", click: (_item, window) => window?.close() };
}

/** Auxiliary windows have no app preload and cannot receive renderer menu actions. */
export function selectAppMenuWindow<T>(
  focused: T | null,
  main: T | null,
  windows: readonly T[],
  isAppWindow: (window: T) => boolean,
): T | null {
  if (focused && isAppWindow(focused)) return focused;
  if (main && isAppWindow(main)) return main;
  return windows.find(isAppWindow) ?? null;
}
