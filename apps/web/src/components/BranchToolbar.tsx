import { WorktreeChip } from "./WorktreeChip";
import { WorktreeCreationOptions } from "./worktrees/WorktreeCreationOptions";
import { setupProjectScript } from "../projectScripts";
import { switchConversationWorkspace } from "../lib/workspaceTransitions";
import { toastManager } from "./ui/toast";
import type { ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useShallow } from "zustand/react/shallow";

import { useStore } from "../store";
import { selectThreadById } from "../threadSelectors";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const envModeItems = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  multiModel?: boolean;
  onOpenTerminal?: () => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /** The server is still creating this thread's worktree. */
  preparingWorktree?: boolean;
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  multiModel = false,
  onOpenTerminal,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  preparingWorktree = false,
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

  if (!activeThreadId || !activeProject) return null;

  return (
    <div
      data-slot="branch-toolbar"
      className="mx-auto flex min-h-7 w-full flex-wrap max-w-(--chat-content-max-width) shrink-0 items-center justify-between gap-2 px-1 text-2xs text-muted-foreground"
    >
      {creatingWorktree || envLocked || activeWorktreePath || effectiveEnvMode === "local" ? (
        <WorktreeChip
          threadId={threadId}
          projectId={activeProject.id}
          branch={activeThreadBranch}
          path={activeWorktreePath ?? activeProject.cwd}
          isWorktree={Boolean(activeWorktreePath)}
          creatingWorktree={creatingWorktree}
          canMove={hasServerThread && !activeWorktreePath && !creatingWorktree}
          moveDisabled={serverThread?.moveDisabled ?? false}
          {...(!envLocked && !activeWorktreePath && !creatingWorktree
            ? { onNewWorktree: () => onEnvModeChange("worktree") }
            : {})}
          {...(onOpenTerminal ? { onOpenTerminal } : {})}
        />
      ) : (
        <Select
          value={effectiveEnvMode}
          onValueChange={(value) => onEnvModeChange(value as EnvMode)}
          items={envModeItems}
        >
          <SelectTrigger
            data-composer-control="envMode"
            variant="ghost"
            size="xs"
            className="h-6 min-h-6 text-2xs font-normal text-muted-foreground hover:text-foreground sm:h-6 sm:min-h-6"
          >
            {effectiveEnvMode === "worktree" ? (
              <GitForkIcon className="size-3" />
            ) : (
              <FolderIcon className="size-3" />
            )}
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="local">
              <span className="inline-flex items-center gap-1.5">
                <FolderIcon className="size-3" />
                Local
              </span>
            </SelectItem>
            <SelectItem value="worktree">
              <span className="inline-flex items-center gap-1.5">
                <GitForkIcon className="size-3" />
                New worktree
              </span>
            </SelectItem>
          </SelectPopup>
        </Select>
      )}

      {!envLocked && !activeWorktreePath && effectiveEnvMode === "worktree" && (
        <WorktreeCreationOptions
          threadId={threadId}
          multiModel={multiModel}
          hasSetupScript={Boolean(setupProjectScript(activeProject.scripts))}
        />
      )}
      <BranchToolbarBranchSelector
        key={threadId}
        threadId={threadId}
        workspaceVersion={workspaceVersion}
        canApplyWorkspace={canApplyWorkspace}
        activeProjectCwd={activeProject.cwd}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
