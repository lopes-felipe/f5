import { describe, expect, it } from "vitest";

import {
  claimRecentInstall,
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

describe("updateMachine", () => {
  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart({
      ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
      enabled: true,
      status: "error",
      message: "network",
      errorContext: "check",
      canRetry: true,
    });

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.canRetry).toBe(true);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("downloaded");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.canRetry).toBe(true);
  });

  it("clears stale download state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
      "Two important fixes",
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, { percent: 55.5 });

    expect(available.status).toBe("available");
    expect(available.releaseNotes).toBe("Two important fixes");
    expect(downloading.status).toBe("downloading");
    expect(downloading.releaseNotes).toBe("Two important fixes");
    expect(progress.releaseNotes).toBe("Two important fixes");
    expect(downloading.downloadPercent).toBe(0);
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });
});

it("keeps desktop download progress finite and within bounds", () => {
  const state = createInitialDesktopUpdateState("1.0.0", runtimeInfo);
  expect(reduceDesktopUpdateStateOnDownloadProgress(state, { percent: 120 }).downloadPercent).toBe(
    100,
  );
  expect(reduceDesktopUpdateStateOnDownloadProgress(state, { percent: -20 }).downloadPercent).toBe(
    0,
  );
  expect(
    reduceDesktopUpdateStateOnDownloadProgress(
      { ...state, downloadPercent: 42 },
      { percent: Number.NaN },
    ).downloadPercent,
  ).toBe(42);
});

it("tracks download bytes and clears them across the download lifecycle", () => {
  const available = {
    ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
    enabled: true,
    status: "available" as const,
    availableVersion: "1.1.0",
  };
  const progress = reduceDesktopUpdateStateOnDownloadProgress(
    reduceDesktopUpdateStateOnDownloadStart(available),
    { percent: 42, transferred: 38_000_000, total: 92_000_000, bytesPerSecond: 4_100_000 },
  );
  expect(progress.downloadTransferredBytes).toBe(38_000_000);
  expect(progress.downloadTotalBytes).toBe(92_000_000);
  expect(progress.downloadBytesPerSecond).toBe(4_100_000);

  // Missing or invalid samples keep the last known values.
  const sparse = reduceDesktopUpdateStateOnDownloadProgress(progress, {
    percent: 43,
    bytesPerSecond: Number.NaN,
  });
  expect(sparse.downloadTransferredBytes).toBe(38_000_000);
  expect(sparse.downloadBytesPerSecond).toBe(4_100_000);

  const complete = reduceDesktopUpdateStateOnDownloadComplete(progress, "1.1.0");
  expect(complete.downloadTotalBytes).toBe(92_000_000);
  expect(complete.downloadTransferredBytes).toBe(92_000_000);
  expect(complete.downloadBytesPerSecond).toBeNull();

  const failed = reduceDesktopUpdateStateOnDownloadFailure(progress, "network");
  expect(failed.downloadTransferredBytes).toBeNull();
  expect(failed.downloadTotalBytes).toBeNull();
  expect(failed.downloadBytesPerSecond).toBeNull();

  const restarted = reduceDesktopUpdateStateOnDownloadStart({ ...progress, status: "available" });
  expect(restarted.downloadTransferredBytes).toBeNull();
  expect(restarted.downloadTotalBytes).toBeNull();
});

it("hands the recent install to exactly one claimer", () => {
  const recentlyInstalled = { fromVersion: "1.0.0", toVersion: "1.1.0", releaseNotes: null };
  const state = {
    ...createInitialDesktopUpdateState("1.1.0", runtimeInfo),
    recentlyInstalled,
  };
  const first = claimRecentInstall(state);
  expect(first.claimed).toEqual(recentlyInstalled);
  expect(first.state.recentlyInstalled).toBeNull();
  const second = claimRecentInstall(first.state);
  expect(second.claimed).toBeNull();
  expect(second.state).toBe(first.state);
});

it("clears the install phase when an install fails", () => {
  const state = reduceDesktopUpdateStateOnInstallFailure(
    {
      ...createInitialDesktopUpdateState("1.0.0", runtimeInfo),
      enabled: true,
      status: "preparing",
      downloadedVersion: "1.1.0",
      installPhase: "stopping",
    },
    "F5 did not restart",
  );
  expect(state.installPhase).toBeNull();
});
