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
  type TraitsHiddenOptions,
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
    /** Traits to leave out, such as prompt-keyword efforts where no composer prompt is sent. */
    hiddenOptions?: TraitsHiddenOptions | undefined;
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
      hiddenOptions={props.hiddenOptions}
    />
  ) : (
    <DescriptorTraitsMenuContent
      provider={CLAUDE_PROVIDER}
      {...(props.threadId ? { draftId: props.threadId } : {})}
      model={props.model}
      models={props.models}
      modelOptions={modelOptions}
      hiddenOptions={props.hiddenOptions}
    />
  );
}

export const ClaudeTraitsMenuContent = memo(ClaudeTraitsMenuContentImpl);

export const ClaudeTraitsPicker = memo(function ClaudeTraitsPicker(
  props: ClaudeTraitsProps & {
    disabled?: boolean | undefined;
    triggerClassName?: string | undefined;
    /** Tint the trigger with the effort level's colour (the composer chip). Defaults to true. */
    tint?: boolean | undefined;
  },
) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  if (!supportsClaudeTraitsControls(props)) {
    return null;
  }
  const trigger = getClaudeTriggerPresentation(props);
  const { disabled, triggerClassName, tint = true, ...menuProps } = props;

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
              tint ? trigger.effortTint?.className : undefined,
              triggerClassName,
            )}
          />
        }
      >
        {/* In a width-capped trigger the label truncates; the icons and chevron stay whole. */}
        <span className="min-w-0 truncate" title={trigger.label}>
          {trigger.label}
        </span>
        <TraitsTriggerIcons icons={trigger.icons} />
        {/* Pinned to the trailing edge when the trigger is wider than its content. The
            wrapper carries the margin: Button's `[&_svg]` margin rule would override it on
            the icon itself. */}
        <span aria-hidden="true" className="ms-auto inline-flex shrink-0">
          <ChevronDownIcon className="size-3 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <ClaudeTraitsMenuContent {...menuProps} />
      </MenuPopup>
    </Menu>
  );
});
