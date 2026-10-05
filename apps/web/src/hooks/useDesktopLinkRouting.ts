import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import { useAppSettings } from "../appSettings";
import { useOpenLink, setMostRecentOpenLinkThread } from "./useOpenLink";
export function useDesktopLinkRouting() {
  const params = useParams({ strict: false }) as { threadId?: string };
  const { settings } = useAppSettings();
  useEffect(() => {
    if (params.threadId) setMostRecentOpenLinkThread(ThreadId.makeUnsafe(params.threadId));
  }, [params.threadId]);
  const openLink = useOpenLink(params.threadId ? ThreadId.makeUnsafe(params.threadId) : undefined);
  useEffect(() => {
    void window.desktopBridge?.preview
      ?.setLinkOpenTarget?.(settings.linkOpenTarget)
      .catch(() => undefined);
  }, [settings.linkOpenTarget]);
  useEffect(
    () =>
      window.desktopBridge?.preview?.onOpenLink?.((url) => {
        void openLink(url).catch(() => undefined);
      }),
    [openLink],
  );
}
