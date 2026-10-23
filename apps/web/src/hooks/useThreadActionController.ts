import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ThreadId } from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useAppSettingsSelector } from "~/appSettings";
import { deleteThreadsWithCleanup, setThreadArchived } from "~/archiveActions";
import { useComposerDraftStore } from "~/composerDraftStore";
import { scheduledTasksQueryOptions } from "~/lib/scheduledTasksQuery";
import { isSnoozedThread } from "~/lib/threadOrdering";
import { resolveSnoozePreset } from "~/lib/snoozePresets";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import {
  orderedPinnedThreadIds,
  snoozeThread,
  toggleThreadPin,
  wakeThread,
} from "~/threadPinSnooze";
import { selectThreadById } from "~/threadSelectors";
import type { Thread, ThreadListItem } from "~/types";
import { toastManager } from "~/components/ui/toast";

import { useCopyToClipboard } from "./useCopyToClipboard";

export type ScheduledTaskMenuState =
  | { state: "available"; name: string }
  | { state: "loading" | "unavailable" | "removed" };
/** The server's reason a settle was refused, without the invariant prefix or a stack. */
export function settlementErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = /invariant failed \(thread\.(?:un)?settle\): ([^\n]+)/.exec(message)?.[1];
  return reason?.trim() || "Check pending work on the thread, then retry.";
}

export type ThreadActionId =
  | "scheduled-origin"
  | "edit-schedule"
  | "rename"
  | "regenerate-title"
  | "title-regeneration-pending"
  | "pin"
  | "unpin"
  | "wake"
  | "snooze-three-hours"
  | "snooze-tomorrow"
  | "snooze-next-week"
  | "settle"
  | "unsettle"
  | "archive"
  | "unarchive"
  | "mark-unread"
  | "copy-path"
  | "copy-thread-id"
  | "delete";

export interface ThreadActionMenuItem {
  readonly id: ThreadActionId;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
}

export function buildThreadActionMenuItems(input: {
  readonly thread: Pick<
    Thread,
    "archivedAt" | "titleRegeneration" | "scheduledOrigin" | "settledAt"
  >;
  readonly pinned: boolean;
  readonly snoozed: boolean;
  readonly schedule?: ScheduledTaskMenuState;
}): ThreadActionMenuItem[] {
  const { thread, pinned, snoozed } = input;
  return [
    ...(thread.scheduledOrigin
      ? [
          {
            id: "scheduled-origin" as const,
            label:
              input.schedule?.state === "available"
                ? `Scheduled task: ${input.schedule.name}`
                : input.schedule?.state === "removed"
                  ? "Scheduled task removed"
                  : input.schedule?.state === "unavailable"
                    ? "Scheduled task unavailable"
                    : "Loading scheduled task…",
            disabled: true,
          },
          ...(input.schedule?.state === "available"
            ? [{ id: "edit-schedule" as const, label: "Edit scheduled task…" }]
            : []),
        ]
      : []),
    {
      id: "rename",
      label: "Rename thread",
      ...(thread.scheduledOrigin ? { separatorBefore: true } : {}),
    },
    thread.titleRegeneration
      ? { id: "title-regeneration-pending", label: "Regenerating title…", disabled: true }
      : { id: "regenerate-title", label: "Regenerate title" },
    ...(thread.archivedAt === null
      ? [
          { id: pinned ? "unpin" : "pin", label: pinned ? "Unpin" : "Pin" } as const,
          ...(snoozed
            ? ([{ id: "wake", label: "Wake" }] as const)
            : ([
                { id: "snooze-three-hours", label: "Snooze for 3 hours" },
                { id: "snooze-tomorrow", label: "Snooze until tomorrow morning" },
                { id: "snooze-next-week", label: "Snooze until next week" },
              ] as const)),
        ]
      : []),
    ...(thread.archivedAt === null
      ? [
          {
            id: thread.settledAt ? ("unsettle" as const) : ("settle" as const),
            label: thread.settledAt ? "Unsettle" : "Settle",
            disabled: !thread.settledAt && (pinned || snoozed),
          },
        ]
      : []),
    {
      id: thread.archivedAt === null ? "archive" : "unarchive",
      label: thread.archivedAt === null ? "Archive" : "Unarchive",
    },
    { id: "mark-unread", label: "Mark unread" },
    { id: "copy-path", label: "Copy path" },
    { id: "copy-thread-id", label: "Copy thread ID" },
    { id: "delete", label: "Delete", destructive: true },
  ];
}

export function nativeThreadActionMenuItems(
  items: ReadonlyArray<ThreadActionMenuItem>,
): ReadonlyArray<import("@t3tools/contracts").ContextMenuItem<ThreadActionId>> {
  return items.map(({ id, label, destructive, disabled, separatorBefore }) => ({
    id,
    label,
    ...(destructive === true ? { destructive: true } : {}),
    ...(disabled === true ? { disabled: true } : {}),
    ...(separatorBefore === true ? { separatorBefore: true } : {}),
  }));
}

export function useThreadActionController(input: {
  readonly activeThreadId: ThreadId | null;
  readonly onRenameRequested?: ((threadId: ThreadId) => void) | undefined;
}) {
  // Threads are read from the store when a handler runs, so this hook does not
  // re-render its host for every streaming delta.
  const projects = useStore((state) => state.projects);
  const activeScheduledTaskId = useStore((state) =>
    input.activeThreadId
      ? selectThreadById(state, input.activeThreadId)?.scheduledOrigin?.taskId
      : undefined,
  );
  const queryClient = useQueryClient();
  const schedules = useQuery({
    ...scheduledTasksQueryOptions(),
    enabled: activeScheduledTaskId !== undefined,
  });
  const pinRevision = useStore((state) => state.pinRevision ?? 0);
  const markThreadUnread = useStore((state) => state.markThreadUnread);
  const confirmThreadDelete = useAppSettingsSelector((settings) => settings.confirmThreadDelete);
  const navigate = useNavigate();
  const clearComposerDraftForThread = useComposerDraftStore((state) => state.clearThreadDraft);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (state) => state.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (context) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: context.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (context) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: context.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const buildMenu = useCallback(
    (thread: ThreadListItem, schedule: ScheduledTaskMenuState) =>
      buildThreadActionMenuItems({
        thread,
        pinned: orderedPinnedThreadIds(useStore.getState().threads).includes(thread.id),
        snoozed: isSnoozedThread(thread),
        schedule,
      }),
    [],
  );

  const menuItemsForThread = useCallback(
    (thread: ThreadListItem): ThreadActionMenuItem[] => {
      const task = schedules.data?.tasks.find(
        (entry) => entry.task.id === thread.scheduledOrigin?.taskId,
      )?.task;
      return buildMenu(
        thread,
        schedules.isError
          ? { state: "unavailable" }
          : task
            ? { state: "available", name: task.name }
            : { state: schedules.data ? "removed" : "loading" },
      );
    },
    [buildMenu, schedules.data, schedules.isError],
  );
  const loadMenuItemsForThread = useCallback(
    async (thread: ThreadListItem) => {
      if (!thread.scheduledOrigin) return menuItemsForThread(thread);
      try {
        const data = await queryClient.fetchQuery(scheduledTasksQueryOptions());
        const task = data.tasks.find(
          (entry) => entry.task.id === thread.scheduledOrigin?.taskId,
        )?.task;
        return buildMenu(
          thread,
          task ? { state: "available", name: task.name } : { state: "removed" },
        );
      } catch {
        return buildMenu(thread, { state: "unavailable" });
      }
    },
    [buildMenu, menuItemsForThread, queryClient],
  );

  const renameThread = useCallback(
    async (threadId: ThreadId, nextTitle: string): Promise<boolean> => {
      const thread = selectThreadById(useStore.getState(), threadId);
      if (!thread) return false;
      const title = nextTitle.trim();
      if (title.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return false;
      }
      if (title === thread.title) return true;
      const api = readNativeApi();
      if (!api) return false;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title,
        });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return false;
      }
    },
    [],
  );

  const archiveThread = useCallback(async (threadId: ThreadId, archived: boolean) => {
    await setThreadArchived({ threadId, archived });
  }, []);

  const deleteThreads = useCallback(
    async (threadIds: ReadonlyArray<ThreadId>) => {
      return await deleteThreadsWithCleanup({
        threadIds,
        getThreads: () => useStore.getState().threads,
        threads: useStore.getState().threads,
        projects,
        activeThreadId: input.activeThreadId,
        clearComposerDraftForThread,
        clearProjectDraftThreadById,
        clearTerminalState,
        navigateToThread: (fallbackThreadId) => {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        },
        navigateHome: () => {
          void navigate({ to: "/", replace: true });
        },
      });
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      input.activeThreadId,
      navigate,
      projects,
    ],
  );

  const deleteThread = useCallback(
    async (threadId: ThreadId) => {
      const result = await deleteThreads([threadId]);
      if (result.failures[0]) throw result.failures[0].error;
    },
    [deleteThreads],
  );

  const executeAction = useCallback(
    async (threadId: ThreadId, actionId: ThreadActionId): Promise<void> => {
      const thread = selectThreadById(useStore.getState(), threadId);
      if (!thread) return;
      const api = readNativeApi();
      if (!api) return;

      if (actionId === "scheduled-origin") return;
      if (actionId === "edit-schedule") {
        if (!thread.scheduledOrigin) return;
        try {
          const data = await queryClient.fetchQuery({
            ...scheduledTasksQueryOptions(),
            staleTime: 0,
          });
          const task = data.tasks.find(
            (entry) => entry.task.id === thread.scheduledOrigin?.taskId,
          )?.task;
          if (!task) {
            toastManager.add({ type: "warning", title: "Scheduled task removed" });
            return;
          }
          await navigate({ to: "/scheduled", search: { taskId: task.id, edit: true } });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to open scheduled task",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (actionId === "rename") {
        input.onRenameRequested?.(threadId);
        return;
      }
      if (actionId === "regenerate-title") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId,
            regenerateTitle: true,
          })
          .catch((error) => {
            toastManager.add({
              type: "error",
              title: "Failed to regenerate title",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          });
        return;
      }
      if (actionId === "title-regeneration-pending") return;
      if (actionId === "pin" || actionId === "unpin") {
        await toggleThreadPin({
          threadId,
          threads: useStore.getState().threads,
          expectedRevision: pinRevision,
        }).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Failed to update pinned threads",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }
      if (actionId === "wake") {
        await wakeThread(thread).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }
      const snoozePreset =
        actionId === "snooze-three-hours"
          ? "three-hours"
          : actionId === "snooze-tomorrow"
            ? "tomorrow-morning"
            : actionId === "snooze-next-week"
              ? "next-week"
              : null;
      if (snoozePreset !== null) {
        try {
          await snoozeThread(threadId, resolveSnoozePreset(snoozePreset));
          if (input.activeThreadId === threadId) {
            await navigate({ to: "/", replace: true });
          }
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to snooze thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (actionId === "settle" || actionId === "unsettle") {
        try {
          await api.orchestration.dispatchCommand({
            type: actionId === "settle" ? "thread.settle" : "thread.unsettle",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: actionId === "settle" ? "Could not settle thread" : "Could not unsettle thread",
            description: settlementErrorDetail(error),
          });
        }
        return;
      }
      if (actionId === "archive" || actionId === "unarchive") {
        await archiveThread(threadId, actionId === "archive");
        return;
      }
      if (actionId === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (actionId === "copy-path") {
        const workspacePath = resolveThreadWorkspaceCwd({ thread, projects }) ?? null;
        if (!workspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(workspacePath, { path: workspacePath });
        return;
      }
      if (actionId === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (actionId !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }
      await deleteThread(threadId);
    },
    [
      archiveThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      input.onRenameRequested,
      input.activeThreadId,
      markThreadUnread,
      navigate,
      pinRevision,
      projects,
      queryClient,
      confirmThreadDelete,
    ],
  );

  return {
    archiveThread,
    deleteThread,
    deleteThreads,
    executeAction,
    menuItemsForThread,
    loadMenuItemsForThread,
    renameThread,
  } as const;
}
