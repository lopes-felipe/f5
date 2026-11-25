import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { getEffortChipClass } from "./effortLevels";
import { traitsTriggerParts } from "./traitsTrigger";
import { TraitsTriggerIcons } from "./TraitsTriggerIcons";
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

function getClaudeTriggerPresentation(input: ClaudeTraitsInput): {
  label: string;
  icons: ReadonlyArray<"fastMode" | "ultracode">;
  effortTint: { level: string; className: string } | null;
} {
  const caps = getProviderModelCapabilities(input.models, input.model, CLAUDE_PROVIDER);
  const descriptors: ReadonlyArray<ProviderOptionDescriptor> = getProviderOptionDescriptors({
    caps,
    selections: withComposerModelDefaults(caps, input.modelOptions),
  });
  return {
    ...traitsTriggerParts({ descriptors, defaults: caps.optionDescriptors }),
    effortTint: getEffortChipClass(descriptors),
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

/**
 * Where the Claude traits live: a composer thread draft, or a controlled value (workflow
 * slots) whose owner records the change itself.
 */
type ClaudeTraitsBinding =
  | { threadId: ThreadId; onModelOptionsChange?: never }
  | {
      threadId?: undefined;
      onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
    };

type ClaudeTraitsProps = ClaudeTraitsInput &
  ClaudeTraitsBinding & {
    /** Hide prompt-keyword efforts (Ultrathink) where no composer prompt is sent. */
    hidePromptInjectedOptions?: boolean | undefined;
  };

function ClaudeTraitsMenuContentImpl(props: ClaudeTraitsProps) {
  if (!supportsClaudeTraitsControls(props)) {
    return null;
  }
  const modelOptions = withComposerModelDefaults(
    getProviderModelCapabilities(props.models, props.model, CLAUDE_PROVIDER),
    props.modelOptions,
  );

  return props.onModelOptionsChange ? (
    <DescriptorTraitsMenuContent
      provider={CLAUDE_PROVIDER}
      onModelOptionsChange={props.onModelOptionsChange}
      model={props.model}
      models={props.models}
      modelOptions={modelOptions}
      hidePromptInjectedOptions={props.hidePromptInjectedOptions}
    />
  ) : (
    <DescriptorTraitsMenuContent
      provider={CLAUDE_PROVIDER}
      {...(props.threadId ? { draftId: props.threadId } : {})}
      model={props.model}
      models={props.models}
      modelOptions={modelOptions}
      hidePromptInjectedOptions={props.hidePromptInjectedOptions}
    />
  );
}

const ClaudeTraitsMenuContent = memo(ClaudeTraitsMenuContentImpl);

export const ClaudeTraitsPicker = memo(function ClaudeTraitsPicker(
  props: ClaudeTraitsProps & {
    disabled?: boolean | undefined;
    triggerClassName?: string | undefined;
  },
) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  if (!supportsClaudeTraitsControls(props)) {
    return null;
  }
  const trigger = getClaudeTriggerPresentation(props);
  const { disabled, triggerClassName, ...menuProps } = props;

  return (
    <Menu
      open={isMenuOpen && !disabled}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <MenuTrigger
        data-composer-control="effort"
        {...(trigger.effortTint ? { "data-effort-level": trigger.effortTint.level } : {})}
        render={
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              trigger.effortTint?.className,
              triggerClassName,
            )}
          />
        }
      >
        <span>{trigger.label}</span>
        <TraitsTriggerIcons icons={trigger.icons} />
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <ClaudeTraitsMenuContent {...menuProps} />
      </MenuPopup>
    </Menu>
  );
});
