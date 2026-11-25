import {
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { EffortMenuSection, FastModeLabel } from "./EffortMenuSection";
import { getEffortChipClass, isEffortDescriptor } from "./effortLevels";
import { traitsTriggerParts } from "./traitsTrigger";
import { TraitsTriggerIcons } from "./TraitsTriggerIcons";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

/** Traits a surface leaves out of the menu, such as workflow slots that send no composer prompt. */
export interface TraitsHiddenOptions {
  /** Select options that only work by injecting a prompt keyword (Claude `ultrathink`). */
  readonly promptInjected?: boolean;
  /** Whole descriptors to leave out, by id. */
  readonly descriptorIds?: ReadonlyArray<string>;
}

/**
 * Drops the hidden descriptors, and select options that only work by injecting a keyword into
 * the prompt. A current value among the dropped options falls back to the descriptor default.
 */
function omitHiddenOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  hidden: TraitsHiddenOptions,
): ReadonlyArray<ProviderOptionDescriptor> {
  const hiddenIds = new Set(hidden.descriptorIds);
  return descriptors.flatMap((descriptor) => {
    if (hiddenIds.has(descriptor.id)) return [];
    if (
      !hidden.promptInjected ||
      descriptor.type !== "select" ||
      !descriptor.promptInjectedValues?.length
    ) {
      return descriptor;
    }
    const injected = new Set(descriptor.promptInjectedValues);
    const { currentValue, promptInjectedValues: _promptInjectedValues, ...rest } = descriptor;
    return {
      ...rest,
      options: descriptor.options.filter((option) => !injected.has(option.id)),
      ...(currentValue !== undefined && !injected.has(currentValue) ? { currentValue } : {}),
    };
  });
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  modelOptions: ProviderOptions | null | undefined,
  hiddenOptions: TraitsHiddenOptions | undefined,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const allDescriptors = getProviderOptionDescriptors({
    caps,
    selections: modelOptions,
  });
  const descriptors = hiddenOptions
    ? omitHiddenOptions(allDescriptors, hiddenOptions)
    : allDescriptors;
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  const effort = getDescriptorStringValue(primarySelectDescriptor);
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const fastModeEnabled =
    typeof fastModeDescriptor?.currentValue === "boolean" ? fastModeDescriptor.currentValue : false;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    fastModeEnabled,
    contextWindow,
    selectedAgent,
    selectedAgentLabel,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions: ProviderOptions | null | undefined;
  hiddenOptions?: TraitsHiddenOptions | undefined;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.modelOptions,
    input.hiddenOptions,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions: ProviderOptions | null | undefined;
  hiddenOptions?: TraitsHiddenOptions | undefined;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  /** Tint the trigger in the selected effort's colour (composer chips only). */
  tintTrigger?: boolean;
  /** Traits to leave out, for surfaces such as workflow slots that send no composer prompt. */
  hiddenOptions?: TraitsHiddenOptions | undefined;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  modelOptions,
  hiddenOptions,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(model !== undefined ? { model } : {}),
        persistSticky: true,
      });
    },
    [model, persistence, provider, setProviderModelOptions],
  );
  const { descriptors, selectDescriptors, booleanDescriptors, hasAnyControls } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      modelOptions,
      hiddenOptions,
    });
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          {isEffortDescriptor(descriptor) ? (
            <EffortMenuSection
              options={descriptor.options}
              value={getDescriptorStringValue(descriptor)}
              onValueChange={(value) => handleSelectChange(descriptor, value)}
            />
          ) : (
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                value={getDescriptorStringValue(descriptor) ?? ""}
                onValueChange={(value) => handleSelectChange(descriptor, value)}
              >
                {descriptor.options.map((option) => (
                  <MenuRadioItem key={option.id} value={option.id}>
                    {option.label}
                    {option.isDefault ? " (default)" : ""}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          )}
        </div>
      ))}
      {booleanDescriptors.length > 0 && selectDescriptors.length > 0 ? <MenuDivider /> : null}
      {booleanDescriptors.map((descriptor) => (
        <MenuCheckboxItem
          key={descriptor.id}
          variant="switch"
          checked={descriptor.currentValue === true}
          onCheckedChange={(checked) => {
            updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, checked));
          }}
        >
          {descriptor.id === "fastMode" ? (
            <FastModeLabel enabled={descriptor.currentValue === true} label={descriptor.label} />
          ) : (
            descriptor.label
          )}
        </MenuCheckboxItem>
      ))}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  modelOptions,
  triggerVariant,
  triggerClassName,
  tintTrigger = false,
  disabled = false,
  hiddenOptions,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence & { disabled?: boolean }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { caps, descriptors, hasAnyControls } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
    hiddenOptions,
  });
  if (!hasAnyControls) {
    return null;
  }

  const { label: triggerLabel, icons: triggerIcons } = traitsTriggerParts({
    descriptors,
    defaults: caps?.optionDescriptors,
  });

  const isCodexStyle = provider === "codex";
  const effortTint = tintTrigger ? getEffortChipClass(descriptors) : null;

  return (
    <Menu
      open={isMenuOpen && !disabled}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <MenuTrigger
        {...(effortTint ? { "data-effort-level": effortTint.level } : {})}
        render={
          <Button
            size="sm"
            disabled={disabled}
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground hover:text-foreground sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-muted-foreground hover:text-foreground sm:px-3",
              triggerClassName,
              effortTint?.className,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2">
            <span className="truncate">{triggerLabel}</span>
            <TraitsTriggerIcons icons={triggerIcons} />
            {/* Pinned to the trailing edge when the trigger is wider than its content. */}
            <ChevronDownIcon aria-hidden="true" className="ms-auto size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <TraitsTriggerIcons icons={triggerIcons} />
            <ChevronDownIcon aria-hidden="true" className="ms-auto size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          models={models}
          model={model}
          modelOptions={modelOptions}
          hiddenOptions={hiddenOptions}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
