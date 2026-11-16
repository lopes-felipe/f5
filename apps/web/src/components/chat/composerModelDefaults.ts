import type { ModelCapabilities, ProviderOptionSelection } from "@t3tools/contracts";
import { findEffortSelectDescriptor } from "./effortLevels";

export function defaultComposerEffort(options: ReadonlyArray<string>): "high" | undefined {
  return options.includes("high") ? "high" : undefined;
}

export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (
    options?.some((option) => option.id === "fastMode") ||
    !caps.optionDescriptors?.some(
      (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
    )
  ) {
    return options ?? undefined;
  }
  return [...(options ?? []), { id: "fastMode", value: false }];
}

/** The composer and dispatch share defaults; explicit user selections always win. */
export function withComposerModelDefaults(
  caps: ModelCapabilities,
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  let result = withImplicitFastModeDefault(caps, options);
  const descriptor = findEffortSelectDescriptor(caps.optionDescriptors ?? []);
  const effort = defaultComposerEffort(descriptor?.options.map((option) => option.id) ?? []);
  if (descriptor && effort && !result?.some((option) => option.id === descriptor.id)) {
    result = [...(result ?? []), { id: descriptor.id, value: effort }];
  }
  return result;
}
