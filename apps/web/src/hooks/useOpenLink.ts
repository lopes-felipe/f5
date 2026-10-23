import { createContext, useContext, useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { parsePullRequestReference } from "../lib/pullRequestReference";
import { ThreadId } from "@t3tools/contracts";
import { type AppSettings, useAppSettingsSelector } from "../appSettings";
import * as nativeApi from "../nativeApi";
import { useRightPanelStore } from "../rightPanelStore";
export function setMostRecentOpenLinkThread(_thread: ThreadId): void {}
export const OpenLinkThread = createContext<ThreadId | undefined>(undefined);
/** Web builds always use the system browser. Preview URLs require a current thread. */
function selectOpenLinkSettings(settings: AppSettings) {
  return {
    linkOpenTarget: settings.linkOpenTarget,
    pullRequestLinksOpenInApp: settings.pullRequestLinksOpenInApp,
    previewDefaults: { colorScheme: settings.previewDefaults.colorScheme },
  };
}

export function useOpenLink(threadId?: ThreadId) {
  // Every rendered markdown fragment calls this, so it must ignore unrelated setting writes.
  const settings = useAppSettingsSelector(selectOpenLinkSettings);
  const currentThread = useContext(OpenLinkThread);
  const router = useRouter({ warn: false });
  threadId ??= currentThread;
  return useCallback(
    async (url: string, options?: { external?: boolean }) => {
      const target = new URL(url, window.location.href);
      if (!["http:", "https:", "mailto:"].includes(target.protocol)) return;
      const owner = threadId;
      const pr = parsePullRequestReference(target.href);
      if (!options?.external && settings.pullRequestLinksOpenInApp && pr) {
        if (owner) {
          useRightPanelStore.getState().openPullRequest(owner, {
            key: formatSourceControlPullRequestKey(pr),
            url: target.href,
          });
          return;
        }
        if (router) {
          await router.navigate({ to: "/pull-requests", search: { url: target.href } });
          return;
        }
      }
      if (
        !options?.external &&
        !(pr && !settings.pullRequestLinksOpenInApp) &&
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
    [
      settings.linkOpenTarget,
      settings.pullRequestLinksOpenInApp,
      settings.previewDefaults.colorScheme,
      threadId,
      router,
    ],
  );
}
