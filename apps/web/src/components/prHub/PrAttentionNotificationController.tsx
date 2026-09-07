import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppSettings } from "../../appSettings";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prHubOverviewQueryOptions } from "../../lib/prHubReactQuery";
import { isAppWindowFocused, useNotificationPermissionState } from "../../notifications";
import { formatPrNotificationTitle, showPrAttentionNotification } from "../../prHubNotifications";
import { ensureNativeApi } from "../../nativeApi";
import { onPrHubChanged, onServerConfigUpdated } from "../../wsNativeApi";
import { toastManager } from "../ui/toast";

export function PrAttentionNotificationControllerContent({
  navigateToPrHub,
}: {
  navigateToPrHub: (focusedPrKey?: string) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery(prHubOverviewQueryOptions());
  const accountGeneration = overviewQuery.data?.account?.generation;
  const [clientId] = useState(() => crypto.randomUUID());
  const [leaseTick, setLeaseTick] = useState(0);
  const claimingRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setLeaseTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { settings } = useAppSettings();
  const permission = useNotificationPermissionState();
  const [appFocused, setAppFocused] = useState(() => isAppWindowFocused());
  const delivery = useRef({
    appFocused,
    permission,
    enabled: settings.enablePrAttentionNotifications,
    navigateToPrHub,
  });
  useEffect(() => {
    delivery.current = {
      appFocused,
      permission,
      enabled: settings.enablePrAttentionNotifications,
      navigateToPrHub,
    };
  }, [appFocused, permission, settings.enablePrAttentionNotifications, navigateToPrHub]);
  const mounted = useRef(false);
  const claimAgain = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribeSettings = onServerConfigUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ["prHub"] });
    });
    const unsubscribe = onPrHubChanged((event) => {
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] === "prHub" && query.queryKey[2] !== event.accountGeneration,
      });
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        // Invalidate active reads once per burst. This also handles skipped revisions
        // when the transport coalesces events or a subscriber reconnects.
        void queryClient.invalidateQueries({ queryKey: ["prHub"] });
      }, 250);
    });
    return () => {
      unsubscribe();
      unsubscribeSettings();
      if (timer) clearTimeout(timer);
    };
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
    if (!accountGeneration || accountGeneration !== getPrHubAccountGeneration()) return;
    if (claimingRef.current) {
      claimAgain.current = true;
      return;
    }
    claimingRef.current = true;
    const api = ensureNativeApi().prHub;
    void api
      .claimNotifications({ accountGeneration, clientId, maxItems: 20 })
      .then(async (batch) => {
        if (
          !mounted.current ||
          batch.accountGeneration !== getPrHubAccountGeneration() ||
          batch.pullRequests.length === 0
        )
          return;
        const pr = batch.pullRequests[0]!;
        const grouped = batch.pullRequests.length > 1;
        toastManager.add({
          type: "warning",
          title: grouped
            ? `${batch.pullRequests.length} pull requests need your attention`
            : formatPrNotificationTitle(pr),
          description: grouped
            ? batch.pullRequests
                .map((item) => `${item.repository.nameWithOwner}#${item.number}`)
                .join(", ")
            : pr.nextAction,
          actionProps: {
            children: "View",
            onClick: () => {
              void delivery.current.navigateToPrHub(grouped ? undefined : pr.key);
            },
          },
        });
        if (
          delivery.current.enabled &&
          delivery.current.permission === "granted" &&
          !delivery.current.appFocused &&
          typeof window.Notification !== "undefined"
        ) {
          showPrAttentionNotification({
            NotificationConstructor: window.Notification,
            pullRequest: pr,
            batch: { id: batch.batchId, count: batch.pullRequests.length },
            focusWindow: () => window.focus(),
            navigateToPrHub: (key) => delivery.current.navigateToPrHub(key),
          });
        }
        await api.acknowledgeNotifications({ accountGeneration, clientId, batchId: batch.batchId });
      })
      .catch(() => {
        // A disconnected client does not renew its lease. The next tick can claim
        // after expiry, so a delivery lost before acknowledgment is at-least-once.
      })
      .finally(() => {
        claimingRef.current = false;
        if (mounted.current && claimAgain.current) {
          claimAgain.current = false;
          setLeaseTick((tick) => tick + 1);
        }
      });
  }, [accountGeneration, clientId, leaseTick, overviewQuery.data?.revision]);

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
