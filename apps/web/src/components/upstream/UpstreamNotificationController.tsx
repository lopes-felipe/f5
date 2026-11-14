import { useEffect } from "react";

import { useUpstreamPortsInvalidation } from "../../lib/upstreamPortsReactQuery";
import { readNativeApi } from "../../nativeApi";
import { notify } from "../../notificationCenter/notify";
import {
  formatUpstreamAutoQueuedTitle,
  formatUpstreamDigestTitle,
  formatUpstreamInboxTitle,
} from "../../upstreamNotifications";

/**
 * Keeps upstream queries fresh app-wide and tells the user (toast, OS notification and inbox
 * via `notify`) when a run adds Inbox topics or auto-queues ports, and about the weekly
 * feature digest.
 */
export default function UpstreamNotificationController() {
  useUpstreamPortsInvalidation();
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.upstreamPorts) return;
    return api.upstreamPorts.onChanged((event) => {
      const base = {
        source: "upstream",
        severity: "info",
        sourceLabel: "Upstream",
      } as const;
      if (event.reason === "feature-digest" && event.digest) {
        notify({
          ...base,
          title: formatUpstreamDigestTitle(event.digest),
          dedupeKey: `upstream-digest:${event.projectId}`,
          target: { kind: "upstream", projectId: event.projectId, view: "features" },
          openLabel: "Browse",
          os: { tag: `upstream-digest:${event.projectId}` },
        });
        return;
      }
      if (event.reason === "auto-port" && event.autoQueuedCount) {
        notify({
          ...base,
          title: formatUpstreamAutoQueuedTitle(event.autoQueuedCount),
          dedupeKey: `upstream-auto:${event.projectId}`,
          target: { kind: "upstream", projectId: event.projectId },
          openLabel: "Open",
          os: { tag: `upstream-auto:${event.projectId}` },
        });
        return;
      }
      if (event.reason === "run-finished" && event.newInboxCount)
        notify({
          ...base,
          title: formatUpstreamInboxTitle(event.newInboxCount),
          dedupeKey: `upstream:${event.projectId}`,
          target: { kind: "upstream", projectId: event.projectId },
          openLabel: "Review",
          os: { tag: `upstream:${event.projectId}` },
        });
    });
  }, []);
  return null;
}
