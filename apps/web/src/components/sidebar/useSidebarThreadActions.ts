import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState, type MouseEvent } from "react";

import { applyBulkThreadAction } from "../../bulkThreadActions";
import {
  type DraftThreadState,
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useCreateProjectBackedDraftThread } from "../../hooks/useCreateProjectBackedDraftThread";
import {
  nativeThreadActionMenuItems,
  useThreadActionController,
} from "../../hooks/useThreadActionController";
import { partitionDroppedAttachments } from "../../lib/droppedAttachments";
import { resolveSnoozePreset } from "../../lib/snoozePresets";
import { isMacPlatform } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { Project, Thread } from "../../types";
import {
  attachedFileReferenceWarnings,
  createCachedAbsolutePathComparisonNormalizer,
  identityAbsolutePathNormalizer,
  resolveAttachedFileReferencePaths,
} from "../ChatView.logic";
import {
  isTrailingDoubleClick,
  resolveSidebarNewThreadIntent,
  shouldStartThreadRowRenameOnDoubleClick,
} from "../Sidebar.logic";
import { toastManager } from "../ui/toast";

type CreateProjectBackedDraftThread = ReturnType<typeof useCreateProjectBackedDraftThread>;
export type NewThreadOptions = Parameters<CreateProjectBackedDraftThread>[1];

export interface NewThreadModifiers {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export interface ThreadContextMenuOptions {
  readonly isDraft?: boolean | undefined;
  /** Snoozed rows open the single-thread menu without touching the selection. */
  readonly allowMultiSelect?: boolean | undefined;
}

/**
 * Thread-row behaviour shared by every sidebar list: selection-aware click,
 * keyboard open, context menus (single and multi-select), file drop, inline
 * rename, archive, and new-thread creation.
 */
export function useSidebarThreadActions(input: {
  projects: ReadonlyArray<Project>;
  threads: ReadonlyArray<Thread>;
  routeThreadId: ThreadId | null;
  activeThread: Thread | undefined;
  activeDraftThread: DraftThreadState | null;
  confirmThreadDelete: boolean;
}) {
  const { projects, threads, routeThreadId, activeThread, activeDraftThread, confirmThreadDelete } =
    input;
  const navigate = useNavigate();
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);

  const attachDropToThread = (event: React.DragEvent, thread: Thread) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    const { files, folders } = partitionDroppedAttachments(event.dataTransfer);
    const store = useComposerDraftStore.getState();
    if (folders.length) {
      const result = resolveAttachedFileReferencePaths({
        files: folders,
        isElectron,
        desktopBridge: window.desktopBridge,
        workspaceRoots: [
          thread.worktreePath,
          projects.find((project) => project.id === thread.projectId)?.cwd,
        ],
        normalizeAbsolutePathForComparison: createCachedAbsolutePathComparisonNormalizer(
          window.desktopBridge?.resolveRealPath ?? identityAbsolutePathNormalizer,
        ),
      });
      store.addFilePaths(thread.id, result.filePaths);
      for (const warning of attachedFileReferenceWarnings(result))
        toastManager.add({ type: "warning", title: warning });
    }
    void store.importImages(thread.id, files).then((result) => {
      if (result.failures.length)
        toastManager.add({
          type: "warning",
          title: "Some files could not be attached",
          description: result.failures.map((failure) => failure.message).join("\n"),
        });
      else if (result.imported.length)
        toastManager.add({ type: "success", title: `Files added to ${thread.title}` });
    });
  };

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const handleNewThread = useCallback(
    (projectId: ProjectId, options?: NewThreadOptions) => {
      setProjectExpanded(projectId, true);
      return createProjectBackedDraftThread(projectId, options);
    },
    [createProjectBackedDraftThread, setProjectExpanded],
  );

  /**
   * New thread from a sidebar control: inherits the open thread's (or draft's)
   * branch and worktree when it belongs to the same project. Shift forces the
   * alternate workspace mode; Cmd/Ctrl+Shift opens the thread in a new window.
   */
  const createThreadInProject = useCallback(
    (projectId: ProjectId, modifiers: NewThreadModifiers) => {
      const intent = resolveSidebarNewThreadIntent(modifiers);
      const activeProjectThread = activeThread?.projectId === projectId ? activeThread : undefined;
      const activeProjectDraft =
        activeDraftThread?.projectId === projectId ? activeDraftThread : null;
      void handleNewThread(projectId, {
        branch: activeProjectThread?.branch ?? activeProjectDraft?.branch ?? null,
        worktreePath: activeProjectThread?.worktreePath ?? activeProjectDraft?.worktreePath ?? null,
        forceNonDefaultEnvMode: intent.forceNonDefaultEnvMode,
      })
        .then(async ({ threadId }) => {
          if (!intent.openInNewWindow) return;
          const openThreadInNewWindow = window.desktopBridge?.openThreadInNewWindow;
          if (!openThreadInNewWindow) return;
          flushComposerDraftPersistence();
          const opened = await openThreadInNewWindow(threadId);
          if (!opened) {
            toastManager.add({
              type: "warning",
              title: "Could not open a new window",
              description: "The new thread remains open in this window.",
            });
          }
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not create thread",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    },
    [activeDraftThread, activeThread, handleNewThread],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
  }, []);

  const startThreadRename = useCallback((threadId: ThreadId) => {
    setRenamingThreadId(threadId);
  }, []);

  const {
    archiveThread,
    deleteThreads,
    executeAction: executeThreadAction,
    menuItemsForThread: threadActionMenuItems,
    renameThread,
  } = useThreadActionController({
    activeThreadId: routeThreadId,
    onRenameRequested: startThreadRename,
  });

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string) => {
      await renameThread(threadId, newTitle);
      setRenamingThreadId((current) => (current === threadId ? null : current));
    },
    [renameThread],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const clicked = await api.contextMenu.show(
        nativeThreadActionMenuItems(threadActionMenuItems(thread)),
        position,
      );
      if (clicked) await executeThreadAction(threadId, clicked);
    },
    [executeThreadAction, threadActionMenuItems, threads],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...useThreadSelectionStore.getState().selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "pin", label: `Pin (${count})` },
          { id: "unpin", label: `Unpin (${count})` },
          { id: "snooze", label: `Snooze for 3 hours (${count})` },
          { id: "archive", label: `Archive (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (
        clicked === "pin" ||
        clicked === "unpin" ||
        clicked === "archive" ||
        clicked === "snooze"
      ) {
        try {
          const result = await applyBulkThreadAction(
            ids,
            clicked,
            clicked === "snooze" ? resolveSnoozePreset("three-hours") : undefined,
          );
          removeFromSelection(result.succeeded);
          if (result.failures.length)
            toastManager.add({
              type: "error",
              title: `Updated ${result.succeeded.length} of ${count} threads`,
              description: result.failures
                .map(({ error }) => (error instanceof Error ? error.message : String(error)))
                .join("; "),
            });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not update selected threads",
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (clicked !== "delete") return;

      if (confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const { succeeded, failures } = await deleteThreads(ids);
      removeFromSelection(succeeded);
      if (succeeded.length !== ids.length) {
        toastManager.add({
          type: "error",
          title: `Deleted ${succeeded.length} of ${ids.length} threads`,
          description: failures
            .map(({ error }) => (error instanceof Error ? error.message : "Unknown deletion error"))
            .join("; "),
        });
      }
    },
    [confirmThreadDelete, clearSelection, deleteThreads, markThreadUnread, removeFromSelection],
  );

  /** Right-click / context-menu key on a row. */
  const openThreadContextMenu = useCallback(
    (
      event: React.MouseEvent<HTMLElement>,
      threadId: ThreadId,
      options?: ThreadContextMenuOptions,
    ) => {
      event.preventDefault();
      const position = { x: event.clientX, y: event.clientY };
      if (options?.allowMultiSelect === false) {
        void handleThreadContextMenu(threadId, position);
        return;
      }
      const selectionState = useThreadSelectionStore.getState();
      if (options?.isDraft === true) {
        if (selectionState.hasSelection()) {
          clearSelection();
        }
        return;
      }
      if (selectionState.selectedThreadIds.has(threadId)) {
        void handleMultiSelectContextMenu(position);
      } else {
        if (selectionState.hasSelection()) {
          clearSelection();
        }
        void handleThreadContextMenu(threadId, position);
      }
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu],
  );

  const handleThreadClick = useCallback(
    (
      event: MouseEvent,
      threadId: ThreadId,
      orderedProjectThreadIds: readonly ThreadId[],
      options?: { isDraft?: boolean },
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const isDraft = options?.isDraft === true;

      if (!isDraft && isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (!isDraft && isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      if (isTrailingDoubleClick(event.detail)) {
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (useThreadSelectionStore.getState().hasSelection() || isDraft) {
        clearSelection();
      }
      if (!isDraft) {
        setSelectionAnchor(threadId);
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearSelection, navigate, rangeSelectTo, setSelectionAnchor, toggleThreadSelection],
  );

  /** Plain navigation with no selection semantics ("Needs you" rows). */
  const openThread = useCallback(
    (threadId: ThreadId) => {
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearSelection, navigate],
  );

  /** Enter / Space on a focused row. */
  const handleThreadRowKeyDown = useCallback(
    (event: React.KeyboardEvent, threadId: ThreadId, options?: { isDraft?: boolean }) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      const isDraft = options?.isDraft === true;
      if (useThreadSelectionStore.getState().hasSelection() || isDraft) {
        clearSelection();
      }
      if (!isDraft) {
        setSelectionAnchor(threadId);
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearSelection, navigate, setSelectionAnchor],
  );

  const handleThreadRowDoubleClick = useCallback(
    (event: MouseEvent, thread: Thread, options?: { isDraft?: boolean }) => {
      const shouldRename = shouldStartThreadRowRenameOnDoubleClick({
        isDraft: options?.isDraft === true,
        isRenaming: renamingThreadId === thread.id,
        hasModifierKey: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        target: event.target instanceof HTMLElement ? event.target : null,
      });
      if (!shouldRename) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      startThreadRename(thread.id);
    },
    [renamingThreadId, startThreadRename],
  );

  return {
    renamingThreadId,
    attachDropToThread,
    openPrLink,
    handleNewThread,
    createThreadInProject,
    cancelRename,
    commitRename,
    archiveThread,
    deleteThreads,
    openThreadContextMenu,
    openThread,
    handleThreadClick,
    handleThreadRowKeyDown,
    handleThreadRowDoubleClick,
  };
}

export type SidebarThreadActions = ReturnType<typeof useSidebarThreadActions>;
