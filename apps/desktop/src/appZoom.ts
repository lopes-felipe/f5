import type { MenuItemConstructorOptions } from "electron";

export type AppZoomDirection = "in" | "out" | "reset";
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
