import type { ProviderModelOptions, ProviderStartOptions } from "@t3tools/contracts";

import type { PersistedStartConfig, PersistedStartConfigValue } from "./runtimePayload.ts";

export type StartConfigSource = "command" | "memory" | "persisted" | "none";

export interface EffectiveStartConfig {
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly modelOptions: ProviderModelOptions | undefined;
  readonly model: string | undefined;
  readonly providerOptionsSource: StartConfigSource;
  readonly modelOptionsSource: StartConfigSource;
  readonly modelSource: StartConfigSource;
}

interface StartConfigCandidate {
  readonly providerOptions?: ProviderStartOptions | undefined;
  readonly modelOptions?: ProviderModelOptions | undefined;
  readonly model?: string | undefined;
}

function resolveDimension<T>(input: {
  readonly command: StartConfigCandidate;
  readonly memory: StartConfigCandidate;
  readonly persisted: PersistedStartConfigValue<T>;
  readonly key: keyof StartConfigCandidate;
}): { readonly value: T | undefined; readonly source: StartConfigSource } {
  if (Object.hasOwn(input.command, input.key)) {
    return { value: input.command[input.key] as T | undefined, source: "command" };
  }
  if (Object.hasOwn(input.memory, input.key)) {
    return { value: input.memory[input.key] as T | undefined, source: "memory" };
  }
  if (input.persisted.state !== "absent") {
    return {
      value: input.persisted.state === "value" ? input.persisted.value : undefined,
      source: "persisted",
    };
  }
  return { value: undefined, source: "none" };
}

export function resolveEffectiveStartConfig(input: {
  readonly command?: StartConfigCandidate;
  readonly memory?: StartConfigCandidate;
  readonly persisted?: PersistedStartConfig;
}): EffectiveStartConfig {
  const command = input.command ?? {};
  const memory = input.memory ?? {};
  const absent = { state: "absent" } as const;
  const providerOptions = resolveDimension<ProviderStartOptions>({
    command,
    memory,
    persisted: input.persisted?.providerOptions ?? absent,
    key: "providerOptions",
  });
  const modelOptions = resolveDimension<ProviderModelOptions>({
    command,
    memory,
    persisted: input.persisted?.modelOptions ?? absent,
    key: "modelOptions",
  });
  const model = resolveDimension<string>({
    command,
    memory,
    persisted: input.persisted?.model ?? absent,
    key: "model",
  });

  return {
    providerOptions: providerOptions.value,
    modelOptions: modelOptions.value,
    model: model.value,
    providerOptionsSource: providerOptions.source,
    modelOptionsSource: modelOptions.source,
    modelSource: model.source,
  };
}
