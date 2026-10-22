import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useUpstreamPortsInvalidation } from "../../lib/upstreamPortsReactQuery";
import { readNativeApi } from "../../nativeApi";
import { isAppWindowFocused, useNotificationPermissionState } from "../../notifications";
import { showUpstreamInboxNotification } from "../../upstreamNotifications";

/**
 * Keeps upstream queries fresh app-wide and, after a run adds inbox topics
 * while F5 is unfocused, shows "Upstream: N new topics to review".
 */
export default function UpstreamNotificationController() {
  useUpstreamPortsInvalidation();
  const navigate = useNavigate();
  const permission = useNotificationPermissionState();
  const delivery = useRef({ permission, navigate });
  useEffect(() => {
    delivery.current = { permission, navigate };
  }, [permission, navigate]);
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.upstreamPorts) return;
    return api.upstreamPorts.onChanged((event) => {
      if (event.reason !== "run-finished" || !event.newInboxCount) return;
      if (
        delivery.current.permission !== "granted" ||
        isAppWindowFocused() ||
        typeof window.Notification === "undefined"
      )
        return;
      showUpstreamInboxNotification({
        NotificationConstructor: window.Notification,
        projectId: event.projectId,
        count: event.newInboxCount,
        focusWindow: () => window.focus(),
        navigateToUpstream: (projectId) => delivery.current.navigate({ to: "/upstream", search: { project: projectId } }),
      });
    });
  }, []);
  return null;
}
