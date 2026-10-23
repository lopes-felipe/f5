import { stepEffortOptions } from "./effortLevels";
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
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    promptEffort !== null && primarySelectDescriptor?.promptInjectedValues?.includes(promptEffort);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
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
  const reported = getProviderModelCapabilities(input.models, input.model, input.provider);
  let descriptors = getProviderOptionDescriptors({
    caps: reported,
    selections: input.modelOptions,
  });
  if (input.provider === "codex") {
    const caps = resolveModelCapabilities("codex", input.model, reported);
    const current = resolveCodexEffectiveReasoningEffort(
      input.model,
      getProviderOptionStringSelectionValue(input.modelOptions, "reasoningEffort"),
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
  const next = stepEffortOptions(descriptors, input.direction);
  if (!next) return null;
  const updatedIds = new Set(next.map((entry) => entry.id));
  return [...(input.modelOptions ?? []).filter((entry) => !updatedIds.has(entry.id)), ...next];
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
  presentation: { tintTrigger?: boolean } = {},
): ReactNode {
  const { provider, threadRef, draftId, model, models, modelOptions } = input;
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
