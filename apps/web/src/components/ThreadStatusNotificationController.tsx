import { ensureNativeApi } from "../nativeApi";
import { usePendingComputerAccessRequests } from "../hooks/usePendingComputerAccessRequests";
import { needsThreadAttention, setThreadAttentionBadge } from "../threadAttention";
import { toastManager } from "./ui/toast";
import { threadStatusLabel } from "../threadStatus";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";

import { type AppSettings, useAppSettingsSelector } from "../appSettings";
import { useStore } from "../store";
import { useThreadSummaries } from "../threadSelectors";
import type { ThreadStatus } from "../threadStatus";
import {
  diffThreadStatusNotifications,
  dismissThreadStatusNotificationPrompt,
  formatThreadStatusNotificationBody,
  getThreadStatusNotificationPermissionState,
  markThreadStatusNotificationPromptShown,
  requestThreadStatusNotificationPermission,
  resetThreadStatusNotificationPrompt,
  threadNotificationIcon,
  useThreadStatusNotificationPermissionState,
  useThreadStatusNotificationPromptState,
} from "../threadStatusNotifications";
import { isSnoozedThread } from "../lib/threadOrdering";
import { loadInlineApproval } from "../notificationCenter/inlineApproval";
import { notify, resolveThreadAttention } from "../notificationCenter/notify";

/** Statuses whose toast waits for the user and must be closed once the thread moves on. */
function isWaitingStatus(status: ThreadStatus | undefined): boolean {
  return status === "pending-approval" || status === "awaiting-input";
}

function selectNotificationSettings(settings: AppSettings) {
  return {
    systemEnabled: settings.notificationPreferences.thread.system,
    showAttentionBadge: settings.showAttentionBadge,
  };
}

function threadSeverity(status: ThreadStatus) {
  if (status === "failed") return "error" as const;
  if (status === "completed") return "success" as const;
  return "attention" as const;
}

/**
 * Turns thread status changes into notifications (toast, OS, sound and inbox via `notify`),
 * keeps the dock badge in sync, and offers the OS permission prompt.
 */
export function ThreadStatusNotificationControllerContent() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threads = useThreadSummaries();
  const pendingComputerRequests = usePendingComputerAccessRequests();
  const computerPending = [...new Set(pendingComputerRequests.map((request) => request.threadId))]
    .sort()
    .join(",");
  const projects = useStore((store) => store.projects);
  const settings = useAppSettingsSelector(selectNotificationSettings);
  const systemEnabled = settings.systemEnabled;
  const permission = useThreadStatusNotificationPermissionState();
  const promptState = useThreadStatusNotificationPromptState();
  const previousStatusByThreadIdRef = useRef<Map<ThreadId, ThreadStatus> | null>(null);
  const transitionGenerationRef = useRef(new Map<ThreadId, number>());
  const previousNotificationsEnabledRef = useRef(systemEnabled);
  const promptVisibleForSessionRef = useRef(false);
  const [promptVisible, setPromptVisible] = useState(false);

  const threadStatusSnapshots = useMemo(() => {
    const computerThreads = new Set(computerPending.split(","));
    const projectNameById = new Map(projects.map((project) => [project.id, project.name] as const));

    return threads.map((thread) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      projectName: projectNameById.get(thread.projectId) ?? null,
      status: computerThreads.has(thread.id) ? ("pending-approval" as const) : thread.status,
      snoozed: isSnoozedThread(thread) || Boolean(thread.archivedAt),
    }));
  }, [projects, threads, computerPending]);

  useEffect(() => {
    const count =
      threadsHydrated && settings.showAttentionBadge
        ? threadStatusSnapshots.filter(
            (thread) => !thread.snoozed && needsThreadAttention(thread.status),
          ).length
        : 0;
    setThreadAttentionBadge(count);
  }, [settings.showAttentionBadge, threadStatusSnapshots, threadsHydrated]);
  useEffect(() => () => setThreadAttentionBadge(0), []);

  useEffect(() => {
    const wasEnabled = previousNotificationsEnabledRef.current;
    previousNotificationsEnabledRef.current = systemEnabled;
    if (!wasEnabled && systemEnabled) {
      promptVisibleForSessionRef.current = false;
      resetThreadStatusNotificationPrompt();
    }
  }, [systemEnabled]);

  useEffect(() => {
    const canPrompt =
      systemEnabled &&
      permission === "default" &&
      getThreadStatusNotificationPermissionState() !== "unsupported";

    if (!canPrompt) {
      promptVisibleForSessionRef.current = false;
      setPromptVisible(false);
      return;
    }

    if (promptState.dismissed) {
      promptVisibleForSessionRef.current = false;
      setPromptVisible(false);
      return;
    }

    if (promptVisibleForSessionRef.current) {
      setPromptVisible(true);
      return;
    }

    if (promptState.shown) {
      setPromptVisible(false);
      return;
    }

    promptVisibleForSessionRef.current = true;
    setPromptVisible(true);
    markThreadStatusNotificationPromptShown();
  }, [permission, promptState.dismissed, promptState.shown, systemEnabled]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    const previous = previousStatusByThreadIdRef.current;
    const { nextStatusByThreadId, transitions } = diffThreadStatusNotifications(
      previous,
      threadStatusSnapshots,
    );
    previousStatusByThreadIdRef.current = nextStatusByThreadId;

    // A request answered anywhere (here, the chat, another client) retires its toast.
    if (previous) {
      for (const [threadId, status] of previous) {
        if (isWaitingStatus(status) && nextStatusByThreadId.get(threadId) !== status) {
          resolveThreadAttention(threadId);
        }
      }
    }

    const computerThreads = new Set(computerPending.split(","));
    for (const transition of transitions) {
      const generation = (transitionGenerationRef.current.get(transition.threadId) ?? 0) + 1;
      transitionGenerationRef.current.set(transition.threadId, generation);
      // The lookups below take time; a newer transition (or the same status ending) makes this
      // one stale, and notifying then would leave a toast for a request that is already gone.
      const isCurrent = () =>
        transitionGenerationRef.current.get(transition.threadId) === generation &&
        previousStatusByThreadIdRef.current?.get(transition.threadId) === transition.status;
      void (async () => {
        // Only statuses that need the user notify; "working" and "connecting" never did in-app.
        if (!needsThreadAttention(transition.status)) return;
        const thread = useStore.getState().threads.find((t) => t.id === transition.threadId);
        const turnId = thread?.latestTurn?.turnId;
        // Scheduled runs notify through their own outbox; skip the duplicate thread notice.
        // Background conversations load without activities, so a bound conversation's
        // scheduled turn is only known to the server.
        if (thread && turnId) {
          try {
            const result = await ensureNativeApi().scheduledTasks.findRunForTurn({
              threadId: thread.id,
              turnId,
            });
            if (result.runId) return;
          } catch {
            /* Preserve ordinary notifications when lineage cannot be read. */
          }
        }
        // Computer access requests are answered in their own card, never inline.
        const approval =
          transition.status === "pending-approval" && !computerThreads.has(transition.threadId)
            ? await loadInlineApproval(transition.threadId)
            : null;
        if (!isCurrent()) return;
        const icon = threadNotificationIcon(transition.status);
        notify({
          source: "thread",
          severity: threadSeverity(transition.status),
          title: threadStatusLabel(transition.status) ?? "Thread update",
          sourceLabel: formatThreadStatusNotificationBody(transition),
          threadId: transition.threadId,
          threadStatus: transition.status,
          urgent:
            transition.status === "pending-approval" || transition.status === "awaiting-input",
          dedupeKey: `thread:${transition.threadId}:${transition.status}`,
          target: { kind: "thread", threadId: transition.threadId },
          openLabel: "Open thread",
          ...(approval
            ? { approval, ...(approval.detail ? { detail: approval.detail } : {}) }
            : {}),
          os: {
            tag: transition.threadId,
            body: formatThreadStatusNotificationBody(transition),
            ...(icon ? { icon } : {}),
          },
        });
      })().catch(() => undefined);
    }
  }, [computerPending, threadStatusSnapshots, threadsHydrated]);

  // The permission prompt is a persistent toast so it shares the stack and the look.
  useEffect(() => {
    if (!promptVisible) return;
    let settled = false;
    const hide = (dismiss: boolean) => {
      if (settled) return;
      settled = true;
      if (dismiss) dismissThreadStatusNotificationPrompt();
      promptVisibleForSessionRef.current = false;
      setPromptVisible(false);
    };
    const id = toastManager.add({
      type: "info",
      title: "Thread notifications are available",
      description:
        "Get notified when a thread needs approval or input, or finishes, while F5 is in the background.",
      timeout: 0,
      data: {
        source: "system",
        dedupeKey: "thread-notification-permission-prompt",
        actions: [
          {
            label: "Not now",
            onClick: () => hide(true),
          },
          {
            label: "Enable notifications",
            variant: "primary",
            onClick: () =>
              requestThreadStatusNotificationPermission()
                .then((nextPermission) => hide(nextPermission !== "granted"))
                .catch(() => hide(true)),
          },
        ],
      },
      // Closing the toast with its × counts as "Not now".
      onClose: () => hide(true),
    });
    return () => {
      // Unmounting or hiding by state must not record a dismissal.
      settled = true;
      toastManager.close(id);
    };
  }, [promptVisible]);

  return null;
}

export default function ThreadStatusNotificationController() {
  return <ThreadStatusNotificationControllerContent />;
}
