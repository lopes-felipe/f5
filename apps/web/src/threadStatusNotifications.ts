import { useSyncExternalStore } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { isVisibleThreadStatus, threadStatusLabel, type ThreadStatus } from "./threadStatus";
import {
  getNotificationPermissionState,
  isAppWindowFocused,
  requestNotificationPermission,
  useNotificationPermissionState,
  type AppNotificationConstructor,
  type AppNotificationInstance,
  type AppNotificationPermissionState,
} from "./notifications";

export { isAppWindowFocused };

const THREAD_STATUS_NOTIFICATION_PROMPT_STORAGE_KEY = "t3code:thread-status-notification-prompt:v1";

export type ThreadStatusNotificationPermissionState = AppNotificationPermissionState;

export interface ThreadStatusNotificationPromptState {
  shown: boolean;
  dismissed: boolean;
}

export interface ThreadStatusNotificationSnapshot {
  threadId: ThreadId;
  threadTitle: string;
  projectName: string | null;
  status: ThreadStatus;
  snoozed?: boolean;
}

export interface ThreadStatusNotificationTransition extends Omit<
  ThreadStatusNotificationSnapshot,
  "status"
> {
  previousStatus: ThreadStatus;
  status: Exclude<ThreadStatus, "none">;
}

export type ThreadStatusNotificationInstance = AppNotificationInstance;

export type ThreadStatusNotificationConstructor = AppNotificationConstructor;

let promptListeners: Array<() => void> = [];
let cachedRawPromptState: string | null | undefined;
let cachedPromptState: ThreadStatusNotificationPromptState = { shown: false, dismissed: false };

function emitPromptChange(): void {
  for (const listener of promptListeners) {
    listener();
  }
}

function parsePromptState(value: string | null): ThreadStatusNotificationPromptState {
  if (!value) {
    return { shown: false, dismissed: false };
  }

  try {
    const parsed = JSON.parse(value) as { shown?: unknown; dismissed?: unknown };
    return {
      shown: parsed.shown === true,
      dismissed: parsed.dismissed === true,
    };
  } catch {
    return { shown: false, dismissed: false };
  }
}

export function getThreadStatusNotificationPromptStateSnapshot(): ThreadStatusNotificationPromptState {
  if (typeof window === "undefined") {
    return { shown: false, dismissed: false };
  }

  const raw = window.localStorage.getItem(THREAD_STATUS_NOTIFICATION_PROMPT_STORAGE_KEY);
  if (raw === cachedRawPromptState) {
    return cachedPromptState;
  }

  cachedRawPromptState = raw;
  cachedPromptState = parsePromptState(raw);
  return cachedPromptState;
}

function persistThreadStatusNotificationPromptState(
  next: ThreadStatusNotificationPromptState,
): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawPromptState) {
      window.localStorage.setItem(THREAD_STATUS_NOTIFICATION_PROMPT_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawPromptState = raw;
  cachedPromptState = next;
}

function subscribeThreadStatusNotificationPromptState(listener: () => void): () => void {
  promptListeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === THREAD_STATUS_NOTIFICATION_PROMPT_STORAGE_KEY) {
      emitPromptChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    promptListeners = promptListeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useThreadStatusNotificationPromptState() {
  return useSyncExternalStore(
    subscribeThreadStatusNotificationPromptState,
    getThreadStatusNotificationPromptStateSnapshot,
    () => ({ shown: false, dismissed: false }),
  );
}

export function markThreadStatusNotificationPromptShown(): void {
  const current = getThreadStatusNotificationPromptStateSnapshot();
  if (current.shown) {
    return;
  }

  persistThreadStatusNotificationPromptState({
    ...current,
    shown: true,
  });
  emitPromptChange();
}

export function dismissThreadStatusNotificationPrompt(): void {
  persistThreadStatusNotificationPromptState({ shown: true, dismissed: true });
  emitPromptChange();
}

export function resetThreadStatusNotificationPrompt(): void {
  persistThreadStatusNotificationPromptState({ shown: false, dismissed: false });
  emitPromptChange();
}

export function getThreadStatusNotificationPermissionState(): ThreadStatusNotificationPermissionState {
  return getNotificationPermissionState();
}

export function useThreadStatusNotificationPermissionState(): ThreadStatusNotificationPermissionState {
  return useNotificationPermissionState();
}

export async function requestThreadStatusNotificationPermission(): Promise<ThreadStatusNotificationPermissionState> {
  return requestNotificationPermission();
}

export function diffThreadStatusNotifications(
  previousStatusByThreadId: ReadonlyMap<ThreadId, ThreadStatus> | null,
  currentThreads: ReadonlyArray<ThreadStatusNotificationSnapshot>,
): {
  nextStatusByThreadId: Map<ThreadId, ThreadStatus>;
  transitions: ThreadStatusNotificationTransition[];
} {
  const nextStatusByThreadId = new Map<ThreadId, ThreadStatus>();
  const transitions: ThreadStatusNotificationTransition[] = [];

  for (const thread of currentThreads) {
    nextStatusByThreadId.set(thread.threadId, thread.status);
    if (previousStatusByThreadId === null) {
      continue;
    }

    const previousStatus = previousStatusByThreadId.get(thread.threadId) ?? "none";
    if (
      thread.snoozed === true ||
      thread.status === previousStatus ||
      !isVisibleThreadStatus(thread.status)
    ) {
      continue;
    }

    transitions.push({
      ...thread,
      previousStatus,
      status: thread.status,
    });
  }

  return { nextStatusByThreadId, transitions };
}

export function shouldDispatchThreadStatusNotification(input: {
  enabled: boolean;
  permission: ThreadStatusNotificationPermissionState;
  appFocused: boolean;
  status: ThreadStatus;
}): boolean {
  return (
    input.enabled &&
    input.permission === "granted" &&
    !input.appFocused &&
    isVisibleThreadStatus(input.status)
  );
}

function formatThreadStatusNotificationBody(input: {
  threadTitle: string;
  projectName: string | null;
}): string {
  if (input.projectName) {
    return `${input.projectName} · ${input.threadTitle}`;
  }

  return input.threadTitle;
}

export function showThreadStatusNotification(input: {
  NotificationConstructor: ThreadStatusNotificationConstructor;
  transition: ThreadStatusNotificationTransition;
  focusWindow: () => void;
  navigateToThread: (threadId: ThreadId) => void | Promise<void>;
}): ThreadStatusNotificationInstance {
  const title = threadStatusLabel(input.transition.status);
  if (!title) {
    throw new Error("Cannot dispatch a notification for a hidden thread status.");
  }

  const notification = new input.NotificationConstructor(title, {
    body: formatThreadStatusNotificationBody({
      threadTitle: input.transition.threadTitle,
      projectName: input.transition.projectName,
    }),
    tag: input.transition.threadId,
    data: { threadId: input.transition.threadId },
  });

  notification.addEventListener("click", () => {
    notification.close();
    input.focusWindow();
    void input.navigateToThread(input.transition.threadId);
  });

  return notification;
}
