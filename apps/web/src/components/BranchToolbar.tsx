import { setupProjectScript } from "../projectScripts";
import { switchConversationWorkspace } from "../lib/workspaceTransitions";
import { toastManager } from "./ui/toast";
import type { ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { type ReactNode, useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useShallow } from "zustand/react/shallow";

import { useStore } from "../store";
import { selectThreadById } from "../threadSelectors";
import {
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { type WorkspaceDraftPatch, WorkspacePicker } from "./WorkspacePicker";

interface BranchToolbarProps {
  threadId: ThreadId;
  /** A send is being admitted; the workspace cannot change until it settles. */
  disabled?: boolean;
  multiModel?: boolean;
  onOpenTerminal?: () => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /** The server is still creating this thread's worktree. */
  preparingWorktree?: boolean;
  /** Extra controls on the same row, after the workspace picker. */
  trailing?: ReactNode;
}

/** The row under the composer that holds workspace controls. */
export function BranchToolbarRow({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="branch-toolbar"
      className="mx-auto flex min-h-7 w-full flex-wrap max-w-(--chat-content-max-width) shrink-0 items-center gap-2 px-1 text-2xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

export default function BranchToolbar({
  threadId,
  disabled = false,
  multiModel = false,
  onOpenTerminal,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  preparingWorktree = false,
  trailing,
}: BranchToolbarProps) {
  // Only the workspace fields; a streaming delta on this thread does not re-render the toolbar.
  const serverThread = useStore(
    useShallow((store) => {
      const thread = selectThreadById(store, threadId);
      return thread
        ? {
            id: thread.id,
            projectId: thread.projectId,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            hasSession: thread.session !== null,
            moveDisabled:
              Boolean(thread.session?.activeTurnId) ||
              thread.session?.status === "running" ||
              thread.session?.status === "connecting" ||
              thread.latestTurn?.state === "running",
            sessionVersion: JSON.stringify(thread.session ?? null),
          }
        : undefined;
    }),
  );
  const projects = useStore((store) => store.projects);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = isScratchProject(activeProject)
    ? null
    : (threadWorkspaceCwd(serverThread ?? draftThread, activeProject) ?? null);
  const hasServerThread = serverThread !== undefined;
  const creatingWorktree = hasServerThread && !activeWorktreePath && preparingWorktree;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
    preparingWorktree: creatingWorktree,
  });

  const workspaceVersion = serverThread?.sessionVersion ?? "null";
  const canApplyWorkspace = () => {
    const latestServer = selectThreadById(useStore.getState(), threadId);
    const latestDraft = useComposerDraftStore.getState().getDraftThread(threadId);
    const latest = latestServer ?? latestDraft;
    const latestProject = useStore
      .getState()
      .projects.find((project) => project.id === latest?.projectId);
    return Boolean(
      latest &&
      Boolean(latestServer) === hasServerThread &&
      latest.branch === activeThreadBranch &&
      latest.worktreePath === activeWorktreePath &&
      latestProject?.cwd === activeProject?.cwd &&
      JSON.stringify(latestServer?.session ?? null) === workspaceVersion &&
      resolveEffectiveEnvMode({
        activeWorktreePath: latest.worktreePath,
        hasServerThread: Boolean(latestServer),
        draftThreadEnvMode: latestDraft?.envMode,
        preparingWorktree: creatingWorktree,
      }) === effectiveEnvMode,
    );
  };

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null, sharedFilesystemConfirmed = false) => {
      if (!activeThreadId) return;
      if (hasServerThread) {
        if (branch === activeThreadBranch && worktreePath === activeWorktreePath) return;
        void switchConversationWorkspace(activeThreadId, {
          intent: "attach_existing",
          targetPath: worktreePath ?? activeProject!.cwd,
          sharedFilesystemConfirmed,
          ...(branch ? { branch } : {}),
        }).catch((error) =>
          toastManager.add({
            type: "error",
            title: "Could not switch workspace",
            description: String(error),
          }),
        );
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
        sharedFilesystemConfirmed,
      });
    },
    [
      activeThreadId,
      activeWorktreePath,
      activeThreadBranch,
      activeProject,
      hasServerThread,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  const changeDraft = useCallback(
    (patch: WorkspaceDraftPatch) => {
      if (hasServerThread) return;
      setDraftThreadContext(threadId, patch);
    },
    [hasServerThread, setDraftThreadContext, threadId],
  );

  if (!activeThreadId || !activeProject) return null;

  return (
    <BranchToolbarRow>
      <WorkspacePicker
        key={threadId}
        threadId={threadId}
        projectId={activeProject.id}
        projectCwd={activeProject.cwd}
        hasSetupScript={Boolean(setupProjectScript(activeProject.scripts))}
        isDraft={!hasServerThread}
        disabled={disabled}
        creatingWorktree={creatingWorktree}
        multiModel={multiModel}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        effectiveEnvMode={effectiveEnvMode}
        workspaceVersion={workspaceVersion}
        canApplyWorkspace={canApplyWorkspace}
        canMove={hasServerThread && !activeWorktreePath && !creatingWorktree}
        moveDisabled={serverThread?.moveDisabled ?? false}
        onSetThreadBranch={setThreadBranch}
        onDraftChange={changeDraft}
        {...(onOpenTerminal ? { onOpenTerminal } : {})}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
      {trailing}
    </BranchToolbarRow>
  );
}
