import {
  ProviderDriverKind,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  normalizeCodexModelOptions,
  resolveCodexReasoningEffortForModel,
  resolveModelCapabilities,
} from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";
import { memo, useState } from "react";
import { ChevronDownIcon, ZapIcon } from "lucide-react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { recordModelSelection } from "../../modelPreferencesStore";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
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

/** Same resolver the server uses for `turn/start`, fed with reported capabilities. */
function resolveCodexTraitCapabilities(
  model: string,
  models: ReadonlyArray<ServerProviderModel> | undefined,
) {
  return resolveModelCapabilities(
    "codex",
    model,
    models ? getProviderModelCapabilities(models, model, CODEX_PROVIDER) : undefined,
  );
}

function getSelectedCodexTraits(
  model: string,
  modelOptions: CodexModelOptions | null | undefined,
  models?: ReadonlyArray<ServerProviderModel>,
): {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
} {
  const capabilities = resolveCodexTraitCapabilities(model, models);
  const requested = modelOptions?.reasoningEffort;
  const effort =
    capabilities.source === "reported"
      ? ((requested && capabilities.effortOptions.includes(requested)
          ? requested
          : capabilities.defaultEffort) as CodexReasoningEffort | undefined)
      : undefined;
  return {
    effort: effort ?? resolveCodexReasoningEffortForModel(model, requested),
    fastModeEnabled: modelOptions?.fastMode === true && capabilities.supportsFastMode,
  };
}

function CodexTraitsMenuContentImpl(props: {
  threadId: ThreadId;
  model: string;
  models?: ReadonlyArray<ServerProviderModel>;
  onSelectionComplete?: () => void;
}) {
  const draft = useComposerThreadDraft(props.threadId);
  const modelOptions = draft.modelOptions?.codex;
  const setModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const capabilities = resolveCodexTraitCapabilities(props.model, props.models);
  const options = capabilities.effortOptions as ReadonlyArray<CodexReasoningEffort>;
  const defaultReasoningEffort = capabilities.defaultEffort;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(
    props.model,
    modelOptions,
    props.models,
  );

  const setCodexModelOptions = (nextCodexModelOptions: CodexModelOptions | undefined) => {
    const { codex: _discardedCodex, ...otherProviderModelOptions } = draft.modelOptions ?? {};
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
  };

  return (
    <>
      <MenuGroup>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
        <MenuRadioGroup
          value={effort}
          onValueChange={(value) => {
            if (!value) return;
            const nextEffort = options.find((option) => option === value);
            if (!nextEffort) return;
            setCodexModelOptions(
              normalizeCodexModelOptions(props.model, {
                ...modelOptions,
                reasoningEffort: nextEffort,
              }),
            );
            props.onSelectionComplete?.();
          }}
        >
          {options.map((option) => (
            <MenuRadioItem key={option} value={option}>
              {CODEX_REASONING_LABELS[option]}
              {option === defaultReasoningEffort ? " (default)" : ""}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      {capabilities.supportsFastMode ? <MenuDivider /> : null}
      {capabilities.supportsFastMode ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
          <MenuRadioGroup
            value={fastModeEnabled ? "on" : "off"}
            onValueChange={(value) => {
              setCodexModelOptions(
                normalizeCodexModelOptions(props.model, {
                  ...modelOptions,
                  fastMode: value === "on",
                }),
              );
              props.onSelectionComplete?.();
            }}
          >
            <MenuRadioItem value="off">off</MenuRadioItem>
            <MenuRadioItem value="on">on</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
    </>
  );
}

export const CodexTraitsMenuContent = memo(CodexTraitsMenuContentImpl);

export const CodexTraitsPicker = memo(function CodexTraitsPicker(props: {
  threadId: ThreadId;
  model: string;
  models?: ReadonlyArray<ServerProviderModel>;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const modelOptions = useComposerThreadDraft(props.threadId).modelOptions?.codex;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(
    props.model,
    modelOptions,
    props.models,
  );
  const triggerLabel = CODEX_REASONING_LABELS[effort];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        data-composer-control="effort"
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              "min-w-0 max-w-40 shrink justify-start overflow-hidden sm:max-w-48 [&_svg]:mx-0",
            )}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {triggerLabel}
          {fastModeEnabled ? (
            <ZapIcon aria-label="Fast mode enabled" className="size-3 shrink-0" />
          ) : null}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <CodexTraitsMenuContent
          threadId={props.threadId}
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
