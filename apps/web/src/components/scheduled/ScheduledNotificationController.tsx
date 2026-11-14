import { useEffect } from "react";
import { readNativeApi } from "../../nativeApi";
import { notify } from "../../notificationCenter/notify";
import { subscribeWsConnectionState, getWsConnectionState } from "../../wsConnectionState";
/** Push/reconnect/lease driven. Notification permission is requested only by the page's button. */
export function ScheduledNotificationController() {
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
          // `notify` picks toast, OS notification or both from focus and preferences, and
          // records the run in the inbox.
          notify({
            id: `scheduled:${notice.id}`,
            source: "scheduled",
            severity: "info",
            title: notice.title,
            body: notice.body,
            sourceLabel: "Scheduled",
            dedupeKey: `scheduled:${notice.id}`,
            target: notice.threadId
              ? { kind: "thread", threadId: notice.threadId }
              : { kind: "scheduled", taskId: notice.taskId },
            os: { tag: notice.id },
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
  }, []);
  return null;
}
