import type {
  DesktopRuntimeInfo,
  DesktopUpdateRecentInstall,
  DesktopUpdateState,
} from "@t3tools/contracts";

import { getCanRetryAfterDownloadFailure, nextStatusAfterDownloadFailure } from "./updateState";

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
): DesktopUpdateState {
  return {
    channel: "stable",
    enabled: false,
    status: "disabled",
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: null,
    downloadPercent: null,
    downloadTransferredBytes: null,
    downloadTotalBytes: null,
    downloadBytesPerSecond: null,
    installPhase: null,
    recentlyInstalled: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const CLEARED_DOWNLOAD_BYTES = {
  downloadTransferredBytes: null,
  downloadTotalBytes: null,
  downloadBytesPerSecond: null,
} as const;

/** The subset of electron-updater's ProgressInfo the UI shows. */
export interface DesktopUpdateDownloadProgress {
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

function finiteBytes(value: number | undefined, fallback: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : (fallback ?? null);
}

export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...state,
    status: "checking",
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string,
  canRetry = true,
): DesktopUpdateState {
  return {
    ...state,
    status: "error",
    message,
    checkedAt,
    downloadPercent: null,
    errorContext: "check",
    canRetry,
  };
}

export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
  releaseNotes: string | null = null,
): DesktopUpdateState {
  return {
    ...state,
    status: "available",
    availableVersion: version,
    downloadedVersion: null,
    releaseNotes,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: 0,
    ...CLEARED_DOWNLOAD_BYTES,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    message,
    downloadPercent: null,
    ...CLEARED_DOWNLOAD_BYTES,
    errorContext: "download",
    canRetry: getCanRetryAfterDownloadFailure(state),
  };
}

export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  progress: DesktopUpdateDownloadProgress,
): DesktopUpdateState {
  const { percent } = progress;
  return {
    ...state,
    status: "downloading",
    downloadPercent: Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : (state.downloadPercent ?? 0),
    downloadTransferredBytes: finiteBytes(progress.transferred, state.downloadTransferredBytes),
    downloadTotalBytes: finiteBytes(progress.total, state.downloadTotalBytes),
    downloadBytesPerSecond: finiteBytes(progress.bytesPerSecond, state.downloadBytesPerSecond),
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
  releaseNotes: string | null = state.releaseNotes ?? null,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    releaseNotes,
    downloadPercent: 100,
    downloadTransferredBytes: state.downloadTotalBytes ?? state.downloadTransferredBytes ?? null,
    downloadBytesPerSecond: null,
    message: null,
    errorContext: null,
    canRetry: true,
  };
}

/** Hands the recent install to exactly one caller and clears it for everyone else. */
export function claimRecentInstall(state: DesktopUpdateState): {
  claimed: DesktopUpdateRecentInstall | null;
  state: DesktopUpdateState;
} {
  const claimed = state.recentlyInstalled ?? null;
  return { claimed, state: claimed ? { ...state, recentlyInstalled: null } : state };
}

export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    installPhase: null,
    message,
    errorContext: "install",
    canRetry: true,
  };
}
