import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { FastModeTriggerIcon } from "./EffortMenuSection";
import { getEffortChipClass } from "./effortLevels";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { getProviderModelCapabilities } from "../../providerModels";
import { withComposerModelDefaults } from "./composerModelDefaults";
import {
  shouldRenderTraitsControls,
  TraitsMenuContent as DescriptorTraitsMenuContent,
} from "./TraitsPicker";

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");

type ClaudeTraitsInput = {
  readonly model: string | null | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

function getClaudeOptionDescriptors(
  input: ClaudeTraitsInput,
): ReadonlyArray<ProviderOptionDescriptor> {
  const caps = getProviderModelCapabilities(input.models, input.model, CLAUDE_PROVIDER);
  return getProviderOptionDescriptors({
    caps,
    selections: withComposerModelDefaults(caps, input.modelOptions),
  });
}

function getClaudeTriggerPresentation(input: ClaudeTraitsInput): {
  label: string;
  fastModeEnabled: boolean;
  effortTint: { level: string; className: string } | null;
} {
  const descriptors = getClaudeOptionDescriptors(input);
  return {
    effortTint: getEffortChipClass(descriptors),
    label: descriptors
      .map((descriptor) => {
        if (descriptor.type === "boolean") {
          if (descriptor.id === "fastMode") return null;
          return `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`;
        }
        return getProviderOptionCurrentLabel(descriptor);
      })
      .filter((label): label is string => typeof label === "string" && label.length > 0)
      .join(" · "),
    fastModeEnabled: descriptors.some(
      (descriptor) =>
        descriptor.type === "boolean" &&
        descriptor.id === "fastMode" &&
        descriptor.currentValue === true,
    ),
  };
}

export function supportsClaudeTraitsControls(input: ClaudeTraitsInput): boolean {
  return shouldRenderTraitsControls({
    provider: CLAUDE_PROVIDER,
    models: input.models,
    model: input.model,
    modelOptions: input.modelOptions,
  });
}

function ClaudeTraitsMenuContentImpl(props: {
  threadId: ThreadId;
  model: string | null | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}) {
  if (!supportsClaudeTraitsControls(props)) {
    return null;
  }

  return (
    <DescriptorTraitsMenuContent
      provider={CLAUDE_PROVIDER}
      draftId={props.threadId}
      model={props.model}
      models={props.models}
      modelOptions={withComposerModelDefaults(
        getProviderModelCapabilities(props.models, props.model, CLAUDE_PROVIDER),
        props.modelOptions,
      )}
    />
  );
}

export const ClaudeTraitsMenuContent = memo(ClaudeTraitsMenuContentImpl);

export const ClaudeTraitsPicker = memo(function ClaudeTraitsPicker(props: {
  threadId: ThreadId;
  model: string | null | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  if (!supportsClaudeTraitsControls(props)) {
    return null;
  }
  const trigger = getClaudeTriggerPresentation(props);

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        data-composer-control="effort"
        {...(trigger.effortTint ? { "data-effort-level": trigger.effortTint.level } : {})}
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(COMPOSER_CHIP_CLASS_NAME, trigger.effortTint?.className)}
          />
        }
      >
        <span>{trigger.label}</span>
        {trigger.fastModeEnabled ? <FastModeTriggerIcon /> : null}
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <ClaudeTraitsMenuContent
          threadId={props.threadId}
          model={props.model}
          models={props.models}
          modelOptions={props.modelOptions}
        />
      </MenuPopup>
    </Menu>
  );
});
