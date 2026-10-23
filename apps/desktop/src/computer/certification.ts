import type { ComputerAutomationBackendStatus, ComputerBackgroundStatus } from "@t3tools/contracts";
import { isIntegrationCertified } from "@t3tools/shared/providerIntegrationCertification";
import { release } from "node:os";

/** Only signed, installed certification runs may open these gates. */
export const COMPUTER_CONTROL_CERTIFIED = { darwin: false, win32: false } as const;
/** Explicit opt-in preview availability is separate from signed-build certification. */
export const COMPUTER_CONTROL_PREVIEW = { darwin: true, win32: false } as const;
/**
 * Background (accessibility-only) control alongside the user. Available in the macOS preview;
 * users still choose it in Settings, and the foreground stays the default execution mode.
 */
export const COMPUTER_BACKGROUND_PREVIEW = { darwin: true, win32: false } as const;
export function computerBackgroundGate(
  platform: string,
  packaged: boolean,
  devOverride: string | undefined,
): ComputerBackgroundStatus {
  if (platform !== "darwin") return { available: false, reason: "unsupported-platform" };
  if (!COMPUTER_BACKGROUND_PREVIEW.darwin && (packaged || devOverride !== "1"))
    return { available: false, reason: "preview-off" };
  return { available: true };
}
/** Provider-native Chrome control reads the shared certification records, like the server. */
export function chromeControlCertified(
  provider: "claude" | "codex",
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return isIntegrationCertified(
    provider === "claude" ? "claude-chrome" : "codex-chrome",
    platform,
    arch,
  );
}
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
  if (
    !COMPUTER_CONTROL_CERTIFIED[platform] &&
    !COMPUTER_CONTROL_PREVIEW[platform] &&
    (packaged || devOverride !== "1")
  )
    return {
      available: false,
      reason: "not-certified",
      detail: "Computer control is awaiting signed-build safety certification.",
    };
  return { available: true };
}
