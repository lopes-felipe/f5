import type { DesktopUpdateState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseNotes,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { toastManager } from "../ui/toast";

/** Desktop auto-update state and the sidebar's update button behaviour. */
export function useDesktopUpdate() {
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);

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

  const showButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);
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
  const buttonInteractivityClasses = buttonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const buttonToneClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-success-foreground"
      : desktopUpdateState?.status === "downloading"
        ? "text-info-foreground"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-destructive-foreground motion-safe:animate-pulse"
          : "text-warning-foreground motion-safe:animate-pulse";

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (buttonDisabled || buttonAction === "none") return;

    if (buttonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (buttonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [buttonAction, buttonDisabled, desktopUpdateState]);

  return {
    state: desktopUpdateState,
    showButton,
    tooltip,
    releaseNotes,
    buttonDisabled,
    buttonAction,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    buttonInteractivityClasses,
    buttonToneClasses,
    handleButtonClick,
  };
}

export type DesktopUpdateController = ReturnType<typeof useDesktopUpdate>;
