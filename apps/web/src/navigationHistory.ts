import type { RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

export type HistoryDirection = "back" | "forward";

// The Navigation API is Chromium-only and missing from TypeScript's DOM lib.
type NavigationHistoryApi = EventTarget & {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
};

function navigationApi(): NavigationHistoryApi | undefined {
  return (window as Window & { navigation?: NavigationHistoryApi }).navigation;
}

function subscribeToNavigationHistory(onChange: () => void): () => void {
  const navigation = navigationApi();
  navigation?.addEventListener("currententrychange", onChange);
  return () => navigation?.removeEventListener("currententrychange", onChange);
}

export function canNavigateHistory(direction: HistoryDirection): boolean {
  const navigation = navigationApi();
  if (!navigation) return false;
  return direction === "back" ? navigation.canGoBack : navigation.canGoForward;
}

/** Goes through the router so navigation blockers (unsaved drafts) still apply. */
export function navigateHistory(history: RouterHistory, direction: HistoryDirection): void {
  if (direction === "back") history.back();
  else history.forward();
}

/** Only for Electron: without the Navigation API this always reports false. */
export function useCanNavigateHistory(direction: HistoryDirection): boolean {
  return useSyncExternalStore(subscribeToNavigationHistory, () => canNavigateHistory(direction));
}
