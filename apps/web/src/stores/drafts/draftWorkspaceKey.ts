import {
  ProjectId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

// Image preparation loads on the first attachment, keeping it out of the startup bundle.
import type { DraftThreadEnvMode } from "../../composerDraftStore";

export interface WorktreeCreationOptions {
  worktreeBranchName?: string | null;
  runSetupScript?: boolean | null;
}

export function resolveDraftWorktreeOptions(
  current?: WorktreeCreationOptions,
  patch?: WorktreeCreationOptions,
) {
  return {
    worktreeBranchName:
      patch?.worktreeBranchName === undefined
        ? (current?.worktreeBranchName ?? null)
        : patch.worktreeBranchName,
    runSetupScript:
      patch?.runSetupScript === undefined
        ? (current?.runSetupScript ?? null)
        : patch.runSetupScript,
  };
}

export interface PersistedDraftThreadState extends WorktreeCreationOptions {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  sharedFilesystemConfirmed?: boolean;
  plainWorktreeOptIn?: true;
  envMode: DraftThreadEnvMode;
}

export interface DraftThreadState extends WorktreeCreationOptions {
  /** True while admission is unresolved; "accepted" reserves until server sync. Never persisted. */
  promoting?: boolean | "accepted";
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  sharedFilesystemConfirmed?: boolean;
  /**
   * The user picked "New worktree" for a project folder that is not a git
   * repository but holds repositories. Such folders ignore `envMode` and run
   * in the project folder unless this is set.
   */
  plainWorktreeOptIn?: true;
  envMode: DraftThreadEnvMode;
}

export function resolveDraftWorkspace(
  projectId: ProjectId,
  existing: DraftThreadState | undefined,
  options?: Partial<Pick<DraftThreadState, "branch" | "worktreePath" | "envMode">>,
) {
  const projectChanged = existing !== undefined && projectId !== existing.projectId;
  const worktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existing?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  return {
    branch:
      options?.branch === undefined
        ? projectChanged
          ? null
          : (existing?.branch ?? null)
        : (options.branch ?? null),
    worktreePath,
    // Workspace paths belong to a machine; the user's environment choice carries over.
    envMode: options?.envMode ?? (worktreePath ? "worktree" : (existing?.envMode ?? "local")),
  };
}

export interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

export const PROJECT_DRAFT_KEY_SEPARATOR = "::";
export const LEGACY_PROJECT_DRAFT_KEY_SEPARATOR = "\u0000";
export type ProjectDraftThreadKey = string;

export function normalizeDraftWorkspaceKey(input?: {
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode | null;
}): string {
  const worktreePath = typeof input?.worktreePath === "string" ? input.worktreePath : "";
  if (worktreePath.length > 0) {
    return `worktree:${worktreePath}`;
  }
  return input?.envMode === "worktree" ? "worktree:new" : "local";
}

export function projectDraftThreadKey(
  projectId: ProjectId,
  input?: {
    worktreePath?: string | null;
    envMode?: DraftThreadEnvMode | null;
  },
): ProjectDraftThreadKey {
  return `${projectId}${PROJECT_DRAFT_KEY_SEPARATOR}${normalizeDraftWorkspaceKey(input)}`;
}

export function projectIdFromDraftThreadKey(key: string): ProjectId {
  const separatorIndex = key.indexOf(PROJECT_DRAFT_KEY_SEPARATOR);
  if (separatorIndex !== -1) {
    return key.slice(0, separatorIndex) as ProjectId;
  }
  const legacySeparatorIndex = key.indexOf(LEGACY_PROJECT_DRAFT_KEY_SEPARATOR);
  return (legacySeparatorIndex === -1 ? key : key.slice(0, legacySeparatorIndex)) as ProjectId;
}

export function keyForDraftThread(draftThread: DraftThreadState): ProjectDraftThreadKey {
  return projectDraftThreadKey(draftThread.projectId, draftThread);
}

export function isProjectDraftKeyForProject(key: string, projectId: ProjectId): boolean {
  return projectIdFromDraftThreadKey(key) === projectId;
}

/**
 * The project's draft thread for `options`' workspace, or its newest draft.
 * Components pass the maps they subscribe to, so memoization (including the
 * React Compiler's) tracks them; the store getter hides them behind `get()`.
 */
export function selectProjectDraftThread(
  state: {
    readonly draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
    readonly projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  },
  projectId: ProjectId,
  options?: {
    worktreePath?: string | null;
    envMode?: DraftThreadEnvMode | null;
  },
): ProjectDraftThread | null {
  if (projectId.length === 0) {
    return null;
  }
  if (options !== undefined) {
    const threadId =
      state.projectDraftThreadIdByProjectId[projectDraftThreadKey(projectId, options)];
    if (!threadId) {
      return null;
    }
    const draftThread = state.draftThreadsByThreadId[threadId];
    if (!draftThread || draftThread.promoting || draftThread.projectId !== projectId) {
      return null;
    }
    return {
      threadId,
      ...draftThread,
    };
  }

  let latestDraftThread: ProjectDraftThread | null = null;
  for (const [key, threadId] of Object.entries(state.projectDraftThreadIdByProjectId)) {
    if (!isProjectDraftKeyForProject(key, projectId)) {
      continue;
    }
    const draftThread = state.draftThreadsByThreadId[threadId];
    if (!draftThread || draftThread.promoting || draftThread.projectId !== projectId) {
      continue;
    }
    const draftThreadCreatedAtMs = Date.parse(draftThread.createdAt);
    const latestDraftThreadCreatedAtMs = latestDraftThread
      ? Date.parse(latestDraftThread.createdAt)
      : Number.NEGATIVE_INFINITY;
    const draftThreadSortTime = Number.isFinite(draftThreadCreatedAtMs)
      ? draftThreadCreatedAtMs
      : Number.NEGATIVE_INFINITY;
    const latestDraftThreadSortTime = Number.isFinite(latestDraftThreadCreatedAtMs)
      ? latestDraftThreadCreatedAtMs
      : Number.NEGATIVE_INFINITY;
    if (
      !latestDraftThread ||
      draftThreadSortTime > latestDraftThreadSortTime ||
      (draftThreadSortTime === latestDraftThreadSortTime && threadId > latestDraftThread.threadId)
    ) {
      latestDraftThread = {
        threadId,
        ...draftThread,
      };
    }
  }
  return latestDraftThread;
}
