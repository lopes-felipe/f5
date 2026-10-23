import { resolveNewThreadPreferences } from "../newThreadPreferences";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import {
  cachedGlobalDraftSettings,
  defaultDraftRuntimeMode,
  rememberDraftSettings,
} from "../lib/draftSettingsDefaults";
import { ensureNativeApi } from "../nativeApi";
import { type ProjectId, type ServerSettings, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { type AppSettings, updateAppSettings, useAppSettingsSelector } from "../appSettings";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { useProjectThreadEnvModeResolver } from "../lib/projectConfigReactQuery";
import { getModelPreferences } from "../modelPreferencesStore";
import { useStore } from "../store";

export interface CreateProjectBackedDraftThreadOptions {
  /** Rechecked after async settings resolution, immediately before navigation. */
  canNavigate?: () => boolean;
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  forceNonDefaultEnvMode?: boolean;
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

export function seedDraftThreadFromModelPreferences(
  threadId: ThreadId,
  projectId?: ProjectId,
  serverSettings = cachedGlobalDraftSettings(),
): void {
  const project = useStore.getState().projects.find((entry) => entry.id === projectId);
  const preference = resolveNewThreadPreferences(project, serverSettings, getModelPreferences());
  const draft = useComposerDraftStore.getState();
  if (preference.provider) draft.setProvider(threadId, preference.provider);
  if (preference.instanceId) draft.setProviderInstance(threadId, preference.instanceId);
  if (preference.model) draft.setModel(threadId, preference.model);
  if (preference.options !== undefined) draft.setModelOptions(threadId, preference.options);
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
  let resolvedSettings: ServerSettings | undefined;
  let runtimeMode = defaultDraftRuntimeMode(projectId);
  try {
    resolvedSettings = (await ensureNativeApi().server.getProjectSettings({ projectId })).settings;
    rememberDraftSettings(resolvedSettings, projectId);
    runtimeMode = resolvedSettings.defaultRuntimeMode;
  } catch {
    // Local draft creation remains available while reconnecting.
  }
  // Re-read drafts after the await: concurrent clicks must reuse the first draft.
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
    if (routeThreadId !== storedDraftThread.threadId && options?.canNavigate?.() !== false) {
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
    runtimeMode,
  });
  seedDraftThreadFromModelPreferences(threadId, projectId, resolvedSettings);
  maybeMarkOnboardingLiteCompleted(projectId, threadId, onboardingLiteStatus, updateSettings);

  if (options?.canNavigate?.() !== false) {
    await navigate({
      to: "/$threadId",
      params: { threadId },
    });
  }

  return {
    projectId,
    threadId,
  };
}

export function useCreateProjectBackedDraftThread() {
  const navigate = useNavigate();
  const onboardingLiteStatus = useAppSettingsSelector((settings) => settings.onboardingLiteStatus);
  const resolveProjectThreadEnvMode = useProjectThreadEnvModeResolver();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  return useCallback(
    async (projectId: ProjectId, options?: CreateProjectBackedDraftThreadOptions) => {
      const { forceNonDefaultEnvMode = false, ...draftOptions } = options ?? {};
      // A thread without a project gets its own folder from the server: no branch, no worktree.
      if (isScratchProject(useStore.getState().projects.find((entry) => entry.id === projectId)))
        return createProjectBackedDraftThread({
          navigate,
          onboardingLiteStatus,
          projectId,
          routeThreadId,
          updateSettings: updateAppSettings,
          options: {
            ...draftOptions,
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        });
      const requested =
        draftOptions.envMode ?? (draftOptions.worktreePath ? "worktree" : undefined);
      const envMode = await resolveProjectThreadEnvMode(projectId, {
        ...(requested ? { requested } : {}),
        forceNonDefault: forceNonDefaultEnvMode,
      });
      return createProjectBackedDraftThread({
        navigate,
        onboardingLiteStatus,
        projectId,
        routeThreadId,
        updateSettings: updateAppSettings,
        options: { ...draftOptions, envMode },
      });
    },
    [navigate, onboardingLiteStatus, resolveProjectThreadEnvMode, routeThreadId],
  );
}
