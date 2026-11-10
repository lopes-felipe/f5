import { ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAppSettingsSelector } from "../appSettings";
import { subscribeToastAdds } from "../components/ui/toast";
import { respondToApproval } from "../lib/respondToApproval";
import { isAppWindowFocused } from "../notifications";
import { createNotificationSound } from "../threadAttention";
import { useNotificationInbox } from "./inboxStore";
import {
  registerApprovalResponder,
  registerNotificationHost,
  registerNotificationRecorder,
  subscribeApprovalResolved,
  subscribeThreadApprovalsEnded,
} from "./notify";
import { useOpenNotificationTarget } from "./openTarget";
import { NOTIFICATION_SOURCES } from "./preferences";

/**
 * Connects `notify()` to the app: navigation for toasts, the thread on screen (its own
 * notifications stay out of the toast stack), the chime, and answering approvals.
 */
export function NotificationCenterHost() {
  const openTarget = useOpenNotificationTarget();
  const routeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const routeThreadRef = useRef(routeThreadId);
  routeThreadRef.current = routeThreadId;
  const soundWanted = useAppSettingsSelector((settings) =>
    NOTIFICATION_SOURCES.some((source) => settings.notificationPreferences[source].sound),
  );
  const sound = useRef<ReturnType<typeof createNotificationSound> | null>(null);

  // The settings switch unlocks audio inside its own click, before the setting is saved, so
  // this listener is always on.
  useEffect(() => {
    const unlock = () => {
      sound.current ??= createNotificationSound();
      sound.current.unlock();
    };
    window.addEventListener("f5:unlock-notification-sound", unlock);
    return () => {
      window.removeEventListener("f5:unlock-notification-sound", unlock);
      sound.current?.dispose();
      sound.current = null;
    };
  }, []);
  // Browsers only start audio after a gesture; unlock on the first one while sound is wanted.
  useEffect(() => {
    if (!soundWanted) return;
    const player = sound.current ?? createNotificationSound();
    sound.current = player;
    const unlock = () => player.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      player.dispose();
      sound.current = null;
    };
  }, [soundWanted]);

  useEffect(
    () =>
      registerNotificationHost({
        openTarget,
        activeThreadId: () => routeThreadRef.current,
        playSound: () => sound.current?.play(),
      }),
    [openTarget],
  );

  // The inbox records every notification, and error toasts raised anywhere in the app.
  useEffect(() => {
    const record = useNotificationInbox.getState().record;
    const unregisterRecorder = registerNotificationRecorder((input) =>
      record({
        id: input.id,
        source: input.source,
        severity: input.severity,
        title: input.title,
        target: input.target,
        createdAt: input.createdAt,
        ...(input.body ? { body: input.body } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
        ...(input.items
          ? {
              items: input.items.map((item) => ({
                id: item.id,
                label: item.label,
                target: item.target,
                ...(item.trailing ? { trailing: item.trailing } : {}),
                ...(item.tone ? { tone: item.tone } : {}),
              })),
            }
          : {}),
        ...(input.moreCount ? { moreCount: input.moreCount } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.threadStatus ? { threadStatus: input.threadStatus } : {}),
        ...(input.approval ? { approval: input.approval } : {}),
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      }),
    );
    const unsubscribeToasts = subscribeToastAdds((options, id) => {
      // `notify` toasts carry a source and are already recorded.
      if (options.type !== "error" || options.data?.source) return;
      const title = typeof options.title === "string" ? options.title : null;
      if (!title) return;
      const body = typeof options.description === "string" ? options.description : undefined;
      record({
        id: `toast:${id}:${Date.now()}`,
        source: "errors",
        severity: "error",
        title,
        target: { kind: "none" },
        createdAt: Date.now(),
        dedupeKey: `error:${title}\u0000${body ?? ""}`,
        ...(body ? { body } : {}),
      });
    });
    const unsubscribeApprovals = subscribeApprovalResolved((approval, label) =>
      useNotificationInbox.getState().resolveApproval(approval.requestId, label),
    );
    const unsubscribeThreadApprovals = subscribeThreadApprovalsEnded((threadId) =>
      useNotificationInbox.getState().resolveThreadApprovals(threadId, "Answered"),
    );
    return () => {
      unregisterRecorder();
      unsubscribeToasts();
      unsubscribeApprovals();
      unsubscribeThreadApprovals();
    };
  }, []);

  // Opening a thread while F5 is focused reads its notifications.
  useEffect(() => {
    if (!routeThreadId) return;
    const markRead = () => {
      if (isAppWindowFocused()) useNotificationInbox.getState().markThreadRead(routeThreadId);
    };
    markRead();
    window.addEventListener("focus", markRead);
    return () => window.removeEventListener("focus", markRead);
  }, [routeThreadId]);

  useEffect(
    () =>
      registerApprovalResponder((approval, decision) =>
        respondToApproval({
          threadId: approval.threadId,
          requestId: approval.requestId,
          decision,
        }),
      ),
    [],
  );

  return null;
}
