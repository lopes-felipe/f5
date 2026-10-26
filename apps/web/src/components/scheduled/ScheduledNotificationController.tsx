import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { readNativeApi } from "../../nativeApi";
import { subscribeWsConnectionState, getWsConnectionState } from "../../wsConnectionState";
import { toastManager } from "../ui/toast";
/** Push/reconnect/lease driven. Notification permission is requested only by the page's button. */
export function ScheduledNotificationController() {
  const navigate = useNavigate();
  useEffect(() => {
    // Hosts without the scheduled-tasks API (older bridges, route tests) have nothing to drain.
    const api = readNativeApi()?.scheduledTasks;
    if (!api) return;
    const owner = `browser:${crypto.randomUUID()}`;
    let stopped = false,
      busy = false,
      again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      clearTimeout(timer);
      try {
        const batch = await api.claimNotifications({ owner });
        const ids: string[] = [];
        for (const notice of batch.notifications) {
          if (stopped) break;
          const open = () => {
            window.focus();
            if (notice.threadId)
              void navigate({ to: "/$threadId", params: { threadId: notice.threadId } });
            else void navigate({ to: "/scheduled", search: { taskId: notice.taskId } });
          };
          let presented = false;
          if ("Notification" in window && Notification.permission === "granted") {
            try {
              const notification = new Notification(notice.title, {
                body: notice.body,
                tag: notice.id,
              });
              notification.onclick = () => {
                notification.close();
                open();
              };
              presented = true;
            } catch {
              /* OS presentation may be unavailable even after permission was granted. */
            }
          }
          if (!presented)
            toastManager.add({
              title: notice.title,
              description: notice.body,
              actionProps: { children: "Open", onClick: open },
            });
          ids.push(notice.id);
        }
        if (ids.length) await api.acknowledgeNotifications({ owner, ids });
        if (batch.notifications.length === 20) again = true;
        else if (batch.retryAt && !stopped)
          timer = setTimeout(
            () => void drain(),
            Math.max(100, Math.min(2147483647, Date.parse(batch.retryAt) - Date.now())),
          );
      } catch {
        if (!stopped) timer = setTimeout(() => void drain(), 30000);
      } finally {
        busy = false;
        if (again && !stopped) {
          again = false;
          void drain();
        }
      }
    };
    const off = api.onChanged(() => void drain());
    const reconnect = subscribeWsConnectionState(() => {
      if (getWsConnectionState().synchronized) void drain();
    });
    void drain();
    return () => {
      stopped = true;
      clearTimeout(timer);
      off();
      reconnect();
    };
  }, [navigate]);
  return null;
}
