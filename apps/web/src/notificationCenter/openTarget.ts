import { ProjectId, ScheduledTaskId, type DesktopNotificationTarget } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { prQueueSearchOpening, type PrQueueLocation } from "../components/prHub/prQueueSearch";

/** Where a notification (OS or in-app) takes the user when it is opened. */
export type NotificationTarget = DesktopNotificationTarget;

export type NotificationNavigate = ReturnType<typeof useNavigate>;

/** Brings this window forward; on desktop the main process also activates the app. */
export function focusAppWindow(): void {
  if (typeof window === "undefined") return;
  window.focus();
  void window.desktopBridge?.revealWindow?.().catch(() => undefined);
}

export async function openNotificationTarget(
  navigate: NotificationNavigate,
  target: NotificationTarget,
  options: { focus?: boolean; current?: PrQueueLocation | undefined } = {},
): Promise<void> {
  if (options.focus !== false) focusAppWindow();
  switch (target.kind) {
    case "thread":
      await navigate({ to: "/$threadId", params: { threadId: target.threadId } });
      return;
    case "prHub":
      await navigate({
        to: "/pull-requests",
        search: prQueueSearchOpening(target.prKey, options.current),
      });
      return;
    case "scheduled":
      await navigate({
        to: "/scheduled",
        search: { taskId: ScheduledTaskId.makeUnsafe(target.taskId) },
      });
      return;
    case "upstream":
      await navigate({
        to: "/upstream",
        search:
          target.view === "features"
            ? {
                project: ProjectId.makeUnsafe(target.projectId),
                list: "inbox",
                lane: ["feature"],
                sort: "newest",
                all: true,
              }
            : { project: ProjectId.makeUnsafe(target.projectId) },
      });
      return;
    case "update":
      await navigate({ to: "/settings", search: { category: "about" } });
      return;
    case "none":
      return;
  }
}

export function useOpenNotificationTarget(): (
  target: NotificationTarget,
  options?: { focus?: boolean },
) => Promise<void> {
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(
    (target, options) =>
      openNotificationTarget(navigate, target, { ...options, current: router.state.location }),
    [navigate, router],
  );
}
