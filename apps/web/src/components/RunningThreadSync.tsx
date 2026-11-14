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
    let retryDelay = 5_000;
    let observationQueued = false;
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
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      }
    };
    const observe = () => {
      const key = JSON.stringify(missingIds());
      if (key === observedKey) return;
      observedKey = key;
      retryDelay = 5_000;
      pending = true;
      clearTimeout(retry);
      retry = undefined;
      void drain();
    };
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.threads === previous.threads || observationQueued) return;
      observationQueued = true;
      queueMicrotask(() => {
        observationQueued = false;
        if (!controller.signal.aborted) observe();
      });
    });
    observe();
    return () => {
      unsubscribe();
      controller.abort();
      clearTimeout(retry);
    };
  }, [enabled, recoveryEpoch, queryClient]);
  return null;
}
