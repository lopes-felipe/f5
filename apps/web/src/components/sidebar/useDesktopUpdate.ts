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

const INSTALLED_TOAST_KEY_PREFIX = "f5.updateInstalledToast.";

/** Claims the post-install toast for this version once across windows. */
function claimInstalledToast(toVersion: string): boolean {
  const key = `${INSTALLED_TOAST_KEY_PREFIX}${toVersion}`;
  try {
    if (window.localStorage.getItem(key) !== null) return false;
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Without storage the toast may repeat per window, which is acceptable.
  }
  return true;
}

/**
 * Desktop auto-update state and the sidebar's update pill behaviour.
 * Only one mounted instance should pass `announceInstall`.
 */
export function useDesktopUpdate(options: { announceInstall?: boolean } = {}) {
  const { announceInstall = false } = options;
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installedNotes, setInstalledNotes] = useState<DesktopUpdateRecentInstall | null>(null);

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
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
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

  const recentlyInstalled = desktopUpdateState?.recentlyInstalled ?? null;
  useEffect(() => {
    if (!announceInstall || !recentlyInstalled) return;
    if (!claimInstalledToast(recentlyInstalled.toVersion)) return;
    const notes = recentlyInstalled.releaseNotes?.trim();
    toastManager.add({
      type: "success",
      title: `Updated to F5 ${recentlyInstalled.toVersion}`,
      description: `You were on ${recentlyInstalled.fromVersion}.`,
      ...(notes
        ? {
            actionProps: {
              children: "What's new",
              onClick: () => setInstalledNotes(recentlyInstalled),
            },
          }
        : {}),
    });
  }, [announceInstall, recentlyInstalled]);

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
        if (action === "download" && result.completed)
          toastManager.add({
            type: "success",
            title: "Update downloaded",
            description: `F5 ${result.state.downloadedVersion ?? "update"} is ready. Restart to install it.`,
            actionProps: {
              children: "Restart to update",
              onClick: () => void runAction("install"),
            },
          });
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
