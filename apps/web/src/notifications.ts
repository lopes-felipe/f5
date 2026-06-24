import { useSyncExternalStore } from "react";

export type AppNotificationPermissionState = NotificationPermission | "unsupported";

export interface AppNotificationInstance {
  close(): void;
  addEventListener(type: "click", listener: (event: Event) => void): void;
}

export interface AppNotificationConstructor {
  new (title: string, options?: NotificationOptions): AppNotificationInstance;
}

let permissionListeners: Array<() => void> = [];

function emitPermissionChange(): void {
  for (const listener of permissionListeners) {
    listener();
  }
}

export function getNotificationPermissionState(): AppNotificationPermissionState {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }

  return window.Notification.permission;
}

export function subscribeNotificationPermission(listener: () => void): () => void {
  permissionListeners.push(listener);

  const notify = () => {
    emitPermissionChange();
  };

  window.addEventListener("focus", notify);
  window.addEventListener("blur", notify);
  document.addEventListener("visibilitychange", notify);

  return () => {
    permissionListeners = permissionListeners.filter((entry) => entry !== listener);
    window.removeEventListener("focus", notify);
    window.removeEventListener("blur", notify);
    document.removeEventListener("visibilitychange", notify);
  };
}

export function useNotificationPermissionState(): AppNotificationPermissionState {
  return useSyncExternalStore(
    subscribeNotificationPermission,
    getNotificationPermissionState,
    () => "unsupported",
  );
}

export async function requestNotificationPermission(): Promise<AppNotificationPermissionState> {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }

  try {
    await window.Notification.requestPermission();
  } finally {
    emitPermissionChange();
  }

  return getNotificationPermissionState();
}

export function isAppWindowFocused(): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  return document.visibilityState === "visible" && document.hasFocus();
}
