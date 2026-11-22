import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { traitsTriggerParts } from "./traitsTrigger";

const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
  currentValue: "high",
};
const defaults: ReadonlyArray<ProviderOptionDescriptor> = [
  effort,
  { id: "fastMode", label: "Fast Mode", type: "boolean" },
  { id: "ultracode", label: "Ultracode", type: "boolean" },
  { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
];

function withValues(values: Record<string, boolean>): ReadonlyArray<ProviderOptionDescriptor> {
  return defaults.map((descriptor) =>
    descriptor.type === "boolean" && descriptor.id in values
      ? { ...descriptor, currentValue: values[descriptor.id]! }
      : descriptor,
  );
}

describe("traitsTriggerParts", () => {
  it("omits booleans that are at their default", () => {
    expect(
      traitsTriggerParts({
        descriptors: withValues({ fastMode: false, ultracode: false, thinking: true }),
        defaults,
      }),
    ).toEqual({ label: "High", icons: [] });
  });

  it("draws Fast mode and Ultracode as icons when on", () => {
    expect(
      traitsTriggerParts({
        descriptors: withValues({ fastMode: true, ultracode: true }),
        defaults,
      }),
    ).toEqual({ label: "High", icons: ["fastMode", "ultracode"] });
  });

  it("names a text boolean that moved off its default", () => {
    expect(traitsTriggerParts({ descriptors: withValues({ thinking: false }), defaults })).toEqual({
      label: "High · Thinking Off",
      icons: [],
    });
  });

  it("still names a lone boolean control so the chip is never blank", () => {
    const thinkingOnly: ReadonlyArray<ProviderOptionDescriptor> = [
      { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
    ];
    expect(traitsTriggerParts({ descriptors: thinkingOnly, defaults: thinkingOnly })).toEqual({
      label: "Thinking On",
      icons: [],
    });
  });
});
