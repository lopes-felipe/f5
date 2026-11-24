import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";

/** Booleans the trigger draws as an icon instead of text. */
export const ICON_TRIGGER_BOOLEANS = new Set(["fastMode", "ultracode"]);

export interface TraitsTriggerParts {
  /** Select labels plus any text-only boolean that differs from its default. */
  readonly label: string;
  /** Icon booleans that are switched on, in descriptor order. */
  readonly icons: ReadonlyArray<"fastMode" | "ultracode">;
}

/**
 * The composer chip says only what differs from the model's defaults: select
 * values always, a boolean only when changed. Fast mode and Ultracode become
 * icons; other booleans become short text such as "Thinking Off". A model
 * whose only control is a boolean still names it, so the chip is never blank.
 */
export function traitsTriggerParts(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly defaults: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
}): TraitsTriggerParts {
  const labels: string[] = [];
  const icons: Array<"fastMode" | "ultracode"> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.type !== "boolean") {
      const label = getProviderOptionCurrentLabel(descriptor);
      if (label) labels.push(label);
      continue;
    }
    const enabled = descriptor.currentValue === true;
    if (ICON_TRIGGER_BOOLEANS.has(descriptor.id)) {
      if (enabled) icons.push(descriptor.id as "fastMode" | "ultracode");
      continue;
    }
    const fallback = input.defaults?.find((entry) => entry.id === descriptor.id);
    const defaultValue = fallback?.type === "boolean" ? fallback.currentValue === true : false;
    if (enabled !== defaultValue) labels.push(`${descriptor.label} ${enabled ? "On" : "Off"}`);
  }
  if (labels.length === 0 && icons.length === 0) {
    const first = input.descriptors.find(
      (descriptor) => descriptor.type === "boolean" && !ICON_TRIGGER_BOOLEANS.has(descriptor.id),
    );
    if (first)
      labels.push(
        `${first.label} ${first.type === "boolean" && first.currentValue ? "On" : "Off"}`,
      );
  }
  return { label: labels.join(" · "), icons };
}
