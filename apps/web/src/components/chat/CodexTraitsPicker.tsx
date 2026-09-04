import type {
  CodexModelOptions,
  CodexReasoningEffort,
  ProviderModelOptions,
  ThreadId,
} from "@t3tools/contracts";
import {
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeCodexModelOptions,
  resolveCodexReasoningEffortForModel,
} from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon, ZapIcon } from "lucide-react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { recordModelSelection } from "../../modelPreferencesStore";
import { Button } from "../ui/button";
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

function getSelectedCodexTraits(
  model: string,
  modelOptions: CodexModelOptions | null | undefined,
): {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
} {
  return {
    effort: resolveCodexReasoningEffortForModel(model, modelOptions?.reasoningEffort),
    fastModeEnabled: modelOptions?.fastMode === true,
  };
}

function CodexTraitsMenuContentImpl(props: {
  threadId: ThreadId;
  model: string;
  onSelectionComplete?: () => void;
}) {
  const draft = useComposerThreadDraft(props.threadId);
  const modelOptions = draft.modelOptions?.codex;
  const setModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const options = getReasoningEffortOptions("codex", props.model);
  const defaultReasoningEffort = getDefaultReasoningEffort("codex", props.model);
  const { effort, fastModeEnabled } = getSelectedCodexTraits(props.model, modelOptions);

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
      <MenuDivider />
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
    </>
  );
}

export const CodexTraitsMenuContent = memo(CodexTraitsMenuContentImpl);

export const CodexTraitsPicker = memo(function CodexTraitsPicker(props: {
  threadId: ThreadId;
  model: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const modelOptions = useComposerThreadDraft(props.threadId).modelOptions?.codex;
  const { effort, fastModeEnabled } = getSelectedCodexTraits(props.model, modelOptions);
  const triggerLabel = CODEX_REASONING_LABELS[effort];

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
            className="min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
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
          onSelectionComplete={() => {
            setIsMenuOpen(false);
          }}
        />
      </MenuPopup>
    </Menu>
  );
});
