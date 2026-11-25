import type { ThreadId } from "@t3tools/contracts";
import {
  AtSignIcon,
  BotIcon,
  CircleOffIcon,
  GoalIcon,
  NotebookPenIcon,
  PaperclipIcon,
  PlusIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { ClaudeTraitsPicker } from "~/components/chat/ClaudeTraitsPicker";
import { CodexTraitsPicker } from "~/components/chat/CodexTraitsPicker";
import { CompactComposerControlsMenu } from "~/components/chat/CompactComposerControlsMenu";
import { ProviderInstanceModelPicker } from "~/components/chat/ProviderInstanceModelPicker";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { ProjectPicker } from "~/components/ProjectPicker";
import { SideChatMenuItems } from "./SideChatMenuItems";

import type {
  ComposerAttachments,
  ComposerProjectPickerControls,
  ComposerModeControls,
  ComposerModelControls,
  ComposerSendControls,
} from "./composerControls";
import { NativeGoalDialog } from "./NativeGoalDialog";
import { ComposerUsageLimits } from "../../usage/ComposerUsageLimits";

const INTERACTION_MODE_TOGGLE_CLASS_NAME =
  "h-6 min-w-0 gap-1 rounded-sm border-0 px-2 text-ui font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs sm:h-6 [&_svg:not([class*='size-'])]:size-3.5";

/** The Agent/Plan switch. Exactly one mode stays selected. */
export function ComposerInteractionModeToggle(props: {
  readonly value: "default" | "plan";
  readonly disabled?: boolean | undefined;
  readonly onToggle: () => void;
}) {
  return (
    <ToggleGroup
      aria-label="Interaction mode"
      data-composer-control="interactionMode"
      className="mx-0.5 h-7 shrink-0 gap-0 rounded-md bg-muted/60 p-0.5"
      value={[props.value]}
      disabled={props.disabled ?? false}
      onValueChange={(next) => {
        const nextMode = next[0];
        // A single-select group can be emptied by pressing the active
        // item; keep exactly one mode selected.
        if (!nextMode || nextMode === props.value) return;
        props.onToggle();
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
  );
}

/** Attachment and context controls on the left, model and effort on the right. */
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
  /** Unsent drafts only; the compact footer leaves it to the header crumb. */
  projectPicker?: ComposerProjectPickerControls | undefined;
}) {
  const { threadId, compact, isComposerApprovalState, model, mode, send, onAttachFiles } = props;
  const isPendingTurnDispatchBlocked = send.isPendingTurnDispatchBlocked;
  const attachDisabled =
    send.isConnecting || isComposerApprovalState || isPendingTurnDispatchBlocked;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const nativeGoal = mode.nativeGoal;
  const showPlanControl = Boolean(
    mode.activePlan || mode.activeProposedPlan || mode.planSidebarOpen,
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Attach files"
        title="Attach files"
        disabled={attachDisabled}
        onClick={() => fileInputRef.current?.click()}
      >
        <PaperclipIcon className="size-4" />
      </Button>
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
          <MenuItem onClick={props.onMentionFile}>
            <AtSignIcon className="size-4 shrink-0" />
            Mention a file
          </MenuItem>
          <SideChatMenuItems threadId={threadId} />
          {nativeGoal ? (
            <>
              <MenuSeparator />
              <MenuItem disabled={nativeGoal.disabled} onClick={() => setGoalDialogOpen(true)}>
                <GoalIcon className="size-4 shrink-0" />
                Set goal…
              </MenuItem>
              {nativeGoal.hasGoal ? (
                <MenuItem disabled={nativeGoal.disabled} onClick={() => void nativeGoal.onClear()}>
                  <CircleOffIcon className="size-4 shrink-0" />
                  Clear goal
                </MenuItem>
              ) : null}
              {nativeGoal.active ? (
                <div className="px-2 py-1 text-muted-foreground text-xs">
                  Available once the current goal settles
                </div>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {nativeGoal ? (
        <NativeGoalDialog
          open={goalDialogOpen}
          disabled={nativeGoal.disabled}
          onOpenChange={setGoalDialogOpen}
          onSubmit={nativeGoal.onSet}
        />
      ) : null}
      {props.projectPicker && !compact ? (
        <ProjectPicker
          projects={props.projectPicker.projects}
          selection={props.projectPicker.selection}
          onSelect={props.projectPicker.onSelect}
          disabled={props.projectPicker.disabled ?? false}
          allowNone
          trigger="chip"
        />
      ) : null}
      {!compact && mode.showInteractionModeToggle ? (
        <ComposerInteractionModeToggle
          value={mode.interactionMode}
          disabled={isPendingTurnDispatchBlocked}
          onToggle={mode.toggleInteractionMode}
        />
      ) : null}
      <CompactComposerControlsMenu
        activePlan={showPlanControl}
        canCompactConversation={mode.canCompactConversation}
        compactConversationDisabled={send.isWorking || send.hasPendingTurnDispatch}
        disabled={isPendingTurnDispatchBlocked}
        interactionMode={mode.interactionMode}
        showInteractionModeToggle={compact && mode.showInteractionModeToggle}
        planSidebarOpen={mode.planSidebarOpen}
        provider={model.selectedProvider}
        availableRuntimeModes={mode.availableRuntimeModes}
        runtimeMode={mode.runtimeMode}
        contextSummary={props.contextSummary}
        onCompactConversation={mode.onCompactConversation}
        onToggleInteractionMode={mode.toggleInteractionMode}
        onTogglePlanSidebar={mode.togglePlanSidebar}
        onRuntimeModeChange={mode.handleRuntimeModeChange}
      />
      <ComposerUsageLimits threadId={props.threadId} />
      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {model.noProviderAvailable ? (
          <span className="px-2 text-xs text-muted-foreground" role="status">
            No provider available
          </span>
        ) : (
          <ProviderInstanceModelPicker
            docked
            stayOpenOnSelect
            compact={compact}
            instanceId={model.selectedProviderInstanceId}
            model={model.selectedModelForPickerWithCustomFallback}
            lockedInstanceId={
              (model.providerLocked ?? model.hasThreadStarted)
                ? model.selectedProviderInstanceId
                : null
            }
            modelOptionsByInstance={model.modelOptionsByInstance}
            ultrathinkActive={model.isClaudeUltrathink}
            providers={model.providerStatuses}
            keybindings={model.keybindings}
            terminalOpen={model.terminalOpen}
            open={model.isModelPickerOpen}
            onOpenChange={model.setIsModelPickerOpen}
            disabled={isPendingTurnDispatchBlocked}
            onInstanceModelChange={model.onProviderModelSelect}
            favoritePresets
            activePreset={model.activeFavoritePreset ?? null}
            {...(model.fanOutModels ? { selectedModels: model.fanOutModels } : {})}
            {...(model.onToggleFanOutModel ? { onToggleModel: model.onToggleFanOutModel } : {})}
          />
        )}

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
      </div>
    </div>
  );
}
