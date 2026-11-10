import type { DesktopNotificationActivation } from "@t3tools/contracts";
import { useEffect } from "react";

import { useStartupReady } from "~/lib/startupReady";

import { useOpenNotificationTarget, type NotificationTarget } from "./openTarget";

/** The user clicked these in order, so the last one is where they want to be. */
export function selectActivationTarget(
  activations: readonly DesktopNotificationActivation[],
): NotificationTarget | null {
  for (let index = activations.length - 1; index >= 0; index -= 1) {
    const target = activations[index]!.target;
    if (target.kind !== "none") return target;
  }
  return null;
}

/**
 * Opens what a clicked desktop notification points to. Clicks wait in the main process until
 * this window takes them: once startup is ready (a window the click created), when told, and
 * whenever the window gains focus.
 */
export function NotificationActivationRouter(props: {
  onActivated?: (activations: readonly DesktopNotificationActivation[]) => void;
}) {
  const openTarget = useOpenNotificationTarget();
  const startupReady = useStartupReady();
  const { onActivated } = props;
  useEffect(() => {
    const bridge = window.desktopBridge?.notifications;
    if (!startupReady || !bridge) return;
    let disposed = false;
    const take = () => {
      void bridge
        .takeActivations()
        .then((activations) => {
          if (disposed || activations.length === 0) return;
          onActivated?.(activations);
          const target = selectActivationTarget(activations);
          // The main process already brought the window forward.
          if (target) void openTarget(target, { focus: false });
        })
        .catch(() => {});
    };
    take();
    const unsubscribe = bridge.onActivationsAvailable(take);
    window.addEventListener("focus", take);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("focus", take);
    };
  }, [onActivated, openTarget, startupReady]);
  return null;
}
