import {
  ProviderDriverKind,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveCodexFastMode,
  resolveCodexEffectiveReasoningEffort,
  resolveCodexReasoningEffortForModel,
  resolveModelCapabilities,
} from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";
import { notifyComposerModelPick } from "../../composerModelPicks";
import { defaultComposerEffort } from "./composerModelDefaults";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { recordModelSelection } from "../../modelPreferencesStore";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { EffortMenuSection, FastModeLabel, FastModeTriggerIcon } from "./EffortMenuSection";
import { getEffortLevel } from "./effortLevels";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

/** Capabilities the session reported; the same input `turn/start` resolves against. */
function getReportedCodexCapabilities(
  model: string,
  models: ReadonlyArray<ServerProviderModel> | undefined,
) {
  return models ? getProviderModelCapabilities(models, model, CODEX_PROVIDER) : undefined;
}

function getSelectedCodexTraits(
  model: string,
  modelOptions: CodexModelOptions | null | undefined,
  models?: ReadonlyArray<ServerProviderModel>,
): {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
} {
  const reported = getReportedCodexCapabilities(model, models);
  const capabilities = resolveModelCapabilities("codex", model, reported);
  const requested =
    modelOptions?.reasoningEffort ?? defaultComposerEffort(capabilities.effortOptions);
  // The effort `turn/start` runs at, which the composer also dispatches explicitly.
  const effort = resolveCodexEffectiveReasoningEffort(model, requested, reported);
  return {
    effort: effort ?? resolveCodexReasoningEffortForModel(model, requested),
    fastModeEnabled: resolveCodexFastMode(modelOptions, reported) && capabilities.supportsFastMode,
  };
}

/**
 * Where the Codex traits live: a composer thread draft, or a controlled value (workflow slots)
 * whose owner records the change itself.
 */
type CodexTraitsBinding =
  | {
      threadId: ThreadId;
      modelOptions?: never;
      onModelOptionsChange?: never;
    }
  | {
      threadId?: undefined;
      modelOptions: CodexModelOptions | undefined;
      onModelOptionsChange: (next: CodexModelOptions | undefined) => void;
    };

/** The bound Codex options, read from the thread draft only when bound to one. */
function useCodexTraitsModelOptions(binding: CodexTraitsBinding) {
  const draftModelOptions = useComposerDraftStore((store) =>
    binding.threadId ? store.draftsByThreadId[binding.threadId]?.modelOptions : undefined,
  );
  return {
    draftModelOptions,
    modelOptions: binding.onModelOptionsChange ? binding.modelOptions : draftModelOptions?.codex,
  };
}

function CodexTraitsMenuContentImpl(
  props: {
    model: string;
    models?: ReadonlyArray<ServerProviderModel>;
    onSelectionComplete?: () => void;
  } & CodexTraitsBinding,
) {
  const { draftModelOptions, modelOptions } = useCodexTraitsModelOptions(props);
  const setModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const reported = getReportedCodexCapabilities(props.model, props.models);
  const capabilities = resolveModelCapabilities("codex", props.model, reported);
  const options = capabilities.effortOptions as ReadonlyArray<CodexReasoningEffort>;
  const defaultReasoningEffort = capabilities.defaultEffort;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(
    props.model,
    modelOptions,
    props.models,
  );

  const setCodexModelOptions = (nextCodexModelOptions: CodexModelOptions | undefined) => {
    if (props.onModelOptionsChange) {
      props.onModelOptionsChange(nextCodexModelOptions);
      return;
    }
    if (!props.threadId) return;
    const { codex: _discardedCodex, ...otherProviderModelOptions } = draftModelOptions ?? {};
    const nextProviderModelOptions: ProviderModelOptions | undefined = nextCodexModelOptions
      ? { ...otherProviderModelOptions, codex: nextCodexModelOptions }
      : Object.keys(otherProviderModelOptions).length > 0
        ? otherProviderModelOptions
        : undefined;
    setModelOptions(props.threadId, nextProviderModelOptions);
    // Record the (provider, model, options) triple so the MRU used by
    // `model.switchRecent` keeps the fresh options attached to the codex
    // model the user is actively editing.
    recordModelSelection("codex", props.model, nextProviderModelOptions);
    notifyComposerModelPick(props.threadId);
  };

  return (
    <>
      {reported?.optionDescriptors?.find(
        (option) => option.id === "cyberAccessProgram" && option.type === "select",
      )
        ? (() => {
            const cyber = reported.optionDescriptors?.find(
              (option) => option.id === "cyberAccessProgram",
            );
            if (cyber?.type !== "select") return null;
            return (
              <MenuGroup>
                <MenuGroupLabel>Cyber Access</MenuGroupLabel>
                <MenuRadioGroup
                  value={
                    cyber.options.some((option) => option.id === modelOptions?.cyberAccessProgram)
                      ? modelOptions?.cyberAccessProgram
                      : (cyber.currentValue ?? "")
                  }
                  onValueChange={(value) => {
                    if (value === "standard" || value === "daybreakBlue" || value === "daybreakRed")
                      setCodexModelOptions({ ...modelOptions, cyberAccessProgram: value });
                  }}
                >
                  {cyber.options.map((option) => (
                    <MenuRadioItem key={option.id} value={option.id}>
                      {option.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuDivider />
              </MenuGroup>
            );
          })()
        : null}
      <EffortMenuSection
        options={options.map((option) => ({
          id: option,
          label: CODEX_REASONING_LABELS[option],
          isDefault: option === defaultReasoningEffort,
        }))}
        value={effort}
        onValueChange={(value) => {
          const nextEffort = options.find((option) => option === value);
          if (!nextEffort) return;
          // Keep even the provider's default explicit: omission means the
          // composer's High default, not the user's chosen Medium/Low.
          setCodexModelOptions({ ...modelOptions, reasoningEffort: nextEffort });
          props.onSelectionComplete?.();
        }}
      />
      {capabilities.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuCheckboxItem
            variant="switch"
            checked={fastModeEnabled}
            onCheckedChange={(checked) => {
              setCodexModelOptions({ ...modelOptions, reasoningEffort: effort, fastMode: checked });
            }}
          >
            <FastModeLabel enabled={fastModeEnabled} />
          </MenuCheckboxItem>
        </>
      ) : null}
    </>
  );
}

export const CodexTraitsMenuContent = memo(CodexTraitsMenuContentImpl);

export const CodexTraitsPicker = memo(function CodexTraitsPicker(
  props: {
    model: string;
    models?: ReadonlyArray<ServerProviderModel>;
    disabled?: boolean | undefined;
    triggerClassName?: string | undefined;
    /** Tint the trigger with the effort level's colour (the composer chip). Defaults to true. */
    tint?: boolean | undefined;
  } & CodexTraitsBinding,
) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { modelOptions } = useCodexTraitsModelOptions(props);
  const { effort, fastModeEnabled } = getSelectedCodexTraits(
    props.model,
    modelOptions,
    props.models,
  );
  const triggerLabel = CODEX_REASONING_LABELS[effort];
  const binding: CodexTraitsBinding = props.onModelOptionsChange
    ? { modelOptions: props.modelOptions, onModelOptionsChange: props.onModelOptionsChange }
    : { threadId: props.threadId as ThreadId };

  return (
    <Menu
      open={isMenuOpen && !props.disabled}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !props.disabled);
      }}
    >
      <MenuTrigger
        data-composer-control="effort"
        data-effort-level={effort}
        render={
          <Button
            size="sm"
            variant="ghost"
            disabled={props.disabled}
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              "min-w-0 max-w-40 shrink justify-start overflow-hidden sm:max-w-48 [&_svg]:mx-0",
              props.tint === false ? undefined : getEffortLevel(effort)?.chipClass,
              props.triggerClassName,
            )}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {/* In a width-capped trigger the label truncates; the icon and chevron stay whole. */}
          <span className="min-w-0 truncate" title={triggerLabel}>
            {triggerLabel}
          </span>
          {fastModeEnabled ? <FastModeTriggerIcon /> : null}
          {/* Pinned to the trailing edge when the trigger is wider than its content. The
              wrapper carries the margin: the trigger's `[&_svg]:mx-0` would override it on
              the icon itself. */}
          <span aria-hidden="true" className="ms-auto inline-flex shrink-0">
            <ChevronDownIcon className="size-3 opacity-60" />
          </span>
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <CodexTraitsMenuContent
          {...binding}
          model={props.model}
          {...(props.models ? { models: props.models } : {})}
          onSelectionComplete={() => {
            setIsMenuOpen(false);
          }}
        />
      </MenuPopup>
    </Menu>
  );
});
