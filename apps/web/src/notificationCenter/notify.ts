import type { ApprovalRequestId, ProviderRequestKind, ThreadId } from "@t3tools/contracts";

import { readAppSettingsSnapshot } from "../appSettings";
import { getNotificationPermissionState, isAppWindowFocused } from "../notifications";
import type { AppNotificationPermissionState } from "../notifications";
import type { ThreadStatus } from "../threadStatus";
import {
  toastManager,
  type AppToastData,
  type ToastActionSpec,
  type ToastItemTone,
} from "../components/ui/toast";
import type { NotificationTarget } from "./openTarget";
import { presentOsNotification } from "./osNotifications";
import {
  isDoNotDisturbActive,
  type NotificationPreferences,
  type NotificationSource,
} from "./preferences";

export type NotificationSeverity = "attention" | "success" | "error" | "info";

/** A single, simple approval that can be answered from the toast. */
export interface NotificationApproval {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly detail?: string;
}

export interface NotificationItem {
  readonly id: string;
  readonly label: string;
  readonly trailing?: string;
  readonly tone?: ToastItemTone;
  readonly target: NotificationTarget;
}

export interface NotifyInput {
  readonly id?: string;
  readonly source: NotificationSource;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string;
  readonly detail?: string;
  readonly sourceLabel?: string;
  readonly items?: readonly NotificationItem[];
  readonly moreCount?: number;
  readonly dedupeKey?: string;
  /** Approvals and input requests: they break through Do Not Disturb when allowed. */
  readonly urgent?: boolean;
  readonly threadId?: ThreadId;
  readonly threadStatus?: ThreadStatus;
  readonly approval?: NotificationApproval;
  readonly target: NotificationTarget;
  /** Extra toast buttons; the toast gets an "Open" button for its target when none are given. */
  readonly actions?: readonly ToastActionSpec[];
  readonly openLabel?: string;
  readonly os?: {
    readonly tag?: string;
    readonly title?: string;
    readonly body?: string;
    readonly icon?: string;
  };
}

export interface DeliveryEnvironment {
  readonly preferences: NotificationPreferences;
  readonly doNotDisturbUntil: string | null;
  readonly dndAllowUrgent: boolean;
  readonly appFocused: boolean;
  readonly activeThreadId: ThreadId | null;
  readonly permission: AppNotificationPermissionState;
  readonly nowMs: number;
}

export interface DeliveryPlan {
  readonly record: boolean;
  readonly toast: boolean;
  readonly os: boolean;
  readonly sound: boolean;
}

/**
 * Who hears about a notification. Everything is recorded in the inbox; Do Not Disturb holds the
 * rest back unless the item is urgent and urgent items are allowed through. A focused app shows
 * a toast (not for the thread already on screen); an unfocused one uses the OS when it can and
 * otherwise leaves a toast waiting for the user's return.
 */
export function planNotificationDelivery(
  input: Pick<NotifyInput, "source" | "urgent" | "threadId">,
  env: DeliveryEnvironment,
): DeliveryPlan {
  const prefs = env.preferences[input.source];
  const muted =
    isDoNotDisturbActive(env.doNotDisturbUntil, env.nowMs) &&
    !(input.urgent === true && env.dndAllowUrgent);
  if (muted) return { record: true, toast: false, os: false, sound: false };
  if (env.appFocused) {
    const onScreen = input.threadId !== undefined && input.threadId === env.activeThreadId;
    return { record: true, toast: prefs.inApp && !onScreen, os: false, sound: false };
  }
  const os = prefs.system && env.permission === "granted";
  return { record: true, toast: !os && prefs.inApp, os, sound: prefs.sound };
}

type NotificationHost = {
  openTarget: (target: NotificationTarget) => void | Promise<void>;
  activeThreadId: () => ThreadId | null;
  playSound: () => void;
};

let host: NotificationHost | null = null;

/** The mounted notification host provides navigation, the route's thread and the sound. */
export function registerNotificationHost(next: NotificationHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

type NotificationRecorder = (
  input: NotifyInput & {
    id: string;
    createdAt: number;
    /** Already seen: it is about the thread on screen in the focused app. */
    read: boolean;
  },
) => void;
let recorder: NotificationRecorder | null = null;

/** The inbox records every notification, delivered or not. */
export function registerNotificationRecorder(next: NotificationRecorder): () => void {
  recorder = next;
  return () => {
    if (recorder === next) recorder = null;
  };
}

type ApprovalResponder = (
  approval: NotificationApproval,
  decision: "accept" | "decline",
) => Promise<void>;
let approvalResponder: ApprovalResponder | null = null;
type ApprovalResolvedListener = (
  approval: NotificationApproval,
  label: "Approved" | "Denied" | "Answered",
) => void;
const approvalResolvedListeners = new Set<ApprovalResolvedListener>();

export function registerApprovalResponder(next: ApprovalResponder): () => void {
  approvalResponder = next;
  return () => {
    if (approvalResponder === next) approvalResponder = null;
  };
}

export function subscribeApprovalResolved(listener: ApprovalResolvedListener): () => void {
  approvalResolvedListeners.add(listener);
  return () => {
    approvalResolvedListeners.delete(listener);
  };
}

/**
 * The open urgent toast of each thread (an approval or input request). It stays until the
 * thread stops waiting, so it is closed explicitly then, with or without inline buttons.
 */
const liveThreadToasts = new Map<ThreadId, { toastId: string; approval?: NotificationApproval }>();

function emitApprovalResolved(
  approval: NotificationApproval,
  label: "Approved" | "Denied" | "Answered",
) {
  for (const listener of approvalResolvedListeners) listener(approval, label);
}

/**
 * Answers an approval from a toast or the inbox. Resolves after the server accepted the
 * decision; rejects (after showing why) so the caller keeps its buttons.
 */
export async function respondToNotificationApproval(
  approval: NotificationApproval,
  decision: "accept" | "decline",
): Promise<void> {
  if (!approvalResponder) throw new Error("Approvals cannot be answered right now.");
  try {
    await approvalResponder(approval, decision);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not send approval",
      description: error instanceof Error ? error.message : String(error),
      data: {
        actions: [
          {
            label: "Open thread",
            variant: "primary",
            onClick: () => void host?.openTarget({ kind: "thread", threadId: approval.threadId }),
          },
        ],
      },
    });
    throw error;
  }
  const live = liveThreadToasts.get(approval.threadId);
  if (live?.approval?.requestId === approval.requestId) liveThreadToasts.delete(approval.threadId);
  emitApprovalResolved(approval, decision === "accept" ? "Approved" : "Denied");
}

const threadApprovalsEndedListeners = new Set<(threadId: ThreadId) => void>();

/** Told whenever a thread stops waiting on the user, toast or not (the inbox listens). */
export function subscribeThreadApprovalsEnded(listener: (threadId: ThreadId) => void): () => void {
  threadApprovalsEndedListeners.add(listener);
  return () => {
    threadApprovalsEndedListeners.delete(listener);
  };
}

/**
 * The thread no longer waits on an approval or input: close its urgent toast, which has no
 * timeout, and retire any approval it offered to answer.
 */
export function resolveThreadAttention(threadId: ThreadId): void {
  for (const listener of threadApprovalsEndedListeners) listener(threadId);
  const live = liveThreadToasts.get(threadId);
  if (!live) return;
  liveThreadToasts.delete(threadId);
  toastManager.close(live.toastId);
  if (live.approval) emitApprovalResolved(live.approval, "Answered");
}

function toastType(input: NotifyInput): string {
  if (input.severity === "error") return "error";
  if (input.severity === "success") return "success";
  return input.source === "pr" ? "warning" : "info";
}

function buildToastActions(input: NotifyInput, open: () => void): ToastActionSpec[] {
  if (input.approval) {
    const approval = input.approval;
    return [
      { label: input.openLabel ?? "Open", onClick: open },
      {
        label: "Deny",
        onClick: () => respondToNotificationApproval(approval, "decline"),
      },
      {
        label: "Approve",
        variant: "primary",
        onClick: () => respondToNotificationApproval(approval, "accept"),
      },
    ];
  }
  if (input.actions) return [...input.actions];
  if (input.target.kind === "none") return [];
  return [{ label: input.openLabel ?? "Open", variant: "primary", onClick: open }];
}

let lastSoundAtMs = 0;
let notificationSequence = 0;

export function readDeliveryEnvironment(): DeliveryEnvironment {
  const settings = readAppSettingsSnapshot();
  return {
    preferences: settings.notificationPreferences,
    doNotDisturbUntil: settings.doNotDisturbUntil,
    dndAllowUrgent: settings.dndAllowUrgent,
    appFocused: isAppWindowFocused(),
    activeThreadId: host?.activeThreadId() ?? null,
    permission: getNotificationPermissionState(),
    nowMs: Date.now(),
  };
}

/**
 * One way to tell the user something happened: records it in the inbox, then shows a toast,
 * an OS notification and/or a sound according to the source's preferences, focus and
 * Do Not Disturb. When the OS notification can't be shown, a toast takes its place if the
 * source allows in-app delivery.
 */
export function notify(input: NotifyInput, env: DeliveryEnvironment = readDeliveryEnvironment()) {
  notificationSequence += 1;
  const id = input.id ?? `notification-${env.nowMs}-${notificationSequence}`;
  const plan = planNotificationDelivery(input, env);
  const onScreen =
    env.appFocused && input.threadId !== undefined && input.threadId === env.activeThreadId;
  recorder?.({ ...input, id, createdAt: env.nowMs, read: onScreen });

  if (plan.sound) playThrottledSound(env.nowMs);

  if (plan.os) {
    void presentOsNotification(
      {
        id,
        title: input.os?.title ?? input.title,
        ...((input.os?.body ?? input.body) ? { body: input.os?.body ?? input.body } : {}),
        ...(input.os?.tag ? { tag: input.os.tag } : {}),
        ...(input.os?.icon ? { icon: input.os.icon } : {}),
        // The app's sound preference and throttle decide on audio, never the OS default.
        silent: true,
        target: input.target,
      },
      { onActivate: (target) => void host?.openTarget(target) },
    )
      .catch(() => false)
      .then((shown) => {
        if (!shown && env.preferences[input.source].inApp) showNotificationToast(input);
      });
  }

  if (plan.toast) showNotificationToast(input);
  return id;
}

function playThrottledSound(nowMs: number): void {
  if (nowMs - lastSoundAtMs < 2_000) return;
  lastSoundAtMs = nowMs;
  host?.playSound();
}

/**
 * The delivery policy for a plain error toast raised anywhere in the app (not through
 * `notify`): records it, plays the sound and shows the OS notification when the Errors source
 * asks for them, and returns whether the caller's own toast should show. Do Not Disturb holds
 * it back like any other notification. While F5 is in the background the toast also shows when
 * in-app delivery is on, so the error is still there on return.
 */
export function deliverErrorNotification(
  error: { title: string; body?: string },
  env: DeliveryEnvironment = readDeliveryEnvironment(),
): boolean {
  notificationSequence += 1;
  const id = `error-${env.nowMs}-${notificationSequence}`;
  const input: NotifyInput = {
    id,
    source: "errors",
    severity: "error",
    title: error.title,
    ...(error.body ? { body: error.body } : {}),
    dedupeKey: `error:${error.title}\u0000${error.body ?? ""}`,
    target: { kind: "none" },
  };
  const plan = planNotificationDelivery(input, env);
  recorder?.({ ...input, id, createdAt: env.nowMs, read: false });
  if (plan.sound) playThrottledSound(env.nowMs);
  if (plan.os) {
    void presentOsNotification(
      {
        id,
        title: error.title,
        ...(error.body ? { body: error.body } : {}),
        silent: true,
        target: { kind: "none" },
      },
      { onActivate: () => undefined },
    ).catch(() => false);
  }
  return plan.toast || (plan.os && env.preferences.errors.inApp);
}

function showNotificationToast(input: NotifyInput): void {
  const open = () => void host?.openTarget(input.target);
  const data: AppToastData = {
    source: input.source,
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.threadStatus ? { threadStatus: input.threadStatus } : {}),
    ...(input.urgent ? { urgent: true } : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.moreCount ? { moreCount: input.moreCount } : {}),
    ...(input.items
      ? {
          items: input.items.map((item) => ({
            id: item.id,
            label: item.label,
            ...(item.trailing ? { trailing: item.trailing } : {}),
            ...(item.tone ? { tone: item.tone } : {}),
            onSelect: () => void host?.openTarget(item.target),
          })),
        }
      : {}),
    actions: buildToastActions(input, open),
  };
  const toastId = toastManager.add({
    type: toastType(input),
    title: input.title,
    ...(input.body ? { description: input.body } : {}),
    data,
  });
  if (input.urgent && input.threadId) {
    // One urgent toast per thread: a newer request replaces the older one.
    const previous = liveThreadToasts.get(input.threadId);
    if (previous && previous.toastId !== toastId) toastManager.close(previous.toastId);
    liveThreadToasts.set(input.threadId, {
      toastId,
      ...(input.approval ? { approval: input.approval } : {}),
    });
  }
}

export function resetNotifyStateForTests(): void {
  lastSoundAtMs = 0;
  liveThreadToasts.clear();
}
