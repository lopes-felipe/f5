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

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
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
    if (typeof currentServerPassword !== "string" || currentServerPassword.length === 0) {
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
        },
      },
    };
  }

  return providerInstances === preserved.providerInstances
    ? preserved
    : { ...preserved, providerInstances };
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = deepMerge(current, patch);
  const nextWithReplacements =
    patch.providerInstances !== undefined
      ? {
          ...next,
          providerInstances: patch.providerInstances,
        }
      : next;
  const nextWithSecrets = preserveRedactedProviderSecrets(current, nextWithReplacements, patch);
  if (!selectionPatch) {
    return nextWithSecrets;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithSecrets,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
