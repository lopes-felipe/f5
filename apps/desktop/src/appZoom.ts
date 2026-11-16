import type { MenuItemConstructorOptions } from "electron";
import { selectAppMenuWindow } from "./windowMenu";

export type AppZoomDirection = "in" | "out" | "reset";

/** Recovery windows can zoom, but cannot receive renderer menu actions. */
export function selectAppZoomWindow<T>(
  focused: T | null,
  main: T | null,
  windows: readonly T[],
  isAppWindow: (window: T) => boolean,
  isRecoveryWindow: (window: T) => boolean,
): T | null {
  if (focused && isRecoveryWindow(focused)) return focused;
  return selectAppMenuWindow(focused, main, windows, isAppWindow);
}

export function zoomAppContents(
  contents: { getZoomLevel(): number; setZoomLevel(level: number): void },
  direction: AppZoomDirection,
): void {
  contents.setZoomLevel(
    direction === "reset" ? 0 : contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
  );
}

/** Electron's zoom roles target the focused guest or DevTools instead of the app. */
export function appZoomMenu(
  zoom: (direction: AppZoomDirection) => void,
): MenuItemConstructorOptions[] {
  return [
    { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom("reset") },
    { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => zoom("in") },
    { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", visible: false, click: () => zoom("in") },
    { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom("out") },
  ];
}
