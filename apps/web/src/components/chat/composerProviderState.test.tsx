import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getComposerProviderState,
  withImplicitFastModeDefault,
  withComposerModelDefaults,
  getComposerReasoningStep,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";

// Everything in composerProviderState is now data-driven by the model's
// optionDescriptors, so these tests use a single synthetic provider/model and
// vary only the descriptor shape per scenario.

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const MODEL = "test-model";

it("defaults reasoning to High while retaining explicit choices and unsupported models", () => {
  const caps = {
    optionDescriptors: [
      selectDescriptor("effort", [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ]),
    ],
  };
  expect(withComposerModelDefaults(caps, undefined)).toEqual([{ id: "effort", value: "high" }]);
  expect(withComposerModelDefaults(caps, [{ id: "effort", value: "medium" }])).toEqual([
    { id: "effort", value: "medium" },
  ]);
  expect(withComposerModelDefaults({ optionDescriptors: [] }, undefined)).toBeUndefined();
});

it("defaults Fast to Normal only when the model supports it and no choice was saved", () => {
  const caps = {
    optionDescriptors: [
      { id: "fastMode", label: "Fast", type: "boolean" as const, currentValue: true },
    ],
  };
  expect(withImplicitFastModeDefault(caps, undefined)).toEqual([{ id: "fastMode", value: false }]);
  for (const value of [true, false]) {
    expect(withImplicitFastModeDefault(caps, [{ id: "fastMode", value }])).toEqual([
      { id: "fastMode", value },
    ]);
  }
  expect(withImplicitFastModeDefault({ optionDescriptors: [] }, undefined)).toBeUndefined();
});

it("dispatches High for a known model before its catalog capabilities arrive", () => {
  const state = getComposerProviderState({
    provider: PROVIDER,
    model: "gpt-6-luna",
    models: [],
    modelOptions: undefined,
  });
  expect(state.promptEffort).toBe("high");
  expect(state.modelOptionsForDispatch).toContainEqual({ id: "reasoningEffort", value: "high" });
  const saved = getComposerProviderState({
    provider: PROVIDER,
    model: "gpt-6-luna",
    models: [],
    modelOptions: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
  });
  expect(saved.modelOptionsForDispatch).toContainEqual({ id: "fastMode", value: true });
  expect(saved.promptEffort).toBe("low");
  const partial = getComposerProviderState({
    provider: PROVIDER,
    model: "gpt-6-luna",
    models: modelWith([booleanDescriptor("fastMode")]).map((model) => ({
      ...model,
      slug: "gpt-6-luna",
    })),
    modelOptions: [{ id: "fastMode", value: true }],
  });
  expect(partial.promptEffort).toBe("high");
  expect(partial.modelOptionsForDispatch).toContainEqual({ id: "fastMode", value: true });
});

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(id: string): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id, label: id, type: "boolean" };
}

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

const ULTRATHINK_FRAME_CLASSES = {
  composerFrameClassName: "ultrathink-frame",
  composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
  modelPickerIconClassName: "ultrathink-chroma",
} as const;

describe("getComposerProviderState", () => {
  it("returns descriptor defaults when no selections are provided", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "high",
      modelOptionsForDispatch: selections(["effort", "high"]),
    });
  });

  it("lets selections override defaults and propagates them through dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        booleanDescriptor("fastMode"),
      ]),
      modelOptions: selections(["effort", "low"], ["fastMode", true]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "low",
      modelOptionsForDispatch: selections(["effort", "low"], ["fastMode", true]),
    });
  });

  it("preserves selections that match defaults so deepMerge can overwrite prior state", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        booleanDescriptor("fastMode"),
      ]),
      modelOptions: selections(["effort", "high"], ["fastMode", false]),
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["fastMode", false]),
    );
  });

  it("drops selections for descriptors the model does not declare", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([booleanDescriptor("thinking")]),
      modelOptions: selections(["effort", "max"], ["thinking", false]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: selections(["thinking", false]),
    });
  });

  it("derives promptEffort from the first select descriptor and preserves all others for dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        selectDescriptor("contextWindow", [
          { id: "200k", label: "200k", isDefault: true },
          { id: "1m", label: "1M" },
        ]),
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
    });

    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["contextWindow", "200k"], ["agent", "plan"]),
    );
  });

  it("returns undefined dispatch options when the model declares no descriptors", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([]),
      modelOptions: selections(["anything", "value"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });

  it("adds ultrathink class names when an injected value is selected explicitly", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor(
          "effort",
          [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
      ]),
      modelOptions: selections(["effort", "ultrathink"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "ultrathink",
      modelOptionsForDispatch: selections(["effort", "ultrathink"]),
      ...ULTRATHINK_FRAME_CLASSES,
    });
  });

  it("does not add ultrathink class names when an injected value is not selected", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor(
          "effort",
          [
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
      ]),
      modelOptions: selections(["effort", "high"]),
    });

    expect(state).not.toHaveProperty("composerFrameClassName");
    expect(state).not.toHaveProperty("composerSurfaceClassName");
    expect(state).not.toHaveProperty("modelPickerIconClassName");
  });
});

describe("provider traits render guards", () => {
  it("returns null when no thread target is provided", () => {
    const models = modelWith([
      selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
    ]);
    const args = {
      provider: PROVIDER,
      model: MODEL,
      models,
      modelOptions: undefined,
    };

    expect(renderProviderTraitsPicker(args)).toBeNull();
    expect(renderProviderTraitsMenuContent(args)).toBeNull();
  });
});

describe("composer reasoning steps", () => {
  it("uses the Codex picker's fallback efforts without dropping other selections", () => {
    expect(
      getComposerReasoningStep({
        provider: PROVIDER,
        model: "gpt-5",
        models: [],
        modelOptions: selections(["reasoningEffort", "low"], ["fastMode", true]),
        direction: 1,
      }),
    ).toEqual(selections(["fastMode", true], ["reasoningEffort", "medium"]));
  });
  it("honors an explicit no-effort report", () => {
    expect(
      getComposerReasoningStep({
        provider: PROVIDER,
        model: MODEL,
        models: [
          {
            slug: MODEL,
            name: MODEL,
            isCustom: false,
            capabilities: { source: "reported", supportsEffort: false, optionDescriptors: [] },
          },
        ],
        modelOptions: selections(["reasoningEffort", "high"]),
        direction: 1,
      }),
    ).toBeNull();
  });
  it("steps only through a reported effort subset", () => {
    expect(
      getComposerReasoningStep({
        provider: PROVIDER,
        model: MODEL,
        models: [
          {
            slug: MODEL,
            name: MODEL,
            isCustom: false,
            capabilities: {
              source: "reported",
              optionDescriptors: [
                selectDescriptor("reasoningEffort", [
                  { id: "low", label: "Low", isDefault: true },
                  { id: "high", label: "High" },
                ]),
              ],
            },
          },
        ],
        modelOptions: selections(["reasoningEffort", "low"], ["fastMode", true]),
        direction: 1,
      }),
    ).toEqual(selections(["fastMode", true], ["reasoningEffort", "high"]));
  });
});
