import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { getDefaultModel } from "@t3tools/shared/model";
import { runtimeModeCapabilities } from "@t3tools/shared/runtimeMode";

import type { PromptStashDraftSelection, PromptStashEntry } from "~/composerDraftStore";

export interface ResolvedPromptStashSelection {
  readonly selection: PromptStashDraftSelection;
  readonly warnings: string[];
}

function providerIsAvailable(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && provider.availability !== "unavailable";
}

export function resolvePromptStashSelection(input: {
  readonly stash: PromptStashEntry;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelSlugsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlySet<string>>;
  readonly fallback: PromptStashDraftSelection;
}): ResolvedPromptStashSelection {
  const warnings: string[] = [];
  const availableProviders = input.providers.filter(providerIsAvailable);
  const requestedProvider = input.stash.draft.provider;
  const requestedInstanceId = input.stash.draft.providerInstanceId;
  const exactProvider = availableProviders.find(
    (provider) =>
      provider.instanceId === requestedInstanceId &&
      (requestedProvider === null || provider.driver === requestedProvider),
  );
  const sameDriverProvider = requestedProvider
    ? availableProviders.find((provider) => provider.driver === requestedProvider)
    : undefined;
  const fallbackProvider =
    availableProviders.find(
      (provider) => provider.instanceId === input.fallback.providerInstanceId,
    ) ??
    availableProviders.find((provider) => provider.driver === input.fallback.provider) ??
    availableProviders[0];
  const resolvedProvider = exactProvider ?? sameDriverProvider ?? fallbackProvider;

  if (!resolvedProvider) {
    warnings.push("The saved provider is unavailable; the current provider selection was kept.");
    return { selection: input.fallback, warnings };
  }

  const provider = resolvedProvider.driver as ProviderKind;
  const providerInstanceId = resolvedProvider.instanceId;
  const exactInstanceRetained = exactProvider === resolvedProvider;
  if (requestedProvider !== null && !exactInstanceRetained) {
    warnings.push(
      sameDriverProvider
        ? "The saved provider instance is unavailable; another instance of the same provider was selected."
        : "The saved provider is unavailable; the current provider selection was used.",
    );
  }

  const availableModelSlugs = new Set(resolvedProvider.models.map((model) => model.slug));
  for (const slug of input.modelSlugsByInstance.get(providerInstanceId) ?? []) {
    availableModelSlugs.add(slug);
  }
  const requestedModel = input.stash.draft.model;
  const fallbackModel =
    input.fallback.providerInstanceId === providerInstanceId ? input.fallback.model : null;
  const model =
    (requestedModel && availableModelSlugs.has(requestedModel) ? requestedModel : null) ??
    (fallbackModel && availableModelSlugs.has(fallbackModel) ? fallbackModel : null) ??
    resolvedProvider.models[0]?.slug ??
    getDefaultModel(provider);
  const exactModelRetained = requestedModel === null || model === requestedModel;
  if (requestedModel !== null && !exactModelRetained) {
    warnings.push(`The saved model "${requestedModel}" is unavailable; "${model}" was selected.`);
  }

  const requestedRuntimeMode = input.stash.draft.runtimeMode;
  const supportedRuntimeModes = runtimeModeCapabilities(provider);
  const runtimeMode =
    (requestedRuntimeMode && supportedRuntimeModes.has(requestedRuntimeMode)
      ? requestedRuntimeMode
      : null) ??
    (input.fallback.runtimeMode && supportedRuntimeModes.has(input.fallback.runtimeMode)
      ? input.fallback.runtimeMode
      : null) ??
    supportedRuntimeModes.values().next().value ??
    null;
  if (requestedRuntimeMode !== null && runtimeMode !== requestedRuntimeMode) {
    warnings.push("The saved access mode is unsupported by the selected provider and was reset.");
  }

  const canRestoreProviderOptions = exactInstanceRetained && exactModelRetained;
  return {
    selection: {
      provider,
      providerInstanceId,
      model,
      modelOptions: canRestoreProviderOptions ? input.stash.draft.modelOptions : null,
      runtimeMode,
      interactionMode:
        resolvedProvider.showInteractionModeToggle === false
          ? input.fallback.interactionMode
          : input.stash.draft.interactionMode,
      effort:
        provider === "codex" && canRestoreProviderOptions
          ? input.stash.draft.effort
          : input.fallback.effort,
      codexFastMode:
        provider === "codex" && canRestoreProviderOptions
          ? input.stash.draft.codexFastMode
          : input.fallback.codexFastMode,
    },
    warnings,
  };
}
