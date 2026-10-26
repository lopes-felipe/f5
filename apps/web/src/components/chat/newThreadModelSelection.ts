import {
  isKnownProviderKind,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection, getDefaultModel } from "@t3tools/shared/model";

import type { UnifiedWebSettings } from "../../hooks/useSettings";
import type { ModelPreferencesState } from "../../modelPreferencesStore";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { resolveNewThreadPreferences } from "../../newThreadPreferences";
import { providerModelOptionsToSelections } from "../../providerModelOptions";
import type { Project } from "../../types";
import { getComposerProviderState } from "./composerProviderState";

/** Whether a provider instance can start a conversation now. */
export const isReadyProvider = (provider: ServerProvider) =>
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled";

/** A model picked in a model picker, with that model's default options. */
export function pickedModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: string,
): ModelSelection {
  return createModelSelection(
    instanceId,
    model,
    getComposerProviderState({
      provider: driver,
      model,
      models: providers.find((p) => p.instanceId === instanceId)?.models ?? [],
      modelOptions: undefined,
    }).modelOptionsForDispatch,
  );
}

/**
 * The model a new conversation starts with: the project or remembered default
 * while its provider is ready, otherwise the first ready provider's preferred model.
 */
export function resolveNewThreadModelSelection(input: {
  readonly project: Pick<Project, "id" | "defaultModelSelection" | "defaultModel"> | undefined;
  readonly settings: UnifiedWebSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly preferences: Pick<
    ModelPreferencesState,
    "lastProvider" | "lastModelByProvider" | "lastModelOptions"
  >;
}): ModelSelection {
  const preferences = resolveNewThreadPreferences(input.project, input.settings, input.preferences);
  const preferredProvider = input.providers.find(
    (p) => p.instanceId === (preferences.instanceId ?? preferences.provider),
  );
  const provider =
    preferredProvider && isReadyProvider(preferredProvider)
      ? preferredProvider
      : input.providers.find(isReadyProvider);
  const driver = provider && isKnownProviderKind(provider.driver) ? provider.driver : "codex";
  const keptPreference = provider === preferredProvider;
  const model =
    (provider
      ? resolveAppModelSelectionForInstance(
          provider.instanceId,
          input.settings,
          input.providers,
          keptPreference ? preferences.model : null,
        )
      : null) ?? getDefaultModel(driver);
  return createModelSelection(
    provider?.instanceId ?? ProviderInstanceId.make("codex"),
    model,
    getComposerProviderState({
      provider: ProviderDriverKind.make(driver),
      model,
      models: provider?.models ?? [],
      modelOptions: providerModelOptionsToSelections(
        driver,
        keptPreference ? preferences.options : undefined,
      ),
    }).modelOptionsForDispatch,
  );
}
