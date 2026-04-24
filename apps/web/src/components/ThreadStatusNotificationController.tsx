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

export function ThreadStatusNotificationControllerContent({
  navigateToThread,
}: {
  navigateToThread: (threadId: ThreadId) => void | Promise<void>;
}) {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const { settings } = useAppSettings();
  const permission = useThreadStatusNotificationPermissionState();
  const promptState = useThreadStatusNotificationPromptState();
  const previousStatusByThreadIdRef = useRef<Map<ThreadId, ThreadStatus> | null>(null);
  const previousNotificationsEnabledRef = useRef(settings.enableThreadStatusNotifications);
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
    const wasEnabled = previousNotificationsEnabledRef.current;
    previousNotificationsEnabledRef.current = settings.enableThreadStatusNotifications;
    if (!wasEnabled && settings.enableThreadStatusNotifications) {
      promptVisibleForSessionRef.current = false;
      resetThreadStatusNotificationPrompt();
    }
  }, [settings.enableThreadStatusNotifications]);

  useEffect(() => {
    const canPrompt =
      settings.enableThreadStatusNotifications &&
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
  }, [
    permission,
    promptState.dismissed,
    promptState.shown,
    settings.enableThreadStatusNotifications,
  ]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    const { nextStatusByThreadId, transitions } = diffThreadStatusNotifications(
      previousStatusByThreadIdRef.current,
      threadStatusSnapshots,
    );
    previousStatusByThreadIdRef.current = nextStatusByThreadId;

    for (const transition of transitions) {
      if (
        !shouldDispatchThreadStatusNotification({
          enabled: settings.enableThreadStatusNotifications,
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
    settings.enableThreadStatusNotifications,
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
