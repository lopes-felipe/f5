import { shell, systemPreferences } from "electron";
import type { ComputerPermission } from "@t3tools/contracts";
export function capturePermissions() {
  return {
    supported: process.platform === "darwin",
    screen:
      process.platform === "darwin" &&
      systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility:
      process.platform === "darwin" && systemPreferences.isTrustedAccessibilityClient(false),
  };
}
export async function openComputerPermissionSettings(kind: ComputerPermission): Promise<void> {
  if (process.platform !== "darwin") return;
  await shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${kind === "screen-recording" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"}`,
  );
}
export async function requestComputerPermission(kind: ComputerPermission): Promise<void> {
  if (process.platform !== "darwin") return;
  if (kind === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
  else await openComputerPermissionSettings(kind);
}
