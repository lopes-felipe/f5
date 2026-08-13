import type { ProviderModelOptions, ProviderStartOptions } from "@t3tools/contracts";

import type { SharedInstructionInput } from "./sharedAssistantContract.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

export type PersistedStartConfigValue<T> =
  | { readonly state: "absent" }
  | { readonly state: "cleared" }
  | { readonly state: "value"; readonly value: T };

export interface PersistedStartConfig {
  readonly providerOptions: PersistedStartConfigValue<ProviderStartOptions>;
  readonly modelOptions: PersistedStartConfigValue<ProviderModelOptions>;
  readonly model: PersistedStartConfigValue<string>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeProviderOptionsForPersistence(
  providerOptions: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(providerOptions)) {
    return undefined;
  }

  const { mcpServers: _discardedMcpServers, ...rest } = providerOptions;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ProviderStartOptions | undefined {
  const config = readPersistedStartConfig(runtimePayload).providerOptions;
  return config.state === "value" ? config.value : undefined;
}

export function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readPersistedInstructionContext(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Partial<SharedInstructionInput> | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const raw =
    "instructionContext" in runtimePayload ? runtimePayload.instructionContext : undefined;
  return isRecord(raw) ? (raw as Partial<SharedInstructionInput>) : undefined;
}

export function readPersistedRuntimePayloadRecord(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Record<string, unknown> | undefined {
  return isRecord(runtimePayload) ? runtimePayload : undefined;
}

function readObjectDimension<T extends Record<string, unknown>>(
  record: Record<string, unknown> | undefined,
  key: string,
): PersistedStartConfigValue<T> {
  if (!record || !(key in record)) {
    return { state: "absent" };
  }
  const value = record[key];
  if (value === null) {
    return { state: "cleared" };
  }
  return isRecord(value) ? { state: "value", value: value as T } : { state: "absent" };
}

function readStringDimension(
  record: Record<string, unknown> | undefined,
  key: string,
): PersistedStartConfigValue<string> {
  if (!record || !(key in record)) {
    return { state: "absent" };
  }
  const value = record[key];
  if (value === null) {
    return { state: "cleared" };
  }
  if (typeof value !== "string") {
    return { state: "absent" };
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? { state: "value", value: trimmed } : { state: "cleared" };
}

export function readPersistedStartConfig(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): PersistedStartConfig {
  const payload = isRecord(runtimePayload) ? runtimePayload : undefined;
  const nested = payload && isRecord(payload.startConfig) ? payload.startConfig : undefined;

  const providerOptions = readObjectDimension<ProviderStartOptions>(nested, "providerOptions");
  const modelOptions = readObjectDimension<ProviderModelOptions>(nested, "modelOptions");
  const model = readStringDimension(nested, "model");

  return {
    providerOptions:
      providerOptions.state !== "absent"
        ? providerOptions
        : readObjectDimension<ProviderStartOptions>(payload, "providerOptions"),
    modelOptions,
    model: model.state !== "absent" ? model : readStringDimension(payload, "model"),
  };
}

export function startConfigValueOrUndefined<T>(value: PersistedStartConfigValue<T>): T | undefined {
  return value.state === "value" ? value.value : undefined;
}

export function persistedStartConfigToRecord(
  config: PersistedStartConfig,
): Record<string, unknown> {
  return {
    ...(config.providerOptions.state === "value"
      ? { providerOptions: config.providerOptions.value }
      : config.providerOptions.state === "cleared"
        ? { providerOptions: null }
        : {}),
    ...(config.modelOptions.state === "value"
      ? { modelOptions: config.modelOptions.value }
      : config.modelOptions.state === "cleared"
        ? { modelOptions: null }
        : {}),
    ...(config.model.state === "value"
      ? { model: config.model.value }
      : config.model.state === "cleared"
        ? { model: null }
        : {}),
  };
}
