import type {
  DesktopUpdateChannel,
  DesktopUpdateRecentInstall,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import {
  resolveAboutUpdateAction,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseNotes,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdatePill,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { toastManager } from "../ui/toast";

/**
 * Desktop auto-update state and the sidebar's update pill behaviour.
 * Only one mounted instance per window should pass `announce`; it raises the
 * download-complete and post-install toasts.
 */
export function useDesktopUpdate(options: { announce?: boolean } = {}) {
  const { announce = false } = options;
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installedNotes, setInstalledNotes] = useState<DesktopUpdateRecentInstall | null>(null);
  // Set per downloading → downloaded transition. Detected in the subscription
  // rather than across renders, which can batch both broadcasts into one.
  const [completedDownload, setCompletedDownload] = useState<{
    version: string | null;
  } | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    let lastStatus: DesktopUpdateState["status"] | null = null;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      if (lastStatus === "downloading" && nextState.status === "downloaded") {
        setCompletedDownload({ version: nextState.downloadedVersion });
      }
      lastStatus = nextState.status;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        lastStatus = nextState.status;
        setDesktopUpdateState(nextState);
      })
      .catch((error) => {
        console.warn("Failed to fetch the desktop update state", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // The main process hands the recent install to one caller across every
  // window and profile. Key on the version: each IPC state is a fresh clone.
  const recentInstallVersion = desktopUpdateState?.recentlyInstalled?.toVersion ?? null;
  useEffect(() => {
    if (!announce || !recentInstallVersion) return;
    const claim = window.desktopBridge?.claimRecentUpdateInstall;
    if (typeof claim !== "function") return;
    void claim()
      .then((installed) => {
        if (!installed) return;
        const notes = installed.releaseNotes?.trim();
        toastManager.add({
          type: "success",
          title: `Updated to F5 ${installed.toVersion}`,
          description: `You were on ${installed.fromVersion}.`,
          ...(notes
            ? {
                actionProps: {
                  children: "What's new",
                  onClick: () => setInstalledNotes(installed),
                },
              }
            : {}),
        });
      })
      .catch((error) => {
        console.warn("Failed to claim the recent update install", error);
      });
  }, [announce, recentInstallVersion]);

  const pill = isElectron ? resolveDesktopUpdatePill(desktopUpdateState) : null;
  const showButton = pill !== null;
  const tooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";
  const releaseNotes = getDesktopUpdateReleaseNotes(desktopUpdateState);
  const buttonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const buttonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;

  const [channelPending, setChannelPending] = useState(false);
  const runAction = useCallback(
    async (action: "check" | "download" | "install" | "none" | "busy"): Promise<void> => {
      const bridge = window.desktopBridge;
      if (!bridge || action === "none" || action === "busy") return;
      try {
        const result =
          action === "check"
            ? await bridge.checkForUpdates?.()
            : action === "download"
              ? await bridge.downloadUpdate()
              : await bridge.installUpdate();
        if (!result) return;
        const actionError = getDesktopUpdateActionError(result);
        if (shouldToastDesktopUpdateActionResult(result) && actionError)
          toastManager.add({
            type: "error",
            title: `Could not ${action} update`,
            description: actionError,
          });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not ${action} update`,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [],
  );
  const handleButtonClick = useCallback(() => {
    if (!buttonDisabled) void runAction(buttonAction);
  }, [buttonDisabled, buttonAction, runAction]);
  // Toast on the state transition so downloads started from the app menu get
  // the same Restart action as ones started from the pill.
  useEffect(() => {
    if (!announce || !completedDownload) return;
    toastManager.add({
      type: "success",
      title: "Update downloaded",
      description: `F5 ${completedDownload.version ?? "update"} is ready. Restart to install it.`,
      actionProps: {
        children: "Restart to update",
        onClick: () => void runAction("install"),
      },
    });
  }, [announce, completedDownload, runAction]);

  const closeInstalledNotes = useCallback(() => setInstalledNotes(null), []);
  const handleAboutAction = useCallback(() => {
    if (desktopUpdateState) void runAction(resolveAboutUpdateAction(desktopUpdateState));
  }, [desktopUpdateState, runAction]);
  const setChannel = useCallback(async (channel: DesktopUpdateChannel) => {
    const bridge = window.desktopBridge;
    if (typeof bridge?.setUpdateChannel !== "function") return;
    setChannelPending(true);
    try {
      const result = await bridge.setUpdateChannel(channel);
      if (!result.accepted || !result.completed)
        toastManager.add({
          type: "error",
          title: "Could not change update channel",
          description: result.state.message ?? "Try again.",
        });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not change update channel",
        description: String(error),
      });
    } finally {
      setChannelPending(false);
    }
  }, []);

  return {
    state: desktopUpdateState,
    channelPending,
    setChannel,
    handleAboutAction,
    pill,
    showButton,
    tooltip,
    releaseNotes,
    buttonDisabled,
    buttonAction,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    handleButtonClick,
    installedNotes,
    closeInstalledNotes,
  };
}

export type DesktopUpdateController = ReturnType<typeof useDesktopUpdate>;
