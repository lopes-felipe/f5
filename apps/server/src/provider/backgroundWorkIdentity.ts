import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";
import { readPersistedSessionGeneration } from "./sessionCapabilities.ts";

/** Fence persisted background work to the exact session generation, including equal launch configs. */
export function backgroundWorkSessionIdentity(binding: ProviderRuntimeBinding): string {
  return JSON.stringify([
    binding.provider,
    binding.providerInstanceId ?? "default",
    binding.adapterKey ?? binding.provider,
    binding.launchFingerprint ?? "default",
    readPersistedSessionGeneration(binding.runtimePayload),
  ]);
}
