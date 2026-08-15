import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  defaultInstanceIdForDriver,
  type ProjectId,
  type ProjectMemoryType,
  type ProviderKind,
  ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { parseClaudeLaunchArgs } from "@t3tools/shared/cliArgs";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CLAUDE_SUBAGENT_MODEL_INHERIT,
  DEFAULT_CLAUDE_PROJECT_SETTINGS,
  MAX_CUSTOM_MODEL_LENGTH,
  getAppModelOptions,
  getClaudeProjectSettings,
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

function memoryScopeForType(type: ProjectMemoryType): "user" | "project" {
  return type === "user" || type === "feedback" ? "user" : "project";
}

export function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "claudeAgent":
      return settings.customClaudeModels;
    case "grok":
      return settings.customGrokModels;
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

export function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "claudeAgent":
      return defaults.customClaudeModels;
    case "grok":
      return defaults.customGrokModels;
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

export function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "claudeAgent":
      return { customClaudeModels: models };
    case "grok":
      return { customGrokModels: models };
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

export interface UseSettingsRouteStateOptions {
  readonly projectSelection?: {
    readonly projectId: ProjectId | null;
    readonly onProjectIdChange: (projectId: ProjectId | null) => void;
  };
}

export function useSettingsRouteState(options: UseSettingsRouteStateOptions = {}) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const projects = useStore((state) => state.projects);
  const syncStartupSnapshot = useStore((state) => state.syncStartupSnapshot);
  const notificationPermission = useThreadStatusNotificationPermissionState();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [isRequestingNotificationPermission, setIsRequestingNotificationPermission] =
    useState(false);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    cursor: "",
    opencode: "",
    grok: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [localSelectedProjectId, setLocalSelectedProjectId] = useState<ProjectId | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>(EMPTY_MEMORY_DRAFT);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryDraft, setEditingMemoryDraft] = useState<MemoryDraft>(EMPTY_MEMORY_DRAFT);
  const [createMemoryError, setCreateMemoryError] = useState<string | null>(null);
  const [existingMemoryError, setExistingMemoryError] = useState<string | null>(null);
  const [memoryActionPendingId, setMemoryActionPendingId] = useState<string | null>(null);

  const claudeLaunchArgsParseResult = useMemo(
    () => parseClaudeLaunchArgs(settings.claudeLaunchArgs),
    [settings.claudeLaunchArgs],
  );
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
  const isProjectSelectionControlled = options.projectSelection !== undefined;
  const selectedProjectId = isProjectSelectionControlled
    ? (options.projectSelection?.projectId ?? null)
    : localSelectedProjectId;
  const selectedProjectMatch = selectedProjectId
    ? (projects.find((project) => project.id === selectedProjectId) ?? null)
    : null;
  const selectedProjectUnavailable = selectedProjectId !== null && selectedProjectMatch === null;
  const selectedProject = selectedProjectId ? selectedProjectMatch : (projects[0] ?? null);
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
  const selectedProjectClaudeSettings = getClaudeProjectSettings(settings, selectedProject?.id);
  const defaultClaudeInstanceId = defaultInstanceIdForDriver(
    ProviderDriverKind.make("claudeAgent"),
  );
  const claudeSubagentModelOptions =
    serverConfigQuery.data?.providers.find(
      (provider) => provider.instanceId === defaultClaudeInstanceId,
    )?.models ?? [];
  const effectiveClaudeSubagentModel = resolveClaudeSubagentModel(
    selectedProjectClaudeSettings.subagentModel,
    claudeSubagentModelOptions,
  );
  const selectedClaudeSubagentModelLabel =
    effectiveClaudeSubagentModel === CLAUDE_SUBAGENT_MODEL_INHERIT
      ? "Inherit from parent"
      : (claudeSubagentModelOptions.find((option) => option.slug === effectiveClaudeSubagentModel)
          ?.name ?? effectiveClaudeSubagentModel);
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

  const onControlledProjectIdChange = options.projectSelection?.onProjectIdChange;
  const handleSelectedProjectChange = useCallback(
    (projectId: ProjectId | null) => {
      if (isProjectSelectionControlled) {
        onControlledProjectIdChange?.(projectId);
      } else {
        setLocalSelectedProjectId(projectId);
      }
      setEditingMemoryId(null);
      setEditingMemoryDraft(EMPTY_MEMORY_DRAFT);
      setCreateMemoryError(null);
      setExistingMemoryError(null);
    },
    [isProjectSelectionControlled, onControlledProjectIdChange],
  );

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      handleSelectedProjectChange(projects[0].id);
      return;
    }
    if (
      !isProjectSelectionControlled &&
      selectedProjectId &&
      !projects.some((project) => project.id === selectedProjectId)
    ) {
      handleSelectedProjectChange(projects[0]?.id ?? null);
    }
  }, [handleSelectedProjectChange, isProjectSelectionControlled, projects, selectedProjectId]);

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

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const refreshSnapshot = useCallback(async () => {
    const { snapshot } = await ensureNativeApi().orchestration.getStartupSnapshot();
    syncStartupSnapshot(snapshot);
  }, [syncStartupSnapshot]);

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

  const updateSelectedProjectClaudeSettings = useCallback(
    (patch: Partial<typeof DEFAULT_CLAUDE_PROJECT_SETTINGS>) => {
      if (!selectedProject) {
        return;
      }

      const normalized = {
        subagentsEnabled:
          ("subagentsEnabled" in patch
            ? patch.subagentsEnabled
            : selectedProjectClaudeSettings.subagentsEnabled) !== false,
        subagentModel:
          "subagentModel" in patch
            ? typeof patch.subagentModel === "string" && patch.subagentModel.trim().length > 0
              ? patch.subagentModel.trim()
              : CLAUDE_SUBAGENT_MODEL_INHERIT
            : selectedProjectClaudeSettings.subagentModel,
      };
      const nextProjectSettings = { ...settings.claudeProjectSettings };

      if (
        normalized.subagentsEnabled === DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentsEnabled &&
        normalized.subagentModel === DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentModel
      ) {
        delete nextProjectSettings[selectedProject.id];
      } else {
        nextProjectSettings[selectedProject.id] = normalized;
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
    hasProjects,
    selectedProjectId,
    selectedProject,
    selectedProjectUnavailable,
    selectedProjectSummary,
    selectedProjectMemories,
    handleSelectedProjectChange,
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
    claudeLaunchArgsParseResult,
    customModelInputByProvider,
    setCustomModelInputByProvider,
    customModelErrorByProvider,
    setCustomModelErrorByProvider,
    addCustomModel,
    removeCustomModel,
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
    selectedProjectClaudeSettings,
    effectiveClaudeSubagentModel,
    claudeSubagentModelOptions,
    selectedClaudeSubagentModelLabel,
    updateSelectedProjectClaudeSettings,
  } as const;
}

export type SettingsRouteValue = ReturnType<typeof useSettingsRouteState>;
