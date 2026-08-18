import { type ThreadId } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import { useAppSettings } from "~/appSettings";
import { deleteThreadWithCleanup, setThreadArchived } from "~/archiveActions";
import { useComposerDraftStore } from "~/composerDraftStore";
import { gitRemoveWorktreeMutationOptions } from "~/lib/gitReactQuery";
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
import type { Thread } from "~/types";
import { toastManager } from "~/components/ui/toast";

import { useCopyToClipboard } from "./useCopyToClipboard";

export type ThreadActionId =
  | "rename"
  | "regenerate-title"
  | "title-regeneration-pending"
  | "pin"
  | "unpin"
  | "wake"
  | "snooze-three-hours"
  | "snooze-tomorrow"
  | "snooze-next-week"
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
}

export function buildThreadActionMenuItems(input: {
  readonly thread: Pick<Thread, "archivedAt" | "titleRegeneration">;
  readonly pinned: boolean;
  readonly snoozed: boolean;
}): ThreadActionMenuItem[] {
  const { thread, pinned, snoozed } = input;
  return [
    { id: "rename", label: "Rename thread" },
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
): ReadonlyArray<{ id: ThreadActionId; label: string; destructive?: boolean }> {
  return items.map(({ id, label, destructive }) => ({
    id,
    label,
    ...(destructive === true ? { destructive: true } : {}),
  }));
}

export function useThreadActionController(input: {
  readonly activeThreadId: ThreadId | null;
  readonly onRenameRequested?: ((threadId: ThreadId) => void) | undefined;
}) {
  const threads = useStore((state) => state.threads);
  const projects = useStore((state) => state.projects);
  const pinRevision = useStore((state) => state.pinRevision ?? 0);
  const markThreadUnread = useStore((state) => state.markThreadUnread);
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
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

  const pinnedThreadIds = useMemo(() => new Set(orderedPinnedThreadIds(threads)), [threads]);
  const pinnedThreadIdsRef = useRef(pinnedThreadIds);
  pinnedThreadIdsRef.current = pinnedThreadIds;
  const menuItemsForThread = useCallback(
    (thread: Thread): ThreadActionMenuItem[] =>
      buildThreadActionMenuItems({
        thread,
        pinned: pinnedThreadIdsRef.current.has(thread.id),
        snoozed: isSnoozedThread(thread),
      }),
    [],
  );

  const renameThread = useCallback(
    async (threadId: ThreadId, nextTitle: string): Promise<boolean> => {
      const thread = threads.find((entry) => entry.id === threadId);
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
    [threads],
  );

  const archiveThread = useCallback(async (threadId: ThreadId, archived: boolean) => {
    await setThreadArchived({ threadId, archived });
  }, []);

  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      options: { readonly deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ) => {
      await deleteThreadWithCleanup({
        threadId,
        threads,
        projects,
        activeThreadId: input.activeThreadId,
        deletedThreadIds: options.deletedThreadIds,
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
        removeWorktree: (removeInput) => removeWorktreeMutation.mutateAsync(removeInput),
      });
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      input.activeThreadId,
      navigate,
      projects,
      removeWorktreeMutation,
      threads,
    ],
  );

  const executeAction = useCallback(
    async (threadId: ThreadId, actionId: ThreadActionId): Promise<void> => {
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const api = readNativeApi();
      if (!api) return;

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
        await toggleThreadPin({ threadId, threads, expectedRevision: pinRevision }).catch(
          (error) => {
            toastManager.add({
              type: "error",
              title: "Failed to update pinned threads",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
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
      if (actionId === "archive" || actionId === "unarchive") {
        await archiveThread(threadId, actionId === "archive");
        return;
      }
      if (actionId === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (actionId === "copy-path") {
        const workspacePath =
          thread.worktreePath ??
          projects.find((project) => project.id === thread.projectId)?.cwd ??
          null;
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
      if (settings.confirmThreadDelete) {
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
      settings.confirmThreadDelete,
      threads,
    ],
  );

  return {
    archiveThread,
    deleteThread,
    executeAction,
    menuItemsForThread,
    renameThread,
  } as const;
}
