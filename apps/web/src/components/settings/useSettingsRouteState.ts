import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { withoutScratchProjects } from "@t3tools/shared/scratchProject";
import { invalidateWorkflowQueries } from "../../lib/workflowQueries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  defaultInstanceIdForDriver,
  type ProjectId,
  type ProjectIcon,
  type ProjectMemoryType,
  ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CLAUDE_SUBAGENT_MODEL_INHERIT,
  DEFAULT_CLAUDE_PROJECT_SETTINGS,
  getAppModelOptions,
  getClaudeProjectSettings,
  getClaudeSubagentDefaults,
  useAppSettings,
} from "../../appSettings";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { useTheme } from "../../hooks/useTheme";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { findKeybindingConflicts } from "../../lib/keybindingConflicts";
import { newCommandId } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { resolveClaudeSubagentModel } from "../ChatView.logic";
import {
  dismissThreadStatusNotificationPrompt,
  requestThreadStatusNotificationPermission,
  resetThreadStatusNotificationPrompt,
  useThreadStatusNotificationPermissionState,
} from "../../threadStatusNotifications";

export const PROJECT_MEMORY_TYPES: ProjectMemoryType[] = [
  "feedback",
  "project",
  "reference",
  "user",
];

export type MemoryDraft = {
  type: ProjectMemoryType;
  name: string;
  description: string;
  body: string;
};

export const EMPTY_MEMORY_DRAFT: MemoryDraft = {
  type: "feedback",
  name: "",
  description: "",
  body: "",
};

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function normalizeClaudeSubagentPatch(
  patch: Partial<typeof DEFAULT_CLAUDE_PROJECT_SETTINGS>,
  current: typeof DEFAULT_CLAUDE_PROJECT_SETTINGS,
): typeof DEFAULT_CLAUDE_PROJECT_SETTINGS {
  return {
    subagentsEnabled:
      ("subagentsEnabled" in patch ? patch.subagentsEnabled : current.subagentsEnabled) !== false,
    subagentModel:
      "subagentModel" in patch
        ? typeof patch.subagentModel === "string" && patch.subagentModel.trim().length > 0
          ? patch.subagentModel.trim()
          : CLAUDE_SUBAGENT_MODEL_INHERIT
        : current.subagentModel,
  };
}

function memoryScopeForType(type: ProjectMemoryType): "user" | "project" {
  return type === "user" || type === "feedback" ? "user" : "project";
}

export interface UseSettingsRouteStateOptions {
  /** The project selected in the settings scope picker, or null for global scope. */
  readonly projectId?: ProjectId | null;
}

export function useSettingsRouteState(options: UseSettingsRouteStateOptions = {}) {
  const queryClient = useQueryClient();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { defaults: appDefaults } = useAppSettings();
  const settings = useSettings();
  const defaults = { ...DEFAULT_UNIFIED_SETTINGS, ...appDefaults };
  const { updateSettings } = useUpdateSettings();
  const storeProjects = useStore((state) => state.projects);
  // The home for threads without a project has no project settings of its own.
  const projects = useMemo(() => withoutScratchProjects(storeProjects), [storeProjects]);
  const projectsHydrated = useStore((state) => state.threadsHydrated);
  const syncStartupSnapshot = useStore((state) => state.syncStartupSnapshot);
  const notificationPermission = useThreadStatusNotificationPermissionState();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [isRequestingNotificationPermission, setIsRequestingNotificationPermission] =
    useState(false);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>(EMPTY_MEMORY_DRAFT);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryDraft, setEditingMemoryDraft] = useState<MemoryDraft>(EMPTY_MEMORY_DRAFT);
  const [createMemoryError, setCreateMemoryError] = useState<string | null>(null);
  const [existingMemoryError, setExistingMemoryError] = useState<string | null>(null);
  const [memoryActionPendingId, setMemoryActionPendingId] = useState<string | null>(null);
  const [projectMetadataPending, setProjectMetadataPending] = useState(false);
  const [projectMetadataError, setProjectMetadataError] = useState<string | null>(null);

  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const customKeybindings = serverConfigQuery.data?.customKeybindings ?? [];
  const availableEditors = serverConfigQuery.data?.availableEditors;
  const keybindingConflicts = useMemo(() => findKeybindingConflicts(keybindings), [keybindings]);
  const notificationPermissionSummary =
    notificationPermission === "granted"
      ? "granted"
      : notificationPermission === "denied"
        ? "denied"
        : notificationPermission === "default"
          ? "not requested"
          : "unsupported";
  const selectedProjectId = options.projectId ?? null;
  const selectedProject = selectedProjectId
    ? (projects.find((project) => project.id === selectedProjectId) ?? null)
    : null;
  const selectedProjectUnavailable =
    projectsHydrated && selectedProjectId !== null && selectedProject === null;
  const selectedProjectSummaryId = selectedProject?.id ?? null;
  const selectedProjectSummaryName = selectedProject?.name ?? null;
  const selectedProjectMemories = selectedProject?.memories ?? [];
  const selectedProjectSummary = useMemo(
    () =>
      selectedProjectSummaryId && selectedProjectSummaryName
        ? {
            id: selectedProjectSummaryId,
            name: selectedProjectSummaryName,
          }
        : null,
    [selectedProjectSummaryId, selectedProjectSummaryName],
  );
  const hasProjects = projects.length > 0;
  const claudeSubagentDefaults = getClaudeSubagentDefaults(settings);
  const selectedProjectClaudeSettings = getClaudeProjectSettings(settings, selectedProject?.id);
  const selectedProjectHasClaudeOverride =
    selectedProject !== null && Object.hasOwn(settings.claudeProjectSettings, selectedProject.id);
  const defaultClaudeInstanceId = defaultInstanceIdForDriver(
    ProviderDriverKind.make("claudeAgent"),
  );
  const claudeSubagentModelOptions =
    serverConfigQuery.data?.providers.find(
      (provider) => provider.instanceId === defaultClaudeInstanceId,
    )?.models ?? [];
  const claudeSubagentModelLabel = (model: string) => {
    const effective = resolveClaudeSubagentModel(model, claudeSubagentModelOptions);
    return effective === CLAUDE_SUBAGENT_MODEL_INHERIT
      ? "Inherit from parent"
      : (claudeSubagentModelOptions.find((option) => option.slug === effective)?.name ?? effective);
  };
  const gitTextGenerationModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.textGenerationModel,
  );
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.slug === (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL),
    )?.name ?? settings.textGenerationModel;

  // Memory drafts belong to one project; drop them when the scope changes.
  useEffect(() => {
    setEditingMemoryId(null);
    setEditingMemoryDraft(EMPTY_MEMORY_DRAFT);
    setCreateMemoryError(null);
    setExistingMemoryError(null);
  }, [selectedProjectId]);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) {
      return;
    }
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const requestNotificationPermission = useCallback(() => {
    resetThreadStatusNotificationPrompt();
    setIsRequestingNotificationPermission(true);
    void requestThreadStatusNotificationPermission()
      .then((permissionState) => {
        if (permissionState !== "granted") {
          dismissThreadStatusNotificationPrompt();
        }
      })
      .catch(() => {
        dismissThreadStatusNotificationPrompt();
      })
      .finally(() => {
        setIsRequestingNotificationPermission(false);
      });
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const { snapshot } = await ensureNativeApi().orchestration.getStartupSnapshot();
    syncStartupSnapshot(snapshot);
    await invalidateWorkflowQueries(queryClient);
  }, [syncStartupSnapshot, queryClient]);

  const updateSelectedProjectMetadata = useCallback(
    async (patch: {
      readonly defaultEnvMode?: "local" | "worktree" | null;
      readonly icon?: ProjectIcon | null;
    }) => {
      if (!selectedProject) return;
      setProjectMetadataError(null);
      setProjectMetadataPending(true);
      try {
        await ensureNativeApi().orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: selectedProject.id,
          ...patch,
        });
        await refreshSnapshot();
      } catch (error) {
        setProjectMetadataError(
          error instanceof Error ? error.message : "Failed to update project settings.",
        );
      } finally {
        setProjectMetadataPending(false);
      }
    },
    [refreshSnapshot, selectedProject],
  );

  const submitMemoryCreate = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    const name = memoryDraft.name.trim();
    const description = memoryDraft.description.trim();
    const body = memoryDraft.body.trim();
    if (!name || !description || !body) {
      setCreateMemoryError("Name, description, and body are required.");
      return;
    }

    setCreateMemoryError(null);
    setMemoryActionPendingId("create");
    try {
      await ensureNativeApi().orchestration.dispatchCommand({
        type: "project.memory.save",
        commandId: newCommandId(),
        projectId: selectedProject.id,
        memoryId: crypto.randomUUID(),
        scope: memoryScopeForType(memoryDraft.type),
        memoryType: memoryDraft.type,
        name,
        description,
        body,
        createdAt: new Date().toISOString(),
      });
      await refreshSnapshot();
      setMemoryDraft(EMPTY_MEMORY_DRAFT);
    } catch (error) {
      setCreateMemoryError(error instanceof Error ? error.message : "Failed to save memory.");
    } finally {
      setMemoryActionPendingId(null);
    }
  }, [memoryDraft, refreshSnapshot, selectedProject]);

  const submitMemoryUpdate = useCallback(async () => {
    if (!selectedProject || !editingMemoryId) {
      return;
    }
    const name = editingMemoryDraft.name.trim();
    const description = editingMemoryDraft.description.trim();
    const body = editingMemoryDraft.body.trim();
    if (!name || !description || !body) {
      setExistingMemoryError("Name, description, and body are required.");
      return;
    }

    setExistingMemoryError(null);
    setMemoryActionPendingId(editingMemoryId);
    try {
      await ensureNativeApi().orchestration.dispatchCommand({
        type: "project.memory.update",
        commandId: newCommandId(),
        projectId: selectedProject.id,
        memoryId: editingMemoryId,
        scope: memoryScopeForType(editingMemoryDraft.type),
        memoryType: editingMemoryDraft.type,
        name,
        description,
        body,
        updatedAt: new Date().toISOString(),
      });
      await refreshSnapshot();
      setEditingMemoryId(null);
      setEditingMemoryDraft(EMPTY_MEMORY_DRAFT);
    } catch (error) {
      setExistingMemoryError(error instanceof Error ? error.message : "Failed to update memory.");
    } finally {
      setMemoryActionPendingId(null);
    }
  }, [editingMemoryDraft, editingMemoryId, refreshSnapshot, selectedProject]);

  const deleteMemory = useCallback(
    async (memoryId: string, memoryName: string) => {
      if (!selectedProject) {
        return;
      }
      if (
        typeof globalThis.confirm === "function" &&
        !globalThis.confirm(`Delete project memory "${memoryName}"?`)
      ) {
        return;
      }
      setExistingMemoryError(null);
      setMemoryActionPendingId(memoryId);
      try {
        await ensureNativeApi().orchestration.dispatchCommand({
          type: "project.memory.delete",
          commandId: newCommandId(),
          projectId: selectedProject.id,
          memoryId,
          deletedAt: new Date().toISOString(),
        });
        await refreshSnapshot();
        if (editingMemoryId === memoryId) {
          setEditingMemoryId(null);
          setEditingMemoryDraft(EMPTY_MEMORY_DRAFT);
        }
      } catch (error) {
        setExistingMemoryError(error instanceof Error ? error.message : "Failed to delete memory.");
      } finally {
        setMemoryActionPendingId(null);
      }
    },
    [editingMemoryId, refreshSnapshot, selectedProject],
  );

  const updateClaudeSubagentDefaults = useCallback(
    (patch: Partial<typeof DEFAULT_CLAUDE_PROJECT_SETTINGS>) => {
      updateSettings({
        claudeSubagentDefaults: normalizeClaudeSubagentPatch(patch, claudeSubagentDefaults),
      });
    },
    [claudeSubagentDefaults, updateSettings],
  );

  /** Sets the project's own sub-agent settings; `null` returns it to the global defaults. */
  const updateSelectedProjectClaudeSettings = useCallback(
    (patch: Partial<typeof DEFAULT_CLAUDE_PROJECT_SETTINGS> | null) => {
      if (!selectedProject) {
        return;
      }
      const nextProjectSettings = { ...settings.claudeProjectSettings };
      if (patch === null) {
        delete nextProjectSettings[selectedProject.id];
      } else {
        nextProjectSettings[selectedProject.id] = normalizeClaudeSubagentPatch(
          patch,
          selectedProjectClaudeSettings,
        );
      }
      updateSettings({
        claudeProjectSettings: nextProjectSettings,
      });
    },
    [
      selectedProject,
      selectedProjectClaudeSettings,
      settings.claudeProjectSettings,
      updateSettings,
    ],
  );

  return {
    theme,
    setTheme,
    resolvedTheme,
    settings,
    defaults,
    updateSettings,
    projects,
    projectsHydrated,
    hasProjects,
    selectedProjectId,
    selectedProject,
    selectedProjectUnavailable,
    selectedProjectSummary,
    selectedProjectMemories,
    projectMetadataPending,
    projectMetadataError,
    updateSelectedProjectMetadata,
    notificationPermission,
    notificationPermissionSummary,
    isRequestingNotificationPermission,
    requestNotificationPermission,
    keybindings,
    customKeybindings,
    keybindingConflicts,
    keybindingsConfigPath,
    isOpeningKeybindings,
    openKeybindingsError,
    openKeybindingsFile,
    gitTextGenerationModelOptions,
    selectedGitTextGenerationModelLabel,
    memoryDraft,
    setMemoryDraft,
    editingMemoryId,
    setEditingMemoryId,
    editingMemoryDraft,
    setEditingMemoryDraft,
    createMemoryError,
    setCreateMemoryError,
    existingMemoryError,
    setExistingMemoryError,
    memoryActionPendingId,
    submitMemoryCreate,
    submitMemoryUpdate,
    deleteMemory,
    claudeSubagentDefaults,
    updateClaudeSubagentDefaults,
    selectedProjectClaudeSettings,
    selectedProjectHasClaudeOverride,
    claudeSubagentModelOptions,
    claudeSubagentModelLabel,
    updateSelectedProjectClaudeSettings,
  } as const;
}

export type SettingsRouteValue = ReturnType<typeof useSettingsRouteState>;
