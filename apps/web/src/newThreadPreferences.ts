import { resolveProjectProviderInstanceEnabled } from "@t3tools/shared/serverSettings";
import { inferProviderForModel } from "@t3tools/shared/model";
import {
  isKnownProviderKind,
  type ServerSettings,
  type ProviderKind,
  ProviderInstanceId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderModelOptions,
} from "@t3tools/contracts";
import { providerSelectionsToModelOptions } from "./providerModelOptions";
import type { Project } from "./types";
import type { ModelPreferencesState } from "./modelPreferencesStore";
/** Shared project/remembered defaults for new conversations and scheduled conversations. */
export function resolveNewThreadPreferences(
  project: Pick<Project, "id" | "defaultModelSelection" | "defaultModel"> | undefined,
  settings: ServerSettings,
  preferences: Pick<
    ModelPreferencesState,
    "lastProvider" | "lastModelByProvider" | "lastModelOptions"
  >,
): {
  provider?: ProviderKind;
  instanceId?: ProviderInstanceId;
  model?: string;
  options?: ProviderModelOptions | null;
} {
  const enabled = (id: ProviderInstanceId) =>
    resolveProjectProviderInstanceEnabled(settings, project?.id, id);
  let needsFallback = !enabled(ProviderInstanceId.make("codex"));
  if (project?.defaultModelSelection && enabled(project.defaultModelSelection.instanceId)) {
    const selection = project.defaultModelSelection;
    const driver = settings.providerInstances[selection.instanceId]?.driver ?? selection.instanceId;
    const provider = isKnownProviderKind(driver)
      ? driver
      : inferProviderForModel(selection.model, "codex");
    return {
      provider,
      instanceId: selection.instanceId,
      model: selection.model,
      options: providerSelectionsToModelOptions(provider, selection.options),
    };
  }
  if (project?.defaultModelSelection) needsFallback = true;
  if (project?.defaultModel) {
    const provider = inferProviderForModel(project.defaultModel, "codex");
    if (enabled(ProviderInstanceId.make(provider)))
      return { provider, model: project.defaultModel };
    needsFallback = true;
  }
  if (preferences.lastProvider && enabled(ProviderInstanceId.make(preferences.lastProvider)))
    return {
      provider: preferences.lastProvider,
      ...(preferences.lastModelByProvider[preferences.lastProvider]
        ? { model: preferences.lastModelByProvider[preferences.lastProvider]! }
        : {}),
      ...(preferences.lastModelOptions ? { options: preferences.lastModelOptions } : {}),
    };
  if (preferences.lastProvider) needsFallback = true;
  if (!needsFallback)
    return preferences.lastModelOptions ? { options: preferences.lastModelOptions } : {};
  const fallback = [...Object.keys(settings.providers), ...Object.keys(settings.providerInstances)]
    .map((id) => ProviderInstanceId.make(id))
    .find((id) => enabled(id) && isKnownProviderKind(settings.providerInstances[id]?.driver ?? id));
  if (!fallback) return {};
  const driver = settings.providerInstances[fallback]?.driver ?? fallback;
  if (!isKnownProviderKind(driver)) return {};
  return {
    provider: driver,
    instanceId: fallback,
    model: DEFAULT_MODEL_BY_PROVIDER[driver as ProviderKind],
    options: null,
  };
}
