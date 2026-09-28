import {
  createNotificationSound,
  needsThreadAttention,
  setThreadAttentionBadge,
} from "../threadAttention";
import { toastManager } from "./ui/toast";
import { threadStatusLabel } from "../threadStatus";
import { BellIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@t3tools/contracts";

import { useAppSettings } from "../appSettings";
import { useStore } from "../store";
import { resolveThreadStatusForThread, type ThreadStatus } from "../threadStatus";
import {
  diffThreadStatusNotifications,
  dismissThreadStatusNotificationPrompt,
  getThreadStatusNotificationPermissionState,
  isAppWindowFocused,
  markThreadStatusNotificationPromptShown,
  requestThreadStatusNotificationPermission,
  resetThreadStatusNotificationPrompt,
  shouldDispatchThreadStatusNotification,
  showThreadStatusNotification,
  useThreadStatusNotificationPermissionState,
  useThreadStatusNotificationPromptState,
} from "../threadStatusNotifications";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { isSnoozedThread } from "../lib/threadOrdering";

export function ThreadStatusNotificationControllerContent({
  navigateToThread,
}: {
  navigateToThread: (threadId: ThreadId) => void | Promise<void>;
}) {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const { settings } = useAppSettings();
  const systemEnabled =
    settings.notificationMode === "system" || settings.notificationMode === "system-and-sound";
  const soundEnabled =
    settings.notificationMode === "sound" || settings.notificationMode === "system-and-sound";
  const sound = useRef<ReturnType<typeof createNotificationSound> | null>(null);
  useEffect(() => {
    if (!soundEnabled) return;
    const player = createNotificationSound();
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
  }, [soundEnabled]);
  const permission = useThreadStatusNotificationPermissionState();
  const promptState = useThreadStatusNotificationPromptState();
  const previousStatusByThreadIdRef = useRef<Map<ThreadId, ThreadStatus> | null>(null);
  const previousNotificationsEnabledRef = useRef(systemEnabled);
  const promptVisibleForSessionRef = useRef(false);
  const [appFocused, setAppFocused] = useState(() => isAppWindowFocused());
  const [promptVisible, setPromptVisible] = useState(false);

  const threadStatusSnapshots = useMemo(() => {
    const projectNameById = new Map(projects.map((project) => [project.id, project.name] as const));

    return threads.map((thread) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      projectName: projectNameById.get(thread.projectId) ?? null,
      status: resolveThreadStatusForThread(thread),
      snoozed: isSnoozedThread(thread) || Boolean(thread.archivedAt),
    }));
  }, [projects, threads]);

  useEffect(() => {
    const syncFocusState = () => {
      setAppFocused(isAppWindowFocused());
    };

    syncFocusState();
    window.addEventListener("focus", syncFocusState);
    window.addEventListener("blur", syncFocusState);
    document.addEventListener("visibilitychange", syncFocusState);

    return () => {
      window.removeEventListener("focus", syncFocusState);
      window.removeEventListener("blur", syncFocusState);
      document.removeEventListener("visibilitychange", syncFocusState);
    };
  }, []);

  useEffect(() => {
    const count =
      threadsHydrated && settings.showAttentionBadge
        ? threadStatusSnapshots.filter(
            (thread) => !thread.snoozed && needsThreadAttention(thread.status),
          ).length
        : 0;
    setThreadAttentionBadge(count);
  }, [settings.showAttentionBadge, threadStatusSnapshots, threadsHydrated]);
  useEffect(() => () => setThreadAttentionBadge(0), []);

  useEffect(() => {
    const wasEnabled = previousNotificationsEnabledRef.current;
    previousNotificationsEnabledRef.current = systemEnabled;
    if (!wasEnabled && systemEnabled) {
      promptVisibleForSessionRef.current = false;
      resetThreadStatusNotificationPrompt();
    }
  }, [systemEnabled]);

  useEffect(() => {
    const canPrompt =
      systemEnabled &&
      permission === "default" &&
      getThreadStatusNotificationPermissionState() !== "unsupported";

    if (!canPrompt) {
      promptVisibleForSessionRef.current = false;
      setPromptVisible(false);
      return;
    }

    if (promptState.dismissed) {
      promptVisibleForSessionRef.current = false;
      setPromptVisible(false);
      return;
    }

    if (promptVisibleForSessionRef.current) {
      setPromptVisible(true);
      return;
    }

    if (promptState.shown) {
      setPromptVisible(false);
      return;
    }

    promptVisibleForSessionRef.current = true;
    setPromptVisible(true);
    markThreadStatusNotificationPromptShown();
  }, [permission, promptState.dismissed, promptState.shown, systemEnabled]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    const { nextStatusByThreadId, transitions } = diffThreadStatusNotifications(
      previousStatusByThreadIdRef.current,
      threadStatusSnapshots,
    );
    previousStatusByThreadIdRef.current = nextStatusByThreadId;

    let sounded = false;
    for (const transition of transitions) {
      if (needsThreadAttention(transition.status)) {
        if (soundEnabled && !appFocused && !sounded) {
          sound.current?.play();
          sounded = true;
        }
        if (settings.inAppThreadNotifications) {
          toastManager.add({
            title: threadStatusLabel(transition.status) ?? "Thread update",
            description: [transition.projectName, transition.threadTitle]
              .filter(Boolean)
              .join(" · "),
            type: "info",
            data: { threadStatus: transition.status },
            actionProps: {
              children: "View",
              onClick: () => {
                void navigateToThread(transition.threadId);
              },
            },
          });
        }
      }
      if (
        !shouldDispatchThreadStatusNotification({
          enabled: systemEnabled,
          permission,
          appFocused,
          status: transition.status,
        })
      ) {
        continue;
      }

      if (typeof window === "undefined" || typeof window.Notification === "undefined") {
        continue;
      }

      showThreadStatusNotification({
        NotificationConstructor: window.Notification,
        transition,
        silent: soundEnabled,
        focusWindow: () => {
          window.focus();
        },
        navigateToThread,
      });
    }
  }, [
    appFocused,
    navigateToThread,
    permission,
    systemEnabled,
    soundEnabled,
    settings.inAppThreadNotifications,
    threadStatusSnapshots,
    threadsHydrated,
  ]);

  const shouldShowPrompt = promptVisible;

  if (!shouldShowPrompt) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 w-[min(28rem,calc(100vw-2rem))] sm:right-6 sm:bottom-6">
      <Alert
        variant="info"
        className="pointer-events-auto border-info/40 bg-card/96 shadow-xl shadow-black/8 backdrop-blur"
      >
        <BellIcon />
        <AlertTitle>Thread notifications are available</AlertTitle>
        <AlertDescription>
          Get local notifications when a thread needs approval, input, or completes while the app is
          in the background.
        </AlertDescription>
        <AlertAction>
          <Button
            size="xs"
            onClick={() => {
              void requestThreadStatusNotificationPermission()
                .then((nextPermission) => {
                  if (nextPermission !== "granted") {
                    dismissThreadStatusNotificationPrompt();
                  }
                  promptVisibleForSessionRef.current = false;
                  setPromptVisible(false);
                })
                .catch(() => {
                  dismissThreadStatusNotificationPrompt();
                  promptVisibleForSessionRef.current = false;
                  setPromptVisible(false);
                });
            }}
          >
            Enable notifications
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              dismissThreadStatusNotificationPrompt();
              promptVisibleForSessionRef.current = false;
              setPromptVisible(false);
            }}
          >
            Dismiss
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

export default function ThreadStatusNotificationController() {
  const navigate = useNavigate();

  return (
    <ThreadStatusNotificationControllerContent
      navigateToThread={(threadId) => {
        void navigate({
          to: "/$threadId",
          params: { threadId },
        });
      }}
    />
  );
}
