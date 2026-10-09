import type { ComputerAutomationBackendStatus } from "@t3tools/contracts";
import type { IpcMain } from "electron";

export const COMPUTER_AUTOMATION_STATUS_CHANNEL = "desktop-computer:status";

/**
 * F5-native computer control stays off until it passes certification (see
 * docs/agent-browser.md). Reporting the reason lets every surface explain the
 * blocker instead of offering a weaker, uncertified fallback.
 */
export function computerAutomationStatus(
  platform: NodeJS.Platform = process.platform,
): ComputerAutomationBackendStatus {
  if (platform !== "darwin" && platform !== "win32") {
    return {
      available: false,
      reason: "unsupported-platform",
      detail: "F5-native computer control is planned for macOS and Windows only.",
    };
  }
  return {
    available: false,
    reason: "not-certified",
    detail:
      "F5-native computer control has not passed its safety certification (per-app consent, kill switch, input isolation), so it is disabled in this build.",
  };
}

export function registerComputerAutomationIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(COMPUTER_AUTOMATION_STATUS_CHANNEL);
  ipcMain.handle(COMPUTER_AUTOMATION_STATUS_CHANNEL, () => computerAutomationStatus());
}
