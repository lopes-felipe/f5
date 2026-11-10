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

type NotificationRecorder = (input: NotifyInput & { id: string; createdAt: number }) => void;
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

const liveApprovalToasts = new Map<ThreadId, { toastId: string; approval: NotificationApproval }>();

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
  const live = liveApprovalToasts.get(approval.threadId);
  if (live && live.approval.requestId === approval.requestId) {
    liveApprovalToasts.delete(approval.threadId);
  }
  emitApprovalResolved(approval, decision === "accept" ? "Approved" : "Denied");
}

const threadApprovalsEndedListeners = new Set<(threadId: ThreadId) => void>();

/** Told whenever a thread stops waiting on approval, toast or not (the inbox listens). */
export function subscribeThreadApprovalsEnded(listener: (threadId: ThreadId) => void): () => void {
  threadApprovalsEndedListeners.add(listener);
  return () => {
    threadApprovalsEndedListeners.delete(listener);
  };
}

/** The thread no longer waits on its approval; drop any toast still offering to answer it. */
export function resolveThreadApprovals(threadId: ThreadId): void {
  for (const listener of threadApprovalsEndedListeners) listener(threadId);
  const live = liveApprovalToasts.get(threadId);
  if (!live) return;
  liveApprovalToasts.delete(threadId);
  toastManager.close(live.toastId);
  emitApprovalResolved(live.approval, "Answered");
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
 * Do Not Disturb.
 */
export function notify(input: NotifyInput, env: DeliveryEnvironment = readDeliveryEnvironment()) {
  notificationSequence += 1;
  const id = input.id ?? `notification-${env.nowMs}-${notificationSequence}`;
  const plan = planNotificationDelivery(input, env);
  recorder?.({ ...input, id, createdAt: env.nowMs });
  const open = () => void host?.openTarget(input.target);

  let soundPlayed = false;
  if (plan.sound && env.nowMs - lastSoundAtMs >= 2_000) {
    lastSoundAtMs = env.nowMs;
    host?.playSound();
    soundPlayed = true;
  }

  if (plan.os) {
    void presentOsNotification(
      {
        id,
        title: input.os?.title ?? input.title,
        ...((input.os?.body ?? input.body) ? { body: input.os?.body ?? input.body } : {}),
        ...(input.os?.tag ? { tag: input.os.tag } : {}),
        ...(input.os?.icon ? { icon: input.os.icon } : {}),
        // Our own chime replaces the OS sound, never both.
        ...(soundPlayed ? { silent: true } : {}),
        target: input.target,
      },
      { onActivate: (target) => void host?.openTarget(target) },
    );
  }

  if (!plan.toast) return id;
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
  if (input.approval) {
    liveApprovalToasts.set(input.approval.threadId, { toastId, approval: input.approval });
  }
  return id;
}

export function resetNotifyStateForTests(): void {
  lastSoundAtMs = 0;
  liveApprovalToasts.clear();
}
