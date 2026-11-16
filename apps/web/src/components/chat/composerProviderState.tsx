import { findEffortSelectDescriptor, stepEffortOptions } from "./effortLevels";
import {
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getProviderOptionStringSelectionValue,
  resolveCodexEffectiveReasoningEffort,
  resolveModelCapabilities,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import { defaultComposerEffort, withComposerModelDefaults } from "./composerModelDefaults";
export { withImplicitFastModeDefault, withComposerModelDefaults } from "./composerModelDefaults";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const reportedDescriptors = getProviderOptionDescriptors({
    caps,
    selections: withComposerModelDefaults(caps, modelOptions),
  });
  const descriptors =
    !findEffortSelectDescriptor(reportedDescriptors) &&
    provider === "codex" &&
    resolveModelCapabilities("codex", model).source === "built-in"
      ? getComposerEffortDescriptors(input)
      : reportedDescriptors;
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const dispatchOptions = buildProviderOptionSelectionsFromDescriptors(descriptors);
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  const modelOptionsForDispatch =
    reportedDescriptors.length === 0 && dispatchOptions
      ? [
          ...(modelOptions ?? []).filter((option) => !descriptorIds.has(option.id)),
          ...dispatchOptions,
        ]
      : dispatchOptions;
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    promptEffort !== null && primarySelectDescriptor?.promptInjectedValues?.includes(promptEffort);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch,
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

/** Keyboard changes use the same reported/fallback Codex effort policy as its picker. */
export function getComposerReasoningStep(
  input: ComposerProviderStateInput & { direction: 1 | -1 },
) {
  const next = stepEffortOptions(getComposerEffortDescriptors(input), input.direction);
  if (!next) return null;
  const updatedIds = new Set(next.map((entry) => entry.id));
  return [...(input.modelOptions ?? []).filter((entry) => !updatedIds.has(entry.id)), ...next];
}

/**
 * Option descriptors as the effort controls see them; Codex's effort comes from
 * the same reported/fallback policy as its picker.
 */
export function getComposerEffortDescriptors(
  input: ComposerProviderStateInput,
): ReadonlyArray<ProviderOptionDescriptor> {
  const reported = getProviderModelCapabilities(input.models, input.model, input.provider);
  const modelOptions = withComposerModelDefaults(reported, input.modelOptions);
  let descriptors = getProviderOptionDescriptors({
    caps: reported,
    selections: modelOptions,
  });
  if (input.provider === "codex") {
    const caps = resolveModelCapabilities("codex", input.model, reported);
    const current = resolveCodexEffectiveReasoningEffort(
      input.model,
      getProviderOptionStringSelectionValue(modelOptions, "reasoningEffort") ??
        defaultComposerEffort(caps.effortOptions),
      reported,
    );
    const effort: ProviderOptionDescriptor[] = caps.effortOptions.length
      ? [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: caps.effortOptions.map((id) => ({
              id,
              label: id,
              isDefault: id === caps.defaultEffort,
            })),
            ...(current ? { currentValue: current } : {}),
          },
        ]
      : [];
    descriptors = [...descriptors.filter((entry) => entry.id !== "reasoningEffort"), ...effort];
  }
  return descriptors;
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
  presentation: { tintTrigger?: boolean } = {},
): ReactNode {
  const { provider, threadRef, draftId, model, models } = input;
  const modelOptions = withComposerModelDefaults(
    getProviderModelCapabilities(models, model, provider),
    input.modelOptions,
  );
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (!hasTarget || !shouldRenderTraitsControls({ provider, models, model, modelOptions })) {
    return null;
  }
  return (
    <Component
      provider={provider}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      {...presentation}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input, { tintTrigger: true });
}
