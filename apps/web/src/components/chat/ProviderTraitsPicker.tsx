import {
  ProviderDriverKind,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveModelCapabilities } from "@t3tools/shared/model";

import {
  providerModelOptionsToSelections,
  providerSelectionsToModelOptions,
} from "../../providerModelOptions";
import { getProviderModelCapabilities } from "../../providerModels";
import { ClaudeTraitsPicker, supportsClaudeTraitsControls } from "./ClaudeTraitsPicker";
import { CodexTraitsPicker } from "./CodexTraitsPicker";
import { shouldRenderTraitsControls, TraitsPicker, type TraitsHiddenOptions } from "./TraitsPicker";

interface ProviderTraitsInput {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelOptions: ProviderModelOptions | undefined;
  /** Descriptor traits to leave out (Claude and descriptor-driven providers). */
  readonly hiddenOptions?: TraitsHiddenOptions | undefined;
}

/**
 * Whether the composer's traits control for this provider has anything to show. Codex
 * counts its F5 fallback efforts and Fast Mode, as its composer control does.
 */
export function hasProviderTraitsControls(input: ProviderTraitsInput): boolean {
  const driver = ProviderDriverKind.make(input.provider);
  if (input.provider === "codex") {
    const capabilities = resolveModelCapabilities(
      "codex",
      input.model,
      getProviderModelCapabilities(input.models, input.model, driver),
    );
    return capabilities.effortOptions.length > 0 || capabilities.supportsFastMode;
  }
  const selections = providerModelOptionsToSelections(input.provider, input.modelOptions);
  if (input.provider === "claudeAgent") {
    return supportsClaudeTraitsControls({
      model: input.model,
      models: input.models,
      modelOptions: selections,
    });
  }
  return shouldRenderTraitsControls({
    provider: driver,
    models: input.models,
    model: input.model,
    modelOptions: selections,
    hiddenOptions: input.hiddenOptions,
  });
}

/**
 * The composer's traits control (Codex, Claude, or the descriptor-driven one for every other
 * provider) bound to a controlled value, for surfaces without a composer thread draft such as
 * workflow slots.
 */
export function ProviderTraitsPicker(
  props: ProviderTraitsInput & {
    readonly disabled?: boolean | undefined;
    readonly triggerClassName?: string | undefined;
    readonly onModelOptionsChange: (next: ProviderModelOptions | undefined) => void;
  },
) {
  const { provider, onModelOptionsChange } = props;
  if (provider === "codex") {
    return (
      <CodexTraitsPicker
        model={props.model}
        models={props.models}
        disabled={props.disabled}
        triggerClassName={props.triggerClassName}
        modelOptions={props.modelOptions?.codex}
        onModelOptionsChange={(codex) => onModelOptionsChange(codex ? { codex } : undefined)}
      />
    );
  }
  const selections = providerModelOptionsToSelections(provider, props.modelOptions);
  const fromSelections = (next: Parameters<typeof providerSelectionsToModelOptions>[1]) =>
    onModelOptionsChange(providerSelectionsToModelOptions(provider, next) ?? undefined);
  if (provider === "claudeAgent") {
    return (
      <ClaudeTraitsPicker
        model={props.model}
        models={props.models}
        modelOptions={selections}
        disabled={props.disabled}
        triggerClassName={props.triggerClassName}
        hiddenOptions={props.hiddenOptions}
        onModelOptionsChange={fromSelections}
      />
    );
  }
  return (
    <TraitsPicker
      provider={ProviderDriverKind.make(provider)}
      model={props.model}
      models={props.models}
      modelOptions={selections}
      disabled={props.disabled ?? false}
      {...(props.triggerClassName ? { triggerClassName: props.triggerClassName } : {})}
      hiddenOptions={props.hiddenOptions}
      onModelOptionsChange={fromSelections}
    />
  );
}
