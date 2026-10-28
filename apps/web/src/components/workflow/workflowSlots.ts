import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ProjectId,
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
import { resolveComposerPickerModel } from "../ChatView.logic";

export function normalizeWorkflowSlotModelOptions(
  provider: ProviderKind,
  model: string,
  modelOptions: ProviderModelOptions | undefined,
  capabilities?: ModelCapabilities | null,
): ProviderModelOptions | undefined {
  if (provider === "codex") {
    const codex = resolveCodexDispatchModelOptions(model, modelOptions?.codex, capabilities);
    return codex ? { codex } : undefined;
  }
  if (provider === "claudeAgent") {
    const claudeAgent = normalizeClaudeModelOptions(model, modelOptions?.claudeAgent, capabilities);
    return claudeAgent ? { claudeAgent } : undefined;
  }
  return getSingleProviderModelOptions(provider, modelOptions);
}

export function getSingleProviderModelOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | undefined {
  switch (provider) {
    case "codex":
      return modelOptions?.codex ? { codex: modelOptions.codex } : undefined;
    case "claudeAgent":
      return modelOptions?.claudeAgent ? { claudeAgent: modelOptions.claudeAgent } : undefined;
    case "cursor":
      return modelOptions?.cursor ? { cursor: modelOptions.cursor } : undefined;
    case "opencode":
      return modelOptions?.opencode ? { opencode: modelOptions.opencode } : undefined;
    case "grok":
      return undefined;
  }
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
  const provider = preferences.lastWorkflowProviderBySlot[slot] ?? fallbackProvider;
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
