import { useEffect } from "react";

import { useUpstreamPortsInvalidation } from "../../lib/upstreamPortsReactQuery";
import { readNativeApi } from "../../nativeApi";
import { notify } from "../../notificationCenter/notify";
import { formatUpstreamInboxTitle } from "../../upstreamNotifications";

/**
 * Keeps upstream queries fresh app-wide and, after a run adds inbox topics, tells the user
 * "Upstream: N new topics to review" (toast, OS notification and inbox via `notify`).
 */
export default function UpstreamNotificationController() {
  useUpstreamPortsInvalidation();
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.upstreamPorts) return;
    return api.upstreamPorts.onChanged((event) => {
      if (event.reason !== "run-finished" || !event.newInboxCount) return;
      notify({
        source: "upstream",
        severity: "info",
        title: formatUpstreamInboxTitle(event.newInboxCount),
        sourceLabel: "Upstream",
        dedupeKey: `upstream:${event.projectId}`,
        target: { kind: "upstream", projectId: event.projectId },
        openLabel: "Review",
        os: { tag: `upstream:${event.projectId}` },
      });
    });
  }, []);
  return null;
}
