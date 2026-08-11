import { useEffect } from "react";

import { readNativeApi } from "~/nativeApi";
import { useNextTurnQueueStore } from "~/nextTurnQueueStore";
import { useWsConnectionState } from "~/wsConnectionState";

export function NextTurnQueueController() {
  const connection = useWsConnectionState();

  useEffect(() => {
    const api = readNativeApi();
    const queueApi = api?.nextTurnQueue;
    if (!queueApi) return;
    const store = useNextTurnQueueStore.getState();
    if (connection.phase === "connected") store.invalidateSnapshots();
    const unsubscribeUpdated = queueApi.onUpdated((snapshot) => {
      useNextTurnQueueStore.getState().applySnapshot(snapshot);
    });
    const unsubscribeSummary = queueApi.onSummaryUpdated((summary) => {
      useNextTurnQueueStore.getState().applySummary(summary);
    });
    if (connection.phase === "connected") {
      void queueApi
        .summary()
        .then((summary) => useNextTurnQueueStore.getState().applySummary(summary))
        .catch((error: unknown) => {
          console.error("Failed to synchronize the queued-turn summary", error);
        });
    }
    const interval = window.setInterval(() => {
      useNextTurnQueueStore.getState().expireStaleOptimistic();
    }, 1_000);
    store.expireStaleOptimistic();
    return () => {
      window.clearInterval(interval);
      unsubscribeUpdated();
      unsubscribeSummary();
    };
  }, [connection.connectedAt, connection.phase]);

  return null;
}
