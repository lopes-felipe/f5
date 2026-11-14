import { useEffect, useMemo } from "react";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelSlug,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerConfig,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createModelSelection,
  getDefaultModel,
  inferProviderForModel,
  normalizeModelSlug,
  resolveCodexDispatchModelOptions,
  resolveSelectableModel,
} from "@t3tools/shared/model";

import { type AppSettings, resolveThreadTitleModel } from "~/appSettings";
import {
  getCustomModelOptionsByProvider,
  providerKindForImportedThread,
  resolveComposerModelOptionsSeed,
} from "~/components/ChatView.logic";
import { supportsClaudeTraitsControls } from "~/components/chat/ClaudeTraitsPicker";
import {
  getComposerEffortDescriptors,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "~/components/chat/composerProviderState";
import { type ComposerThreadDraftState, useComposerDraftStore } from "~/composerDraftStore";
import { getCurrentEffort } from "~/favoritePresets";
import {
  getCustomModelOptionsByInstance,
  type ModelCatalogSettings,
  resolveComposerFallbackModel,
  resolveFallbackModelOptions,
} from "~/modelSelection";
import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  NO_PROVIDER_INSTANCE_ID,
  resolveComposerProviderInstance,
} from "~/providerInstances";
import {
  providerModelOptionsToSelections,
  providerSelectionsToModelOptions,
} from "~/providerModelOptions";
import { getProviderModelCapabilities, pickPreferredModel } from "~/providerModels";
import { resolveProviderOptionsForDispatch } from "~/providerOptionsForDispatch";
import { useServerCapability } from "~/protocolState";
import { getThreadModelOptionsSeed, recordThreadModelOptionsSeed } from "~/threadModelOptionsSeeds";
import type { UnifiedWebSettings } from "~/hooks/useSettings";
import type { Project, Thread } from "~/types";

const EMPTY_PROVIDER_STATUSES: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];

/** The app settings a composer reads to decide what a send carries. */
export type ComposerDispatchAppSettings = Pick<
  AppSettings,
  | "claudeBinaryPath"
  | "claudeLaunchArgs"
  | "claudeProjectSettings"
  | "claudeSubagentDefaults"
  | "codexBinaryPath"
  | "codexHomePath"
  | "codexThreadTitleModel"
  | "customClaudeModels"
  | "customCodexModels"
  | "customGrokModels"
  | "providerModelPreferences"
>;

/** For a composer that reads no other app setting. ChatView selects these with its own. */
export function selectComposerDispatchAppSettings(
  settings: AppSettings,
): ComposerDispatchAppSettings {
  return {
    claudeBinaryPath: settings.claudeBinaryPath,
    claudeLaunchArgs: settings.claudeLaunchArgs,
    claudeProjectSettings: settings.claudeProjectSettings,
    claudeSubagentDefaults: settings.claudeSubagentDefaults,
    codexBinaryPath: settings.codexBinaryPath,
    codexHomePath: settings.codexHomePath,
    codexThreadTitleModel: settings.codexThreadTitleModel,
    customClaudeModels: settings.customClaudeModels,
    customCodexModels: settings.customCodexModels,
    customGrokModels: settings.customGrokModels,
    providerModelPreferences: settings.providerModelPreferences,
  };
}

export function selectModelCatalogSettings(settings: UnifiedWebSettings): ModelCatalogSettings {
  return {
    providerInstances: settings.providerInstances,
    providers: settings.providers,
    providerModelPreferences: settings.providerModelPreferences,
  };
}

export interface ComposerDispatchSettingsInput {
  readonly threadId: ThreadId;
  readonly composerDraft: Pick<
    ComposerThreadDraftState,
    "provider" | "providerInstanceId" | "model" | "modelOptions"
  >;
  /** The thread as the server has it; undefined before the first send. */
  readonly serverThread: Thread | undefined;
  /**
   * The local draft standing in for the thread before the first send. It is read only
   * while there is no server thread, and its placeholder selection never seeds the draft.
   */
  readonly localDraftThread: Thread | undefined;
  readonly project: Project | undefined;
  /** Provider snapshots with the project's enablement applied. */
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly serverConfig: Pick<ServerConfig, "providers" | "settings"> | undefined;
  readonly settings: ComposerDispatchAppSettings;
  readonly modelCatalogSettings: ModelCatalogSettings;
  /**
   * Whether the draft's model options are seeded from the thread, the project and the saved
   * preferences. Off for a workflow slot's thread, whose options the workflow owns.
   */
  readonly seedsModelOptions: boolean;
}

/**
 * Resolves the provider instance, model and options a composer shows and sends, from the
 * draft, the thread, the project and the provider catalog. It also seeds the draft's model
 * options when the selection changes.
 */
export function useComposerDispatchSettings(input: ComposerDispatchSettingsInput) {
  const {
    threadId,
    composerDraft,
    serverThread,
    project: activeProject,
    providerStatuses,
    serverConfig,
    settings,
    modelCatalogSettings: unifiedSettings,
    seedsModelOptions,
  } = input;
  // Derived here, so a caller cannot pass a draft and call it a server thread.
  const isServerThread = serverThread !== undefined;
  const activeThread = serverThread ?? input.localDraftThread;
  const setComposerDraftModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.provider;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const importedThreadProvider = providerKindForImportedThread({
    instanceId: activeThread?.modelSelection?.instanceId,
    providers: serverConfig?.providers ?? EMPTY_PROVIDER_STATUSES,
    configured: serverConfig?.settings?.providerInstances,
  });
  const inferredThreadProvider =
    activeThread && activeThread.session === null && !selectedProviderByThreadId
      ? (importedThreadProvider ?? inferProviderForModel(activeThread.model, "codex"))
      : null;
  // A server that hands the conversation off lets a started thread switch
  // providers; an older server keeps the started thread's provider locked.
  const providerContextHandoff = useServerCapability("provider-context-handoff");
  const providerLocked = hasThreadStarted && !providerContextHandoff;
  /** The live session's instance; a send naming another one switches providers. */
  const sessionInstanceId: ProviderInstanceId | null = activeThread?.session
    ? (activeThread.session.providerInstanceId ??
      defaultInstanceIdForDriver(ProviderDriverKind.make(activeThread.session.provider)))
    : null;
  const lockedProvider: ProviderKind | null = providerLocked
    ? (sessionProvider ??
      importedThreadProvider ??
      selectedProviderByThreadId ??
      inferredThreadProvider)
    : null;
  // A started thread always requests its own instance, even when the session or
  // an older thread never recorded one, so nothing falls back to another provider.
  const startedThreadProvider = hasThreadStarted
    ? (sessionProvider ??
      selectedProviderByThreadId ??
      importedThreadProvider ??
      inferredThreadProvider)
    : null;
  const requestedInstanceId =
    composerDraft.providerInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection?.instanceId ??
    sessionInstanceId ??
    (startedThreadProvider
      ? defaultInstanceIdForDriver(ProviderDriverKind.make(startedThreadProvider))
      : undefined) ??
    activeProject?.defaultModelSelection?.instanceId;
  const selectedProviderEntry = useMemo(() => {
    const entries = deriveProviderInstanceEntries(providerStatuses);
    const lockedInstanceId =
      activeThread?.session?.providerInstanceId ??
      activeThread?.modelSelection?.instanceId ??
      (lockedProvider
        ? defaultInstanceIdForDriver(ProviderDriverKind.make(lockedProvider))
        : undefined);
    const preferred =
      selectedProviderByThreadId ?? (isServerThread ? inferredThreadProvider : null);
    return resolveComposerProviderInstance(entries, {
      candidates: [providerLocked ? lockedInstanceId : requestedInstanceId],
      preferredDriver: preferred ? ProviderDriverKind.make(preferred) : undefined,
      lockedDriver: lockedProvider ? ProviderDriverKind.make(lockedProvider) : null,
      lockedInstanceId: providerLocked ? lockedInstanceId : undefined,
      keepRequested: hasThreadStarted,
    });
  }, [
    providerStatuses,
    requestedInstanceId,
    lockedProvider,
    providerLocked,
    hasThreadStarted,
    activeThread?.session?.providerInstanceId,
    activeThread?.modelSelection?.instanceId,
    selectedProviderByThreadId,
    inferredThreadProvider,
    isServerThread,
  ]);
  const noProviderAvailable = selectedProviderEntry === undefined;
  const selectedProvider = (selectedProviderEntry?.driverKind ??
    lockedProvider ??
    (hasThreadStarted ? (sessionProvider ?? importedThreadProvider) : null) ??
    selectedProviderByThreadId ??
    "codex") as ProviderKind;
  const selectedThreadTitleModel = resolveThreadTitleModel(settings);
  const selectedThreadTitleModelSelection = useMemo(
    () =>
      createModelSelection(
        defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
        selectedThreadTitleModel,
      ),
    [selectedThreadTitleModel],
  );
  const providerSelectionChanged =
    !providerLocked &&
    selectedProviderEntry !== undefined &&
    requestedInstanceId !== undefined &&
    requestedInstanceId !== selectedProviderEntry.instanceId;
  const sameDriverFallback =
    providerSelectionChanged &&
    providerStatuses.some(
      (entry) => entry.instanceId === requestedInstanceId && entry.driver === selectedProvider,
    );
  const selectedProviderDriver = ProviderDriverKind.make(selectedProvider);
  const selectedProviderInstanceId = selectedProviderEntry?.instanceId ?? NO_PROVIDER_INSTANCE_ID;
  const modelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(settings, serverConfig?.providers, serverConfig?.settings),
    [settings, serverConfig?.providers, serverConfig?.settings],
  );
  const modelOptionsByInstance = useMemo(() => {
    const providers = serverConfig?.providers ?? EMPTY_PROVIDER_STATUSES;
    const next = new Map(getCustomModelOptionsByInstance(unifiedSettings, providers));
    for (const provider of providers) {
      if (provider.instanceId !== defaultInstanceIdForDriver(provider.driver)) continue;
      const legacyOptions = modelOptionsByProvider[provider.driver as ProviderKind] ?? [];
      const instanceOptions = next.get(provider.instanceId) ?? [];
      const seen = new Set(instanceOptions.map((option) => option.slug));
      next.set(provider.instanceId, [
        ...instanceOptions,
        ...legacyOptions.filter((option) => !seen.has(option.slug)),
      ]);
    }
    return next;
  }, [modelOptionsByProvider, serverConfig?.providers, unifiedSettings]);
  const selectedProviderPickerOptions =
    modelOptionsByInstance.get(selectedProviderInstanceId) ?? [];
  const baseThreadModel = useMemo(() => {
    const instanceDefault = getDefaultProviderInstanceModel(
      providerStatuses,
      selectedProviderInstanceId,
    );
    if (sameDriverFallback) {
      return (
        resolveComposerFallbackModel({
          driver: selectedProviderDriver,
          candidate: activeThread?.model ?? activeProject?.model,
          instanceDefault,
          models: selectedProviderPickerOptions,
        }) ?? getDefaultModel(selectedProvider)
      );
    }
    const rawModel =
      (providerSelectionChanged && !sameDriverFallback
        ? instanceDefault
        : (activeThread?.model ?? activeProject?.model)) ??
      instanceDefault ??
      pickPreferredModel(selectedProviderPickerOptions, [getDefaultModel(selectedProvider)])
        ?.slug ??
      getDefaultModel(selectedProvider);
    return (
      resolveSelectableModel(selectedProviderDriver, rawModel, selectedProviderPickerOptions) ??
      selectedProviderPickerOptions[0]?.slug ??
      getDefaultModel(selectedProvider)
    );
  }, [
    providerStatuses,
    selectedProviderInstanceId,
    providerSelectionChanged,
    sameDriverFallback,
    activeProject?.model,
    activeThread?.model,
    selectedProvider,
    selectedProviderDriver,
    selectedProviderPickerOptions,
  ]);
  const selectedModel = useMemo(() => {
    const draftModel = providerSelectionChanged && !sameDriverFallback ? null : composerDraft.model;
    if (!draftModel) {
      return baseThreadModel;
    }
    return (resolveSelectableModel(
      selectedProviderDriver,
      draftModel,
      selectedProviderPickerOptions,
    ) ?? baseThreadModel) as ModelSlug;
  }, [
    baseThreadModel,
    composerDraft.model,
    providerSelectionChanged,
    sameDriverFallback,
    selectedProviderDriver,
    selectedProviderPickerOptions,
  ]);
  const draftModelOptions = useMemo(() => {
    if (!providerSelectionChanged) return composerDraft.modelOptions;
    const draftOptions = providerModelOptionsToSelections(
      selectedProvider,
      composerDraft.modelOptions,
    );
    const selection = {
      model: composerDraft.model ?? activeThread?.model ?? activeProject?.model ?? "",
      options: draftOptions,
    };
    const options = resolveFallbackModelOptions({
      settings: unifiedSettings,
      providers: providerStatuses,
      requestedInstanceId,
      selectedInstanceId: selectedProviderInstanceId,
      selectedDriver: selectedProviderDriver,
      selectedModel,
      selection,
    });
    return options ? providerSelectionsToModelOptions(selectedProvider, options) : null;
  }, [
    providerSelectionChanged,
    composerDraft.modelOptions,
    composerDraft.model,
    activeThread?.model,
    activeProject?.model,
    unifiedSettings,
    providerStatuses,
    requestedInstanceId,
    selectedProviderInstanceId,
    selectedProviderDriver,
    selectedProvider,
    selectedModel,
  ]);
  // A local draft has no recorded selection to seed from.
  const threadModelSelection = serverThread?.modelSelection;
  useEffect(() => {
    if (!seedsModelOptions) return;
    const next = resolveComposerModelOptionsSeed({
      draftModelOptions: composerDraft.modelOptions,
      selectedModel,
      threadSelection: threadModelSelection,
      selectedInstanceId: selectedProviderInstanceId,
      selectedProvider,
      previous: getThreadModelOptionsSeed(threadId),
      fallback: providerSelectionChanged,
      requestedInstanceId,
      projectSelection: activeProject?.defaultModelSelection,
      providers: providerStatuses,
      settings: unifiedSettings,
    });
    if (!next) return;
    recordThreadModelOptionsSeed(threadId, next.record);
    if (next.seed) setComposerDraftModelOptions(threadId, next.seed);
  }, [
    composerDraft.modelOptions,
    selectedModel,
    selectedProvider,
    selectedProviderInstanceId,
    setComposerDraftModelOptions,
    threadId,
    threadModelSelection,
    seedsModelOptions,
    providerSelectionChanged,
    requestedInstanceId,
    activeProject?.defaultModelSelection,
    providerStatuses,
    unifiedSettings,
  ]);
  const selectedProviderModelOptions = useMemo(
    () => providerModelOptionsToSelections(selectedProvider, draftModelOptions),
    [draftModelOptions, selectedProvider],
  );
  const selectedProviderSnapshot = useMemo(
    () =>
      (serverConfig?.providers ?? EMPTY_PROVIDER_STATUSES).find(
        (provider) => provider.instanceId === selectedProviderInstanceId,
      ) ?? null,
    [selectedProviderInstanceId, serverConfig?.providers],
  );
  const selectedProviderModels = selectedProviderSnapshot?.models ?? EMPTY_PROVIDER_MODELS;
  const showInteractionModeToggle = selectedProviderSnapshot?.showInteractionModeToggle ?? true;
  const genericComposerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProviderDriver,
        model: selectedModel,
        models: selectedProviderModels,
        modelOptions: selectedProviderModelOptions,
      }),
    [selectedModel, selectedProviderDriver, selectedProviderModelOptions, selectedProviderModels],
  );
  const selectedProviderModelOptionsForDispatch =
    genericComposerProviderState.modelOptionsForDispatch ?? selectedProviderModelOptions;
  const selectedComposerEffort = useMemo(
    () =>
      getCurrentEffort(
        getComposerEffortDescriptors({
          provider: selectedProviderDriver,
          model: selectedModel,
          models: selectedProviderModels,
          modelOptions: selectedProviderModelOptionsForDispatch,
        }),
      ),
    [
      selectedModel,
      selectedProviderDriver,
      selectedProviderModelOptionsForDispatch,
      selectedProviderModels,
    ],
  );
  const genericModelOptionsForDispatch = useMemo(
    () =>
      providerSelectionsToModelOptions(selectedProvider, selectedProviderModelOptionsForDispatch) ??
      undefined,
    [selectedProvider, selectedProviderModelOptionsForDispatch],
  );
  const genericProviderTraitsMenuContent = useMemo(() => {
    if (selectedProvider === "codex" || selectedProvider === "claudeAgent") {
      return null;
    }
    return renderProviderTraitsMenuContent({
      provider: selectedProviderDriver,
      draftId: threadId,
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: selectedProviderModelOptions,
    });
  }, [
    selectedModel,
    selectedProvider,
    selectedProviderDriver,
    selectedProviderModelOptions,
    selectedProviderModels,
    threadId,
  ]);
  const genericProviderTraitsPicker = useMemo(() => {
    if (selectedProvider === "codex" || selectedProvider === "claudeAgent") {
      return null;
    }
    return renderProviderTraitsPicker({
      provider: selectedProviderDriver,
      draftId: threadId,
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: selectedProviderModelOptions,
    });
  }, [
    selectedModel,
    selectedProvider,
    selectedProviderDriver,
    selectedProviderModelOptions,
    selectedProviderModels,
    threadId,
  ]);
  const isClaudeUltrathink =
    selectedProvider === "claudeAgent" &&
    genericComposerProviderState.promptEffort === "ultrathink";
  const showClaudeTraitsControls = useMemo(
    () =>
      selectedProvider === "claudeAgent" &&
      supportsClaudeTraitsControls({
        model: selectedModel,
        models: selectedProviderModels,
        modelOptions: selectedProviderModelOptions,
      }),
    [selectedModel, selectedProvider, selectedProviderModelOptions, selectedProviderModels],
  );
  const selectedModelOptionsForDispatch = useMemo(() => {
    if (selectedProvider === "codex") {
      // Same reported capabilities the picker offered, so the sent effort matches.
      // The effort stays explicit: the session may report a different default.
      const codexOptions = resolveCodexDispatchModelOptions(
        selectedModel,
        draftModelOptions?.codex,
        getProviderModelCapabilities(
          selectedProviderModels,
          selectedModel,
          ProviderDriverKind.make("codex"),
        ),
      );
      return codexOptions ? { codex: codexOptions } : undefined;
    }
    return genericModelOptionsForDispatch;
  }, [
    draftModelOptions?.codex,
    genericModelOptionsForDispatch,
    selectedModel,
    selectedProvider,
    selectedProviderModels,
  ]);
  const selectedModelSelectionOptionsForDispatch = useMemo(
    () =>
      selectedProvider === "codex"
        ? providerModelOptionsToSelections("codex", selectedModelOptionsForDispatch)
        : selectedProviderModelOptionsForDispatch,
    [selectedModelOptionsForDispatch, selectedProvider, selectedProviderModelOptionsForDispatch],
  );
  const selectedModelSelectionForDispatch = useMemo(
    () =>
      createModelSelection(
        selectedProviderInstanceId,
        selectedModel,
        selectedModelSelectionOptionsForDispatch,
      ),
    [selectedModel, selectedProviderInstanceId, selectedModelSelectionOptionsForDispatch],
  );
  const providerOptionsForDispatch = useMemo(
    () =>
      resolveProviderOptionsForDispatch({
        settings,
        provider: selectedProvider,
        projectId: activeProject?.id,
        availableModels: selectedProviderModels,
      }),
    [
      activeProject?.id,
      selectedProvider,
      selectedProviderModels,
      settings.claudeBinaryPath,
      settings.claudeLaunchArgs,
      settings.claudeProjectSettings,
      settings.claudeSubagentDefaults,
      settings.codexBinaryPath,
      settings.codexHomePath,
    ],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedProviderInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModel)
      ? selectedModel
      : (normalizeModelSlug(selectedModel, selectedProvider) ?? selectedModel);
  }, [modelOptionsByInstance, selectedModel, selectedProvider, selectedProviderInstanceId]);

  return {
    hasThreadStarted,
    providerContextHandoff,
    providerLocked,
    lockedProvider,
    sessionInstanceId,
    requestedInstanceId,
    noProviderAvailable,
    selectedProvider,
    selectedProviderDriver,
    selectedProviderInstanceId,
    selectedProviderSnapshot,
    selectedProviderModels,
    showInteractionModeToggle,
    modelOptionsByInstance,
    selectedModel,
    selectedModelForPickerWithCustomFallback,
    selectedProviderModelOptions,
    selectedProviderModelOptionsForDispatch,
    selectedComposerEffort,
    genericProviderTraitsMenuContent,
    genericProviderTraitsPicker,
    isClaudeUltrathink,
    showClaudeTraitsControls,
    selectedModelOptionsForDispatch,
    selectedModelSelectionForDispatch,
    providerOptionsForDispatch,
    selectedThreadTitleModel,
    selectedThreadTitleModelSelection,
  };
}
