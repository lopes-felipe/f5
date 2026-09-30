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

// Same glyphs as the sidebar, encoded locally so notifications never fetch remote images.
export function threadNotificationIcon(status: ThreadStatus): string | undefined {
  const paths: Partial<Record<ThreadStatus, string>> = {
    "pending-approval": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>',
    "awaiting-input":
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    "plan-ready":
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 0v6h6M8 13h8M8 17h8"/>',
    completed: '<path d="m20 6-11 11-5-5"/>',
    working: '<path d="m6 3 14 9-14 9z"/>',
    connecting: '<path d="M12 2a10 10 0 1 0 10 10"/>',
  };
  const body = paths[status];
  return body
    ? "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#52525b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            body +
            "</svg>",
        )
    : undefined;
}

export function showThreadStatusNotification(input: {
  NotificationConstructor: ThreadStatusNotificationConstructor;
  silent?: boolean;
  transition: ThreadStatusNotificationTransition;
  focusWindow: () => void;
  navigateToThread: (threadId: ThreadId) => void | Promise<void>;
}): ThreadStatusNotificationInstance {
  const title = threadStatusLabel(input.transition.status);
  if (!title) {
    throw new Error("Cannot dispatch a notification for a hidden thread status.");
  }

  const icon = threadNotificationIcon(input.transition.status);
  const notification = new input.NotificationConstructor(title, {
    body: formatThreadStatusNotificationBody({
      threadTitle: input.transition.threadTitle,
      projectName: input.transition.projectName,
    }),
    tag: input.transition.threadId,
    ...(icon ? { icon } : {}),
    ...(input.silent ? { silent: true } : {}),
    data: { threadId: input.transition.threadId },
  });

  notification.addEventListener("click", () => {
    notification.close();
    input.focusWindow();
    void input.navigateToThread(input.transition.threadId);
  });

  return notification;
}
