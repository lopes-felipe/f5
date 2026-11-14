import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAppSettingsSelector } from "../appSettings";
import { isElectron } from "../env";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { useStore } from "../store";
import { preloadRecentThreadDetails } from "../lib/threadPreload";
import { isThreadRunning } from "../lib/threadRunning";

/** F5's global event stream stays open; hydrate and retain its active thread tails. */
export function RunningThreadSync() {
  const enabled = useAppSettingsSelector((settings) => settings.keepRunningThreadsSynced);
  const recoveryEpoch = useRecoveryStateStore((state) => state.recoveryEpoch);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || !isElectron) return;
    const controller = new AbortController();
    let pending = false;
    let busy = false;
    let observedKey = "";
    let retry: ReturnType<typeof setTimeout> | undefined;
    const missingIds = () =>
      useStore
        .getState()
        .threads.filter((thread) => isThreadRunning(thread) && !thread.detailsLoaded)
        .map((thread) => thread.id)
        .sort();
    const drain = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          if (missingIds().length === 0) continue;
          await preloadRecentThreadDetails(queryClient, {
            runningOnly: true,
            signal: controller.signal,
          });
        }
      } finally {
        busy = false;
        if (!controller.signal.aborted && missingIds().length > 0) {
          retry = setTimeout(() => {
            pending = true;
            void drain();
          }, 5_000);
        }
      }
    };
    const observe = () => {
      const key = JSON.stringify(missingIds());
      if (key === observedKey) return;
      observedKey = key;
      pending = true;
      clearTimeout(retry);
      retry = undefined;
      void drain();
    };
    const unsubscribe = useStore.subscribe(observe);
    observe();
    return () => {
      unsubscribe();
      controller.abort();
      clearTimeout(retry);
    };
  }, [enabled, recoveryEpoch, queryClient]);
  return null;
}
