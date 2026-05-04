import { DEFAULT_RUNTIME_MODE, type ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { useAppSettings, type AppSettings } from "../appSettings";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { getModelPreferences } from "../modelPreferencesStore";
import { useStore } from "../store";

export interface CreateProjectBackedDraftThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
}

interface CreateProjectBackedDraftThreadInput {
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
  navigate: ReturnType<typeof useNavigate>;
  onboardingLiteStatus: AppSettings["onboardingLiteStatus"];
  updateSettings: (patch: Partial<AppSettings>) => void;
  options?: CreateProjectBackedDraftThreadOptions;
}

export interface CreateProjectBackedDraftThreadResult {
  projectId: ProjectId;
  threadId: ThreadId;
}

export function seedDraftThreadFromModelPreferences(threadId: ThreadId): void {
  const preferences = getModelPreferences();
  const { setModel, setModelOptions, setProvider } = useComposerDraftStore.getState();
  if (preferences.lastProvider) {
    setProvider(threadId, preferences.lastProvider);
    const rememberedModel = preferences.lastModelByProvider[preferences.lastProvider];
    if (rememberedModel) {
      setModel(threadId, rememberedModel);
    }
  }
  if (preferences.lastModelOptions) {
    setModelOptions(threadId, preferences.lastModelOptions);
  }
}

function maybeMarkOnboardingLiteCompleted(
  projectId: ProjectId,
  threadId: ThreadId,
  onboardingLiteStatus: AppSettings["onboardingLiteStatus"],
  updateSettings: (patch: Partial<AppSettings>) => void,
): void {
  if (onboardingLiteStatus === "completed") {
    return;
  }

  const validProjectIds = new Set(useStore.getState().projects.map((project) => project.id));
  if (!validProjectIds.has(projectId)) {
    return;
  }

  const draftThread = useComposerDraftStore.getState().getDraftThread(threadId);
  if (!draftThread || draftThread.projectId !== projectId) {
    return;
  }

  updateSettings({ onboardingLiteStatus: "completed" });
}

export async function createProjectBackedDraftThread({
  navigate,
  onboardingLiteStatus,
  options,
  projectId,
  routeThreadId,
  updateSettings,
}: CreateProjectBackedDraftThreadInput): Promise<CreateProjectBackedDraftThreadResult> {
  const {
    getDraftThread,
    getDraftThreadByProjectId,
    setDraftThreadContext,
    setProjectDraftThreadId,
  } = useComposerDraftStore.getState();
  const hasBranchOption = options?.branch !== undefined;
  const hasWorktreePathOption = options?.worktreePath !== undefined;
  const hasEnvModeOption = options?.envMode !== undefined;
  const requestedWorktreePath = options?.worktreePath ?? null;
  const requestedEnvMode = options?.envMode ?? (requestedWorktreePath ? "worktree" : "local");
  const storedDraftThread = getDraftThreadByProjectId(projectId, {
    envMode: requestedEnvMode,
    worktreePath: requestedWorktreePath,
  });
  const latestActiveDraftThread: DraftThreadState | null = routeThreadId
    ? getDraftThread(routeThreadId)
    : null;
  const latestActiveDraftThreadMatchesRequest =
    latestActiveDraftThread !== null &&
    latestActiveDraftThread.projectId === projectId &&
    latestActiveDraftThread.envMode === requestedEnvMode &&
    latestActiveDraftThread.worktreePath === requestedWorktreePath;

  if (storedDraftThread) {
    if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
      setDraftThreadContext(storedDraftThread.threadId, {
        ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
        ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
        ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
      });
    }
    setProjectDraftThreadId(projectId, storedDraftThread.threadId, {
      envMode: requestedEnvMode,
      worktreePath: requestedWorktreePath,
    });
    maybeMarkOnboardingLiteCompleted(
      projectId,
      storedDraftThread.threadId,
      onboardingLiteStatus,
      updateSettings,
    );
    if (routeThreadId !== storedDraftThread.threadId) {
      await navigate({
        to: "/$threadId",
        params: { threadId: storedDraftThread.threadId },
      });
    }
    return {
      projectId,
      threadId: storedDraftThread.threadId,
    };
  }

  if (latestActiveDraftThreadMatchesRequest && routeThreadId) {
    if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
      setDraftThreadContext(routeThreadId, {
        ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
        ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
        ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
      });
    }
    setProjectDraftThreadId(projectId, routeThreadId, {
      envMode: requestedEnvMode,
      worktreePath: requestedWorktreePath,
    });
    maybeMarkOnboardingLiteCompleted(
      projectId,
      routeThreadId,
      onboardingLiteStatus,
      updateSettings,
    );
    return {
      projectId,
      threadId: routeThreadId,
    };
  }

  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  setProjectDraftThreadId(projectId, threadId, {
    createdAt,
    branch: options?.branch ?? null,
    worktreePath: options?.worktreePath ?? null,
    envMode: requestedEnvMode,
    runtimeMode: DEFAULT_RUNTIME_MODE,
  });
  seedDraftThreadFromModelPreferences(threadId);
  maybeMarkOnboardingLiteCompleted(projectId, threadId, onboardingLiteStatus, updateSettings);

  await navigate({
    to: "/$threadId",
    params: { threadId },
  });

  return {
    projectId,
    threadId,
  };
}

export function useCreateProjectBackedDraftThread() {
  const navigate = useNavigate();
  const { settings, updateSettings } = useAppSettings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  return useCallback(
    (projectId: ProjectId, options?: CreateProjectBackedDraftThreadOptions) =>
      createProjectBackedDraftThread({
        navigate,
        onboardingLiteStatus: settings.onboardingLiteStatus,
        projectId,
        routeThreadId,
        updateSettings,
        ...(options ? { options } : {}),
      }),
    [navigate, routeThreadId, settings.onboardingLiteStatus, updateSettings],
  );
}
