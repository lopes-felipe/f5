import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { serverConfigQueryOptions } from "../lib/serverReactQuery";

/**
 * Pushes `storageCleanup.previewArtifactRetentionDays` to the desktop preview
 * artifact store. Waits for the server settings to load: sending the default
 * first would expire artifacts a longer configured retention still keeps.
 */
export function usePreviewArtifactRetentionSync(): void {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const days = serverConfigQuery.data?.settings?.storageCleanup.previewArtifactRetentionDays;
  const sentRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (days === undefined || sentRef.current === days) return;
    const setRetention = window.desktopBridge?.preview?.setArtifactRetention;
    if (!setRetention) return;
    sentRef.current = days;
    void setRetention(days).catch((error: unknown) => {
      sentRef.current = undefined;
      console.warn("Could not apply preview artifact retention", error);
    });
  }, [days]);
}
