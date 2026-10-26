import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isKnownProviderKind,
  ProviderInstanceId,
  type ProviderKind,
  type ProjectId,
  type ServerProvider,
  type ModelSelection,
} from "@t3tools/contracts";
import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import { Schema } from "effect";
import { deepMerge } from "./Struct";
import { fromLenientJson } from "./schemaJson";
import { createModelSelection } from "./model";

const ServerSettingsJson = fromLenientJson(ServerSettings);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  try {
    const decoded = Schema.decodeUnknownSync(ServerSettingsJson)(raw);
    return extractPersistedServerObservabilitySettings(decoded);
  } catch {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

/** A project can enable or disable an installed instance without changing other projects. */
export function resolveProjectProviderInstanceEnabled(
  settings: Pick<ServerSettings, "providers" | "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null | undefined,
  instanceId: ProviderInstanceId,
): boolean {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  if (
    !instance &&
    (!isKnownProviderKind(instanceId) || !Object.hasOwn(settings.providers, instanceId))
  )
    return false;
  const override =
    projectId && Object.hasOwn(settings.projectSettingsOverrides, projectId)
      ? settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled
      : undefined;
  if (override !== undefined) return override;
  if (instance) {
    const config = instance.config;
    const configured =
      config &&
      typeof config === "object" &&
      "enabled" in config &&
      typeof config.enabled === "boolean"
        ? config.enabled
        : undefined;
    return instance.enabled ?? configured ?? true;
  }
  return settings.providers[instanceId as keyof typeof settings.providers]?.enabled ?? false;
}

/** Retains readiness/catalog information while projecting the chosen scope's enablement. */
export function projectProviderSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<ServerSettings, "providers" | "providerInstances" | "projectSettingsOverrides">,
  projectId?: ProjectId | null,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => {
    const enabled = resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId);
    return enabled === provider.enabled ? provider : { ...provider, enabled };
  });
}

function shouldReplaceModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection" | "sessionNotesModelSelection"],
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preserveRedactedProviderSecrets(
  current: ServerSettings,
  next: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  let preserved = next;
  if (
    patch.providers?.opencode?.serverPassword === "" &&
    current.providers.opencode.serverPassword.length > 0
  ) {
    preserved = {
      ...preserved,
      providers: {
        ...preserved.providers,
        opencode: {
          ...preserved.providers.opencode,
          serverPassword: current.providers.opencode.serverPassword,
        },
      },
    };
  }

  if (patch.providerInstances === undefined) {
    return preserved;
  }

  let providerInstances = preserved.providerInstances;
  for (const [instanceId, patchInstance] of Object.entries(patch.providerInstances)) {
    const providerInstanceId = instanceId as keyof ServerSettings["providerInstances"];
    if (patchInstance.driver !== "opencode" || !isRecord(patchInstance.config)) {
      continue;
    }
    if (patchInstance.config.serverPassword !== "") {
      continue;
    }
    const currentInstance = current.providerInstances[providerInstanceId];
    if (!isRecord(currentInstance?.config)) {
      continue;
    }
    const currentServerPassword = currentInstance.config.serverPassword;
    if (
      typeof currentServerPassword !== "string" ||
      (currentServerPassword.length === 0 && currentInstance.config.serverPasswordRedacted !== true)
    ) {
      continue;
    }
    const nextInstance = providerInstances[providerInstanceId];
    if (!nextInstance || !isRecord(nextInstance.config)) {
      continue;
    }
    providerInstances = {
      ...providerInstances,
      [providerInstanceId]: {
        ...nextInstance,
        config: {
          ...nextInstance.config,
          serverPassword: currentServerPassword,
          ...(currentInstance.config.serverPasswordRedacted === true
            ? { serverPasswordRedacted: true }
            : {}),
        },
      },
    };
  }

  return providerInstances === preserved.providerInstances
    ? preserved
    : { ...preserved, providerInstances };
}

/**
 * Applies a server settings patch while treating model selections as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const { projectSettingsOverrides: overridePatch, ...rest } = patch;
  let overrides = { ...current.projectSettingsOverrides };
  for (const [id, value] of Object.entries(overridePatch ?? {})) {
    if (value === null) delete overrides[id as keyof typeof overrides];
    else {
      const previous = overrides[id as keyof typeof overrides];
      // Other project controls send partial values. Only an explicit map (including
      // an empty map) replaces the provider policy; a whole-project null resets it.
      const providerInstances = value.providerInstances ?? previous?.providerInstances;
      overrides = {
        ...overrides,
        [id]: {
          ...value,
          ...(providerInstances === undefined ? {} : { providerInstances }),
        },
      };
    }
  }
  const next = { ...deepMerge(current, rest), projectSettingsOverrides: overrides };
  const nextWithInstances =
    patch.providerInstances !== undefined
      ? {
          ...next,
          providerInstances: patch.providerInstances,
        }
      : next;
  // A cleanup policy is a tagged union: switching modes must not merge fields.
  const nextWithReplacements =
    patch.worktreeCleanup !== undefined
      ? { ...nextWithInstances, worktreeCleanup: patch.worktreeCleanup }
      : nextWithInstances;
  // Upstream schedule fields merge; nullable model selections replace, not merge.
  const upstreamPatch = patch.upstreamPorts;
  const nextWithUpstream =
    upstreamPatch !== undefined
      ? {
          ...nextWithReplacements,
          upstreamPorts: {
            ...current.upstreamPorts,
            ...upstreamPatch,
            schedule: { ...current.upstreamPorts.schedule, ...upstreamPatch.schedule },
          },
        }
      : nextWithReplacements;
  const nextWithSecrets = preserveRedactedProviderSecrets(current, nextWithUpstream, patch);
  let result = nextWithSecrets;
  for (const key of ["textGenerationModelSelection", "sessionNotesModelSelection"] as const) {
    const selectionPatch = patch[key];
    if (!selectionPatch) continue;
    const instanceId = selectionPatch.instanceId ?? current[key].instanceId;
    const model = selectionPatch.model ?? current[key].model;
    const options = shouldReplaceModelSelection(selectionPatch)
      ? selectionPatch.options
      : mergeModelSelectionOptionsById({
          current: current[key].options,
          patch: selectionPatch.options,
        });
    result = { ...result, [key]: createModelSelection(instanceId, model, options) };
  }
  return result;
}

/**
 * Ensure the `textGenerationModelSelection` points to an enabled provider.
 * If the selected provider is disabled, fall back to the first enabled
 * provider with its default model.  This is applied at read-time so the
 * persisted preference is preserved for when a provider is re-enabled.
 */
export function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return resolveProjectProviderInstanceEnabled(
    settings,
    null,
    settings.textGenerationModelSelection.instanceId,
  )
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const candidates = [
    ...Object.keys(settings.providers),
    ...Object.keys(settings.providerInstances),
  ];
  const fallback = candidates.find((id) => {
    const instanceId = ProviderInstanceId.make(id);
    const driver = settings.providerInstances[instanceId]?.driver ?? id;
    return (
      isKnownProviderKind(driver) &&
      resolveProjectProviderInstanceEnabled(settings, null, instanceId)
    );
  });
  if (!fallback) return settings;
  const instanceId = ProviderInstanceId.make(fallback);
  const driver = settings.providerInstances[instanceId]?.driver ?? fallback;
  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId,
      model:
        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver as ProviderKind] ??
        DEFAULT_GIT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}
