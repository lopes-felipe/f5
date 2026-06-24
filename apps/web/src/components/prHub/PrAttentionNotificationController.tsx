import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppSettings } from "../../appSettings";
import { prHubSnapshotQueryOptions } from "../../lib/prHubReactQuery";
import { isAppWindowFocused, useNotificationPermissionState } from "../../notifications";
import { formatPrNotificationTitle, showPrAttentionNotification } from "../../prHubNotifications";
import { ensureNativeApi } from "../../nativeApi";
import { onPrHubUpdated } from "../../wsNativeApi";
import { toastManager } from "../ui/toast";

export function PrAttentionNotificationControllerContent({
  navigateToPrHub,
}: {
  navigateToPrHub: (focusedPrKey?: string) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const snapshotQuery = useQuery(prHubSnapshotQueryOptions());
  const { settings } = useAppSettings();
  const permission = useNotificationPermissionState();
  const [appFocused, setAppFocused] = useState(() => isAppWindowFocused());
  const dispatchedRef = useRef(new Set<string>());

  useEffect(() => {
    const unsubscribe = onPrHubUpdated((snapshot) => {
      queryClient.setQueryData(prHubSnapshotQueryOptions().queryKey, snapshot);
    });
    return unsubscribe;
  }, [queryClient]);

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
    const snapshot = snapshotQuery.data;
    if (!snapshot) return;

    for (const pr of snapshot.pullRequests) {
      if (!pr.notificationPending) continue;
      const dispatchKey = `${pr.key}:${pr.attentionFingerprint}`;
      if (dispatchedRef.current.has(dispatchKey)) continue;
      dispatchedRef.current.add(dispatchKey);

      toastManager.add({
        type: "warning",
        title: formatPrNotificationTitle(pr),
        description: pr.nextAction,
        actionProps: {
          children: "View",
          onClick: () => {
            void navigateToPrHub(pr.key);
          },
        },
      });

      if (
        settings.enablePrAttentionNotifications &&
        permission === "granted" &&
        !appFocused &&
        typeof window !== "undefined" &&
        typeof window.Notification !== "undefined"
      ) {
        showPrAttentionNotification({
          NotificationConstructor: window.Notification,
          pullRequest: pr,
          focusWindow: () => window.focus(),
          navigateToPrHub,
        });
      }

      void ensureNativeApi()
        .prHub.markNotified({
          key: pr.key,
          attentionFingerprint: pr.attentionFingerprint,
        })
        .catch(() => {
          dispatchedRef.current.delete(dispatchKey);
        });
    }
  }, [
    appFocused,
    navigateToPrHub,
    permission,
    settings.enablePrAttentionNotifications,
    snapshotQuery.data,
  ]);

  return null;
}

export default function PrAttentionNotificationController() {
  const navigate = useNavigate();
  return (
    <PrAttentionNotificationControllerContent
      navigateToPrHub={(focusedPrKey) => {
        void navigate({
          to: "/pull-requests",
          search: focusedPrKey ? { pr: focusedPrKey } : {},
        });
      }}
    />
  );
}
