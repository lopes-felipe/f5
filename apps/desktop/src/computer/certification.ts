import type { ComputerAutomationBackendStatus } from "@t3tools/contracts";
import { release } from "node:os";

/** Only signed, installed certification runs may open these gates. */
export const COMPUTER_CONTROL_CERTIFIED = { darwin: false, win32: false } as const;
export function computerCertificationStatus(
  platform: string,
  packaged: boolean,
  devOverride: string | undefined,
  osVersion = release(),
): ComputerAutomationBackendStatus {
  if (platform !== "darwin" && platform !== "win32")
    return {
      available: false,
      reason: "unsupported-platform",
      detail: "Computer control requires macOS 14+ or Windows 10 2004+.",
    };
  const version = osVersion.split(".").map(Number);
  if (
    !version.every(Number.isInteger) ||
    (platform === "darwin" && (version[0] ?? 0) < 23) ||
    (platform === "win32" && ((version[0] ?? 0) < 10 || (version[2] ?? 0) < 19041))
  )
    return {
      available: false,
      reason: "os-too-old",
      detail: "Computer control requires macOS 14+ or Windows 10 2004+.",
    };
  if (!COMPUTER_CONTROL_CERTIFIED[platform] && (packaged || devOverride !== "1"))
    return {
      available: false,
      reason: "not-certified",
      detail: "Computer control is awaiting signed-build safety certification.",
    };
  return { available: true };
}
