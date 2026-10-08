import type { ThreadId } from "@t3tools/contracts";
import {
  AtSignIcon,
  BotIcon,
  ListTodoIcon,
  NotebookPenIcon,
  PaperclipIcon,
  PlusIcon,
} from "lucide-react";
import { useRef } from "react";

import { ClaudeTraitsMenuContent, ClaudeTraitsPicker } from "~/components/chat/ClaudeTraitsPicker";
import { CodexTraitsMenuContent, CodexTraitsPicker } from "~/components/chat/CodexTraitsPicker";
import { CompactComposerControlsMenu } from "~/components/chat/CompactComposerControlsMenu";
import { ProviderInstanceModelPicker } from "~/components/chat/ProviderInstanceModelPicker";
import { RuntimeModePicker } from "~/components/chat/RuntimeModePicker";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { COMPOSER_CHIP_CLASS_NAME } from "./composerChip";
import type {
  ComposerAttachments,
  ComposerModeControls,
  ComposerModelControls,
  ComposerSendControls,
} from "./composerControls";

const INTERACTION_MODE_TOGGLE_CLASS_NAME =
  "h-6 min-w-0 gap-1 rounded-sm border-0 px-2 text-ui font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs sm:h-6 [&_svg:not([class*='size-'])]:size-3.5";

/**
 * Left side of the composer footer: Add menu, model and traits chips, the
 * Agent/Plan mode switch, access mode and the plan panel toggle. Folds the
 * secondary controls into one menu when the footer is compact.
 */
export function ComposerFooterControls(props: {
  threadId: ThreadId;
  compact: boolean;
  isComposerApprovalState: boolean;
  model: ComposerModelControls;
  mode: ComposerModeControls;
  send: Pick<
    ComposerSendControls,
    "isConnecting" | "isWorking" | "hasPendingTurnDispatch" | "isPendingTurnDispatchBlocked"
  >;
  onAttachFiles: ComposerAttachments["onAttachFiles"];
  onMentionFile: () => void;
  contextSummary: string | null;
}) {
  const { threadId, compact, isComposerApprovalState, model, mode, send, onAttachFiles } = props;
  const isPendingTurnDispatchBlocked = send.isPendingTurnDispatchBlocked;
  const attachDisabled =
    send.isConnecting || isComposerApprovalState || isPendingTurnDispatchBlocked;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showPlanControl = Boolean(
    mode.activePlan || mode.activeProposedPlan || mode.planSidebarOpen,
  );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-0.5",
        compact
          ? "-m-1 overflow-hidden p-1"
          : "-m-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Attach files"
        disabled={attachDisabled}
        onChange={(event) => {
          onAttachFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <Menu>
        <MenuTrigger
          data-composer-control="add"
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-md text-muted-foreground hover:text-foreground data-popup-open:bg-accent"
              aria-label="Add"
              disabled={attachDisabled}
            />
          }
        >
          <PlusIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start" side="top">
          <MenuItem onClick={() => fileInputRef.current?.click()}>
            <PaperclipIcon className="size-4 shrink-0" />
            Attach files…
          </MenuItem>
          <MenuItem onClick={props.onMentionFile}>
            <AtSignIcon className="size-4 shrink-0" />
            Mention a file
          </MenuItem>
        </MenuPopup>
      </Menu>
      {/* Provider/model picker */}
      <ProviderInstanceModelPicker
        compact={compact}
        instanceId={model.selectedProviderInstanceId}
        model={model.selectedModelForPickerWithCustomFallback}
        lockedInstanceId={model.hasThreadStarted ? model.selectedProviderInstanceId : null}
        modelOptionsByInstance={model.modelOptionsByInstance}
        ultrathinkActive={model.isClaudeUltrathink}
        providers={model.providerStatuses}
        keybindings={model.keybindings}
        terminalOpen={model.terminalOpen}
        open={model.isModelPickerOpen}
        onOpenChange={model.setIsModelPickerOpen}
        disabled={isPendingTurnDispatchBlocked}
        onInstanceModelChange={model.onProviderModelSelect}
        {...(model.fanOutModels ? { selectedModels: model.fanOutModels } : {})}
        {...(model.onToggleFanOutModel ? { onToggleModel: model.onToggleFanOutModel } : {})}
      />

      {compact ? (
        <CompactComposerControlsMenu
          activePlan={showPlanControl}
          canCompactConversation={mode.canCompactConversation}
          compactConversationDisabled={send.isWorking || send.hasPendingTurnDispatch}
          disabled={isPendingTurnDispatchBlocked}
          interactionMode={mode.interactionMode}
          showInteractionModeToggle={mode.showInteractionModeToggle}
          planSidebarOpen={mode.planSidebarOpen}
          provider={model.selectedProvider}
          runtimeMode={mode.runtimeMode}
          contextSummary={props.contextSummary}
          traitsMenuContent={
            model.selectedProvider === "codex" ? (
              <CodexTraitsMenuContent
                threadId={threadId}
                model={model.selectedModel}
                models={model.selectedProviderModels}
              />
            ) : model.showClaudeTraitsControls ? (
              <ClaudeTraitsMenuContent
                threadId={threadId}
                model={model.selectedModel}
                models={model.selectedProviderModels}
                modelOptions={model.selectedProviderModelOptions}
              />
            ) : (
              model.genericProviderTraitsMenuContent
            )
          }
          onCompactConversation={mode.onCompactConversation}
          onToggleInteractionMode={mode.toggleInteractionMode}
          onTogglePlanSidebar={mode.togglePlanSidebar}
          onRuntimeModeChange={mode.handleRuntimeModeChange}
        />
      ) : (
        <>
          {model.selectedProvider === "codex" ? (
            <CodexTraitsPicker
              threadId={threadId}
              model={model.selectedModel}
              models={model.selectedProviderModels}
            />
          ) : model.showClaudeTraitsControls ? (
            <ClaudeTraitsPicker
              threadId={threadId}
              model={model.selectedModel}
              models={model.selectedProviderModels}
              modelOptions={model.selectedProviderModelOptions}
            />
          ) : model.genericProviderTraitsPicker ? (
            model.genericProviderTraitsPicker
          ) : null}

          {mode.showInteractionModeToggle ? (
            <ToggleGroup
              aria-label="Interaction mode"
              data-composer-control="interactionMode"
              className="mx-0.5 h-7 shrink-0 gap-0 rounded-md bg-muted/60 p-0.5"
              value={[mode.interactionMode]}
              disabled={isPendingTurnDispatchBlocked}
              onValueChange={(next) => {
                const nextMode = next[0];
                // A single-select group can be emptied by pressing the active
                // item; keep exactly one mode selected.
                if (!nextMode || nextMode === mode.interactionMode) return;
                mode.toggleInteractionMode();
              }}
            >
              <Toggle
                value="default"
                className={INTERACTION_MODE_TOGGLE_CLASS_NAME}
                title="Agent mode: the agent edits and runs commands"
              >
                <BotIcon />
                Agent
              </Toggle>
              <Toggle
                value="plan"
                className={INTERACTION_MODE_TOGGLE_CLASS_NAME}
                title="Plan mode: the agent proposes a plan before changing anything"
              >
                <NotebookPenIcon />
                Plan
              </Toggle>
            </ToggleGroup>
          ) : null}

          <RuntimeModePicker
            disabled={isPendingTurnDispatchBlocked}
            provider={model.selectedProvider}
            value={mode.runtimeMode}
            onValueChange={mode.handleRuntimeModeChange}
          />

          {showPlanControl ? (
            <Button
              variant="ghost"
              className={cn(COMPOSER_CHIP_CLASS_NAME, mode.planSidebarOpen && "bg-accent")}
              size="sm"
              type="button"
              aria-pressed={mode.planSidebarOpen}
              onClick={mode.togglePlanSidebar}
              disabled={isPendingTurnDispatchBlocked}
              title={mode.planSidebarOpen ? "Hide plan panel" : "Show plan panel"}
            >
              <ListTodoIcon />
              <span className="sr-only @lg/composer-footer:not-sr-only">Plan panel</span>
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
