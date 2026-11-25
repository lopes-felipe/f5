import {
  KNOWN_PROVIDER_KINDS,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
  type UpstreamReviewerSlot,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  normalizeClaudeModelOptions,
  normalizeModelSlug,
  resolveCodexDispatchModelOptions,
} from "@t3tools/shared/model";
import {
  getModelPreferences,
  type WorkflowCreatePreferenceSlot,
} from "../../modelPreferencesStore";
import { getWorkflowModelCapabilities } from "../../providerModels";
import { resolveProviderOptionsForDispatch } from "../../providerOptionsForDispatch";
import { workflowProviderSnapshot } from "@t3tools/shared/workflowProviders";
import { mapProviderKinds, resolveComposerPickerModel } from "../ChatView.logic";
import type { ModelPickerModelOption } from "../chat/providerIconUtils";
import type { TraitsHiddenOptions } from "../chat/TraitsPicker";

export function normalizeWorkflowSlotModelOptions(
  provider: ProviderKind,
  model: string,
  modelOptions: ProviderModelOptions | undefined,
  capabilities?: ModelCapabilities | null,
): ProviderModelOptions | undefined {
  if (provider === "codex") {
    // Store the effort turn/start can execute; unsupported choices walk down to a supported effort.
    const codex = resolveCodexDispatchModelOptions(model, modelOptions?.codex, capabilities);
    return codex ? { codex } : undefined;
  }
  if (provider === "claudeAgent") {
    const normalized = normalizeClaudeModelOptions(model, modelOptions?.claudeAgent, capabilities);
    // Ultracode is hidden in workflow slots (WORKFLOW_HIDDEN_TRAITS), so it is never stored.
    const { ultracode: _ultracode, ...claudeAgent } = normalized ?? {};
    return Object.keys(claudeAgent).length > 0 ? { claudeAgent } : undefined;
  }
  return getSingleProviderModelOptions(provider, modelOptions);
}

/**
 * Traits workflow slots leave out of the composer's traits control:
 * - Prompt-keyword efforts (Claude Ultrathink), since a workflow sends no composer prompt.
 * - Claude Ultracode, since a multi-agent run per slot multiplies a workflow's spend.
 */
export const WORKFLOW_HIDDEN_TRAITS: TraitsHiddenOptions = {
  promptInjected: true,
  descriptorIds: ["ultracode"],
};

/**
 * Whether workflow dispatch applies a slot's traits (`modelOptions` on the turn). OpenCode and
 * Muse read traits only from a thread's model selection, which workflow turns don't send, and
 * Grok and ACP have none, so those slots show no traits control.
 */
export function workflowSlotAppliesModelOptions(provider: ProviderKind): boolean {
  switch (provider) {
    case "codex":
    case "claudeAgent":
    case "cursor":
    case "antigravity":
    case "pi":
      return true;
    case "opencode":
    case "muse":
    case "grok":
    case "acp":
      return false;
  }
}

/** The slot's own provider entry of `modelOptions`, when workflow dispatch applies it. */
export function getSingleProviderModelOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | undefined {
  if (!workflowSlotAppliesModelOptions(provider)) return undefined;
  switch (provider) {
    case "codex":
      return modelOptions?.codex ? { codex: modelOptions.codex } : undefined;
    case "claudeAgent":
      return modelOptions?.claudeAgent ? { claudeAgent: modelOptions.claudeAgent } : undefined;
    case "cursor":
      return modelOptions?.cursor ? { cursor: modelOptions.cursor } : undefined;
    case "antigravity":
      // Keeps a Gemini row's thinking level.
      return modelOptions?.antigravity ? { antigravity: modelOptions.antigravity } : undefined;
    case "pi":
      return modelOptions?.pi ? { pi: modelOptions.pi } : undefined;
    default:
      return undefined;
  }
}

/**
 * The provider snapshots a workflow slot picker lists: per driver, only the instance workflow
 * dispatch resolves a slot to (`workflowProviderSnapshot`), since slots store a driver kind.
 */
export function workflowPickerProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  const picked = new Set(
    KNOWN_PROVIDER_KINDS.flatMap((kind) => {
      const snapshot = workflowProviderSnapshot(kind, providers);
      return snapshot ? [snapshot] : [];
    }),
  );
  return providers.filter((provider) => picked.has(provider));
}

/** Driver-keyed picker options for workflow slots, read from the instance each slot runs on. */
export function workflowModelOptionsByProvider(
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelPickerModelOption>>,
  providers: ReadonlyArray<ServerProvider>,
): Record<ProviderKind, ReadonlyArray<ModelPickerModelOption>> {
  return mapProviderKinds((kind) => {
    const snapshot = workflowProviderSnapshot(kind, providers);
    return (snapshot && modelOptionsByInstance.get(snapshot.instanceId)) ?? [];
  });
}

type ModelOptionsByProvider = Record<
  ProviderKind,
  ReadonlyArray<{ readonly slug: string; readonly name: string }>
>;
type SlotDefaults = {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions | undefined;
};

export function getWorkflowSlotDefaults(
  slot: WorkflowCreatePreferenceSlot,
  fallbackProvider: ProviderKind,
  modelOptionsByProvider: ModelOptionsByProvider,
  providers: Parameters<typeof resolveComposerPickerModel>[0]["providers"],
): SlotDefaults {
  const preferences = getModelPreferences();
  return getWorkflowSlotDefaultsForProvider(
    preferences.lastWorkflowProviderBySlot[slot] ?? fallbackProvider,
    modelOptionsByProvider,
    providers,
  );
}

/** The remembered model and options for one provider, resolved against the picker options. */
export function getWorkflowSlotDefaultsForProvider(
  provider: ProviderKind,
  modelOptionsByProvider: ModelOptionsByProvider,
  providers: Parameters<typeof resolveComposerPickerModel>[0]["providers"],
): SlotDefaults {
  const preferences = getModelPreferences();
  const preferredModel = preferences.lastModelByProvider[provider] ?? getDefaultModel(provider);
  const model = resolveComposerPickerModel({
    provider,
    rawModel: preferredModel,
    pickerOptions: modelOptionsByProvider[provider],
    providers: providers ?? null,
  });
  return {
    provider,
    model,
    modelOptions:
      normalizeModelSlug(preferredModel, provider) === model
        ? getSingleProviderModelOptions(provider, preferences.lastModelOptions)
        : undefined,
  };
}

export function resolveSavedWorkflowSlot(
  saved: UpstreamReviewerSlot | null | undefined,
  modelOptionsByProvider: ModelOptionsByProvider,
  providers: ReadonlyArray<ServerProvider>,
): SlotDefaults | null {
  if (
    !saved ||
    !providers.some((provider) => provider.enabled && provider.driver === saved.provider)
  )
    return null;
  const model = resolveComposerPickerModel({
    provider: saved.provider,
    rawModel: saved.model,
    pickerOptions: modelOptionsByProvider[saved.provider],
    providers,
  });
  return {
    provider: saved.provider,
    model,
    modelOptions:
      normalizeModelSlug(saved.model, saved.provider) === model ? saved.modelOptions : undefined,
  };
}

export function makeWorkflowSlotBuilder(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Parameters<typeof resolveProviderOptionsForDispatch>[0]["settings"];
  readonly projectId: ProjectId;
  readonly dispatchModelsByProvider: Record<ProviderKind, ReadonlyArray<{ readonly slug: string }>>;
}) {
  const cache = new Map<ProviderKind, WorkflowModelSlot["providerOptions"]>();
  return (
    provider: ProviderKind,
    model: string,
    rawOptions: ProviderModelOptions | undefined,
  ): WorkflowModelSlot => {
    const modelOptions = normalizeWorkflowSlotModelOptions(
      provider,
      model,
      rawOptions,
      getWorkflowModelCapabilities(input.providers, ProviderDriverKind.make(provider), model),
    );
    if (!cache.has(provider))
      cache.set(
        provider,
        resolveProviderOptionsForDispatch({
          settings: input.settings,
          provider,
          projectId: input.projectId,
          availableModels: input.dispatchModelsByProvider[provider],
        }),
      );
    const providerOptions = cache.get(provider);
    return {
      provider,
      model,
      ...(modelOptions ? { modelOptions } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  };
}
