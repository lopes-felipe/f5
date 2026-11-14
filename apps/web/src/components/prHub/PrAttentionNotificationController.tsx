import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prHubOverviewQueryOptions } from "../../lib/prHubReactQuery";
import { buildPrAttentionNotification } from "../../prHubNotifications";
import { ensureNativeApi } from "../../nativeApi";
import { notify } from "../../notificationCenter/notify";
import {
  EMPTY_PR_HUB_CHANGE_BATCH,
  isPrHubQueryStale,
  mergePrHubChange,
} from "../../lib/prHubInvalidation";
import { onPrHubChanged, onServerConfigUpdated, onServerWelcome } from "../../wsNativeApi";

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
    let batch = EMPTY_PR_HUB_CHANGE_BATCH;
    const unsubscribeSettings = onServerConfigUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ["prHub"] });
    });
    // Events sent while disconnected are gone; a new connection re-reads everything.
    const unsubscribeWelcome = onServerWelcome(() => {
      void queryClient.invalidateQueries({ queryKey: ["prHub"] });
    });
    const unsubscribe = onPrHubChanged((event) => {
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] === "prHub" && query.queryKey[2] !== event.accountGeneration,
      });
      batch = mergePrHubChange(batch, event);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const pending = batch;
        batch = EMPTY_PR_HUB_CHANGE_BATCH;
        // Once per burst: the collection always, a single PR's reads only if it changed.
        void queryClient.invalidateQueries({
          predicate: (query) => isPrHubQueryStale(query.queryKey, pending),
        });
      }, 250);
    });
    return () => {
      unsubscribe();
      unsubscribeSettings();
      unsubscribeWelcome();
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
