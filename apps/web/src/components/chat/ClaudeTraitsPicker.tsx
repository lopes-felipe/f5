import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  shouldRenderTraitsControls,
  TraitsMenuContent as DescriptorTraitsMenuContent,
} from "./TraitsPicker";

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");

type ClaudeTraitsInput = {
  readonly model: string | null | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly prompt: string;
};

function getClaudeOptionDescriptors(
  input: ClaudeTraitsInput,
): ReadonlyArray<ProviderOptionDescriptor> {
  const caps = getProviderModelCapabilities(input.models, input.model, CLAUDE_PROVIDER);
  return getProviderOptionDescriptors({
    caps,
    selections: input.modelOptions,
  });
}

function getClaudeTriggerLabel(input: ClaudeTraitsInput): string {
  const descriptors = getClaudeOptionDescriptors(input);
  const primarySelectDescriptor =
    descriptors.find(
      (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
        descriptor.type === "select",
    ) ?? null;
  const ultrathinkPromptControlled =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(input.prompt);

  return descriptors
    .map((descriptor) => {
      if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
        return "Ultrathink";
      }
      if (descriptor.type === "boolean") {
        if (descriptor.id === "fastMode") {
          return descriptor.currentValue === true ? "Fast" : null;
        }
        return `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`;
      }
      return getProviderOptionCurrentLabel(descriptor);
    })
    .filter((label): label is string => typeof label === "string" && label.length > 0)
    .join(" · ");
}

export function supportsClaudeTraitsControls(input: ClaudeTraitsInput): boolean {
  return shouldRenderTraitsControls({
    provider: CLAUDE_PROVIDER,
    models: input.models,
    model: input.model,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
  });
}

function ClaudeTraitsMenuContentImpl(props: {
  threadId: ThreadId;
  model: string | null | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
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
      modelOptions={props.modelOptions}
      prompt={props.prompt}
      onPromptChange={props.onPromptChange}
    />
  );
}

export const ClaudeTraitsMenuContent = memo(ClaudeTraitsMenuContentImpl);

export const ClaudeTraitsPicker = memo(function ClaudeTraitsPicker(props: {
  threadId: ThreadId;
  model: string | null | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  if (!supportsClaudeTraitsControls(props)) {
    return null;
  }
  const triggerLabel = getClaudeTriggerLabel(props);

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <ClaudeTraitsMenuContent
          threadId={props.threadId}
          model={props.model}
          models={props.models}
          modelOptions={props.modelOptions}
          prompt={props.prompt}
          onPromptChange={props.onPromptChange}
        />
      </MenuPopup>
    </Menu>
  );
});
