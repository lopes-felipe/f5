import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prHubOverviewQueryOptions } from "../../lib/prHubReactQuery";
import { buildPrAttentionNotification } from "../../prHubNotifications";
import { ensureNativeApi } from "../../nativeApi";
import { notify } from "../../notificationCenter/notify";
import { onPrHubChanged, onServerConfigUpdated } from "../../wsNativeApi";

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
  // `notify` decides between toast, OS notification and inbox; only navigation lives here.
  const delivery = useRef({ navigateToPrHub });
  useEffect(() => {
    delivery.current = { navigateToPrHub };
  }, [navigateToPrHub]);
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
        notify(buildPrAttentionNotification(batch, delivery.current.navigateToPrHub));
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
