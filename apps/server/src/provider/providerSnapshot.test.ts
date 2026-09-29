import { describe, expect, it } from "vitest";
import { ProviderDriverKind, type ModelCapabilities } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { providerModelsFromSettings, parseGenericCliVersion } from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ProviderDriverKind.make("opencode"),
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });
});

describe("parseGenericCliVersion", () => {
  it.each([
    ["opencode v2.0.3", "2.0.3"],
    ["v0.153.0", "0.153.0"],
    ["claude 2.1.280", "2.1.280"],
    ["no version", null],
  ])("parses %s", (input, expected) => expect(parseGenericCliVersion(input!)).toBe(expected));
});

it("publishes custom display names and explicit capabilities without changing the model slug", () => {
  expect(
    providerModelsFromSettings(
      [],
      "codex",
      [{ slug: "private/model", name: "Reviewer", capabilities: { optionDescriptors: [] } }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    ),
  ).toEqual([
    {
      slug: "private/model",
      name: "Reviewer",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    },
  ]);
  expect(
    providerModelsFromSettings(
      [{ slug: "builtin", name: "Official", isCustom: false, capabilities: null }],
      "codex",
      [{ slug: "builtin", name: "Override" }],
      {},
    ),
  ).toEqual([{ slug: "builtin", name: "Official", isCustom: false, capabilities: null }]);
});
