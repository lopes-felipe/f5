import type { MenuItemConstructorOptions } from "electron";

/** Tab-close belongs to the renderer on every platform, including when no tab is open. */
export function desktopWindowMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
  return {
    role: "windowMenu",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(platform === "darwin"
        ? [{ type: "separator" as const }, { role: "front" as const }]
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
