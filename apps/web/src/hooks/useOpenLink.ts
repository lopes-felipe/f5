import { createContext, useContext, useCallback } from "react";
import { ThreadId } from "@t3tools/contracts";
import { useAppSettings } from "../appSettings";
import * as nativeApi from "../nativeApi";
import { useRightPanelStore } from "../rightPanelStore";
export function setMostRecentOpenLinkThread(_thread: ThreadId): void {}
export const OpenLinkThread = createContext<ThreadId | undefined>(undefined);
/** Web builds always use the system browser. Preview URLs require a current thread. */
export function useOpenLink(threadId?: ThreadId) {
  const { settings } = useAppSettings();
  const currentThread = useContext(OpenLinkThread);
  threadId ??= currentThread;
  return useCallback(
    async (url: string) => {
      const target = new URL(url, window.location.href);
      if (!["http:", "https:", "mailto:"].includes(target.protocol)) return;
      const owner = threadId;
      if (
        window.desktopBridge?.preview &&
        settings.linkOpenTarget === "preview" &&
        owner &&
        ["http:", "https:"].includes(target.protocol)
      ) {
        await nativeApi.ensureNativeApi().preview.open({
          threadId: owner,
          url: target.href,
          colorScheme: settings.previewDefaults.colorScheme,
        });
        useRightPanelStore.getState().open(owner, "preview");
        return;
      }
      if (!window.desktopBridge) {
        window.open(target.href, "_blank", "noopener,noreferrer");
        return;
      }
      await window.desktopBridge.openExternal(target.href);
    },
    [settings.linkOpenTarget, settings.previewDefaults.colorScheme, threadId],
  );
}
