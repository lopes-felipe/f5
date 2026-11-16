import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useStartupReady } from "~/lib/startupReady";

import { toastManager } from "../ui/toast";
import { promptLinkDeliveryState } from "./promptLinkDelivery";

/**
 * Opens the prompt links the OS handed the desktop app. Links wait in the main process until
 * this window takes them: once startup is ready, when told a link arrived while this window has
 * focus, and whenever the window gains focus.
 */
export function DesktopPromptLinkController() {
  const navigate = useNavigate();
  const startupReady = useStartupReady();
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!startupReady || !bridge?.takePromptLinks) return;
    const take = () => {
      void bridge
        .takePromptLinks?.()
        .then(({ links, profileName }) => {
          // Several links at once are opened as the user clicked them, so the last one wins.
          const path = links.map(promptLinkAppPath).findLast((candidate) => candidate !== null);
          if (!path) return;
          void navigate({ href: path, state: promptLinkDeliveryState() });
          if (profileName)
            toastManager.add({
              type: "info",
              title: `Opened the link in your ${profileName} profile`,
            });
        })
        .catch(() => {});
    };
    take();
    const unsubscribe = bridge.onPromptLinksAvailable?.(() => {
      if (document.hasFocus()) take();
    });
    window.addEventListener("focus", take);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", take);
    };
  }, [navigate, startupReady]);
  return null;
}
