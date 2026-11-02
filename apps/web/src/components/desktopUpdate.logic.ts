import { formatByteSize } from "@t3tools/shared/byteSize";
import { formatRelativeTimeLabel } from "../lib/relativeTime";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "check" | "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return "install";
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  if (state.status === "error" && state.canRetry) return "check";
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading" || state.status === "preparing") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading" || state?.status === "preparing";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but F5 is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but F5 is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but F5 is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "preparing") return "Preparing update…";
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  // Failed downloads and installs keep "available"/"downloaded" status, so
  // check the error before the status to match the pill's Retry label.
  if (state.errorContext === "download" && state.availableVersion) {
    return `Download failed for ${state.availableVersion}. Click to retry.`;
  }
  if (state.errorContext === "install" && state.downloadedVersion) {
    return `Install failed for ${state.downloadedVersion}. Click to retry.`;
  }
  if (state.status === "error") {
    return `${(state.message ?? "Update check failed").replace(/[.!?\s]+$/, "")}. Click to retry.`;
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Restart to install.`;
  }
  return "Update available";
}

export function getDesktopUpdateReleaseNotes(state: DesktopUpdateState | null): string | null {
  if (!state || typeof state.releaseNotes !== "string") return null;
  const notes = state.releaseNotes.trim();
  return notes.length > 0 ? notes : null;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

export function getDesktopUpdateStatusSummary(
  state: DesktopUpdateState,
  nowMs = Date.now(),
): string {
  switch (state.status) {
    case "disabled":
      return state.message ?? "Updates are disabled.";
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return `F5 is up to date${state.checkedAt ? ` · checked ${formatRelativeTimeLabel(state.checkedAt, nowMs)}` : ""}`;
    case "available":
      return `Version ${state.availableVersion} is available`;
    case "downloading":
      return `Downloading ${state.availableVersion}… ${Math.floor(state.downloadPercent ?? 0)}%`;
    case "preparing":
      return "Preparing update…";
    case "downloaded":
      return `Version ${state.downloadedVersion} is ready to install`;
    case "error":
      return state.message ?? "Update check failed.";
  }
}
export function resolveAboutUpdateAction(
  state: DesktopUpdateState,
): "check" | "download" | "install" | "busy" | "none" {
  if (state.status === "disabled") return "none";
  if (state.status === "checking" || state.status === "downloading" || state.status === "preparing")
    return "busy";
  const action = resolveDesktopUpdateButtonAction(state);
  return action === "none" ? "check" : action;
}
export function isAboutUpdateActionDisabled(state: DesktopUpdateState): boolean {
  const action = resolveAboutUpdateAction(state);
  return action === "busy" || action === "none";
}

export type DesktopUpdatePillTone = "warning" | "info" | "success" | "destructive";
export type DesktopUpdatePillIcon = "available" | "progress" | "restart" | "installing" | "error";
export interface DesktopUpdatePill {
  tone: DesktopUpdatePillTone;
  icon: DesktopUpdatePillIcon;
  label: string;
  /** Download percent for the progress ring, 0–100. */
  percent: number | null;
}

/** The sidebar status pill for the current update phase, or null when hidden. */
export function resolveDesktopUpdatePill(
  state: DesktopUpdateState | null,
): DesktopUpdatePill | null {
  if (!state || !shouldShowDesktopUpdateButton(state)) return null;
  if (state.status === "downloading") {
    const percent = Math.max(0, Math.min(100, Math.floor(state.downloadPercent ?? 0)));
    return { tone: "info", icon: "progress", label: `${percent}%`, percent };
  }
  if (state.status === "preparing") {
    return { tone: "info", icon: "installing", label: "Installing", percent: null };
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (state.status === "error" || state.errorContext !== null) {
    return { tone: "destructive", icon: "error", label: "Retry", percent: null };
  }
  if (action === "install") {
    return { tone: "success", icon: "restart", label: "Restart", percent: null };
  }
  return {
    tone: "warning",
    icon: "available",
    label: state.availableVersion ?? "Update",
    percent: null,
  };
}

/** "38 MB of 92 MB · 4.1 MB/s · about 1 min left", omitting unknown parts. */
export function formatDesktopUpdateProgressDetail(state: DesktopUpdateState): string | null {
  const transferred = state.downloadTransferredBytes ?? null;
  const total = state.downloadTotalBytes ?? null;
  const speed = state.downloadBytesPerSecond ?? null;
  const parts: string[] = [];
  if (transferred !== null && total !== null && total > 0) {
    parts.push(`${formatByteSize(Math.min(transferred, total))} of ${formatByteSize(total)}`);
  }
  if (speed !== null && speed > 0) {
    parts.push(`${formatByteSize(speed)}/s`);
    if (transferred !== null && total !== null && total > transferred) {
      const seconds = (total - transferred) / speed;
      parts.push(
        seconds < 60 ? "less than a minute left" : `about ${Math.round(seconds / 60)} min left`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type DesktopUpdateInstallStepStatus = "done" | "active" | "pending";
export interface DesktopUpdateInstallStep {
  label: string;
  status: DesktopUpdateInstallStepStatus;
}

/**
 * Download → Prepare → Restart, positioned by the install phase. Windows close
 * as soon as agents start stopping, so that work is part of the Restart step.
 */
export function getDesktopUpdateInstallSteps(
  state: DesktopUpdateState,
): DesktopUpdateInstallStep[] {
  const active = state.status !== "preparing" ? 0 : state.installPhase === "stopping" ? 2 : 1;
  return ["Download", "Prepare", "Restart"].map((label, index) => ({
    label,
    status: index < active ? "done" : index === active ? "active" : "pending",
  }));
}

export function getDesktopUpdateInstallPhaseDescription(state: DesktopUpdateState): string {
  return state.installPhase === "stopping"
    ? "Closing windows and stopping agents…"
    : "Verifying and unpacking the update. This can take a minute.";
}

/**
 * A short, phase-level announcement for screen readers. It deliberately omits
 * the percent so the live region only speaks when the phase changes.
 */
export function getDesktopUpdatePhaseAnnouncement(state: DesktopUpdateState): string {
  const version = state.downloadedVersion ?? state.availableVersion ?? "update";
  if (state.status === "downloading") return `Downloading F5 ${version}`;
  if (state.status === "preparing") return `Installing F5 ${version}`;
  if (state.errorContext === "download") return `Download of F5 ${version} failed`;
  if (state.errorContext === "install") return `Installing F5 ${version} failed`;
  if (state.status === "error") return "Update check failed";
  if (state.status === "downloaded") return `F5 ${version} is ready to install`;
  if (state.status === "available") return `F5 ${version} is available`;
  return "";
}
