import type * as React from "react";
import { proposedPlanTitle } from "~/proposedPlan";
import { basenameOfPath } from "~/vscode-icons";
import {
  BotIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ListTodoIcon,
  NotebookPenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { ComposerPromptEditor } from "~/components/ComposerPromptEditor";
import { RuntimeModePicker } from "~/components/chat/RuntimeModePicker";
import { buildExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { ProviderInstanceModelPicker } from "~/components/chat/ProviderInstanceModelPicker";
import { ComposerSendControl } from "~/components/chat/ComposerSendControl";
import { ComposerCommandMenu } from "~/components/chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "~/components/chat/ComposerPendingApprovalActions";
import { ClaudeTraitsMenuContent, ClaudeTraitsPicker } from "~/components/chat/ClaudeTraitsPicker";
import { CodexTraitsMenuContent, CodexTraitsPicker } from "~/components/chat/CodexTraitsPicker";
import { CompactComposerControlsMenu } from "~/components/chat/CompactComposerControlsMenu";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "~/components/chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "~/components/chat/ComposerPlanFollowUpBanner";
import { VscodeEntryIcon } from "~/components/chat/VscodeEntryIcon";

export interface ChatComposerProps {
  composerFormRef: React.RefObject<HTMLFormElement | null>;
  onSend: (
    event?: { preventDefault: () => void },
    intent?: "auto" | "queue-tail" | "queue-head" | "send-now",
  ) => Promise<void>;
  isDragOverComposer: boolean;
  interactionMode: "default" | "plan";
  onComposerDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDragEnterCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDragOverCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDragLeaveCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDropCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  activePendingApproval: import("~/session-logic").PendingApproval | null;
  pendingApprovals: import("~/session-logic").PendingApproval[];
  pendingUserInputs: import("~/session-logic").PendingUserInput[];
  respondingRequestIds: import("@t3tools/contracts").ApprovalRequestId[];
  activePendingDraftAnswers: Record<
    string,
    import("~/pendingUserInput").PendingUserInputDraftAnswer
  >;
  activePendingQuestionIndex: number;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onToggleActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: import("~/session-logic").LatestProposedPlanState | null;
  hasComposerHeader: boolean;
  composerMenuOpen: boolean;
  isComposerApprovalState: boolean;
  composerMenuItems: import("~/components/chat/ComposerCommandMenu").ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isComposerMenuLoading: boolean;
  composerTriggerKind: import("~/composer-logic").ComposerTriggerKind | null;
  activeComposerMenuItem:
    | import("~/components/chat/ComposerCommandMenu").ComposerCommandItem
    | null;
  onComposerMenuItemHighlighted: (itemId: string | null) => void;
  onSelectComposerItem: (
    item: import("~/components/chat/ComposerCommandMenu").ComposerCommandItem,
  ) => void;
  composerImages: import("~/composerDraftStore").ComposerImageAttachment[];
  usesCustomImageContextMenu: boolean;
  onImageActionMenu: (
    item: import("~/components/chat/imageAttachmentActions").ImageAttachmentActionItem,
    position: { x: number; y: number },
  ) => void;
  setExpandedImage: React.Dispatch<
    React.SetStateAction<
      import("~/components/chat/ExpandedImagePreview").ExpandedImagePreview | null
    >
  >;
  nonPersistedComposerImageIdSet: Set<string>;
  removeComposerImage: (imageId: string) => void;
  isPendingTurnDispatchBlocked: boolean;
  composerFilePaths: string[];
  activeThread: import("~/types").Thread;
  activeProject: import("~/types").Project | undefined;
  removeComposerFilePath: (filePath: string) => void;
  composerEditorRef: React.RefObject<
    import("~/components/ComposerPromptEditor").ComposerPromptEditorHandle | null
  >;
  activePendingProgress: import("~/pendingUserInput").PendingUserInputProgress | null;
  prompt: string;
  composerCursor: number;
  composerTerminalContexts: import("~/lib/terminalContext").TerminalContextDraft[];
  removeComposerTerminalContextFromDraft: (contextId: string) => void;
  onPromptChange: (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  onComposerCommandKey: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLElement>) => void;
  phase: import("~/types").SessionPhase;
  isConnecting: boolean;
  onRespondToApproval: React.ComponentProps<
    typeof ComposerPendingApprovalActions
  >["onRespondToApproval"];
  isComposerFooterCompact: boolean;
  selectedProviderInstanceId: import("@t3tools/contracts").ProviderInstanceId;
  selectedModelForPickerWithCustomFallback: string;
  hasThreadStarted: boolean;
  modelOptionsByInstance: React.ComponentProps<
    typeof ProviderInstanceModelPicker
  >["modelOptionsByInstance"];
  isClaudeUltrathink: boolean;
  providerStatuses: readonly import("@t3tools/contracts").ServerProvider[];
  keybindings: import("@t3tools/contracts").ResolvedKeybindingsConfig;
  terminalState: { readonly terminalOpen: boolean };
  isModelPickerOpen: boolean;
  setIsModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onProviderModelSelect: React.ComponentProps<
    typeof ProviderInstanceModelPicker
  >["onInstanceModelChange"];
  activePlan: import("~/session-logic").ActivePlanState | null;
  planSidebarOpen: boolean;
  canCompactConversation: boolean;
  isWorking: boolean;
  hasPendingTurnDispatch: boolean;
  showInteractionModeToggle: boolean;
  selectedProvider: "codex" | "claudeAgent" | "cursor" | "opencode" | "grok";
  runtimeMode: "auto" | "approval-required" | "auto-accept-edits" | "full-access";
  threadId: import("@t3tools/contracts").ThreadId;
  selectedModel: string;
  showClaudeTraitsControls: boolean;
  selectedProviderModels: React.ComponentProps<typeof ClaudeTraitsPicker>["models"];
  selectedProviderModelOptions: React.ComponentProps<typeof ClaudeTraitsPicker>["modelOptions"];
  genericProviderTraitsMenuContent: React.ReactNode;
  onCompactConversation: () => Promise<void>;
  toggleInteractionMode: () => void;
  togglePlanSidebar: () => void;
  handleRuntimeModeChange: (
    mode: "auto" | "approval-required" | "auto-accept-edits" | "full-access",
  ) => void;
  genericProviderTraitsPicker: React.ReactNode;
  isPreparingWorktree: boolean;
  pendingComposerImageImportCount: number;
  onPreviousActivePendingUserInputQuestion: () => void;
  activePendingIsResponding: boolean;
  activePendingResolvedAnswers: Record<
    string,
    import("~/pendingUserInput").PendingUserInputAnswerValue
  > | null;
  composerSendState: {
    trimmedPrompt: string;
    sendableTerminalContexts: import("~/lib/terminalContext").TerminalContextDraft[];
    expiredTerminalContextCount: number;
    hasSendableContent: boolean;
  };
  isComposerSendBusy: boolean;
  composerSendBusyLabel: "Preparing image" | "Sending";
  nextTurnQueueState: import("~/nextTurnQueueStore").NextTurnQueueThreadState;
  isServerThread: boolean;
  onInterrupt: () => Promise<void>;
  isComposerImageImportPending: boolean;
  isSendBusy: boolean;
  planningMergeWorkflow: unknown | null;
  canImplementMergeFromChat: boolean;
  setWorkflowImplementDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onImplementPlanInNewThread: () => Promise<void>;
}

export function ChatComposer({
  composerFormRef,
  onSend,
  isDragOverComposer,
  interactionMode,
  onComposerDragEnter,
  onComposerDragOver,
  onComposerDragLeave,
  onComposerDrop,
  onComposerFileMentionDragEnterCapture,
  onComposerFileMentionDragOverCapture,
  onComposerFileMentionDragLeaveCapture,
  onComposerFileMentionDropCapture,
  activePendingApproval,
  pendingApprovals,
  pendingUserInputs,
  respondingRequestIds,
  activePendingDraftAnswers,
  activePendingQuestionIndex,
  onSelectActivePendingUserInputOption,
  onToggleActivePendingUserInputOption,
  onAdvanceActivePendingUserInput,
  showPlanFollowUpPrompt,
  activeProposedPlan,
  hasComposerHeader,
  composerMenuOpen,
  isComposerApprovalState,
  composerMenuItems,
  resolvedTheme,
  isComposerMenuLoading,
  composerTriggerKind,
  activeComposerMenuItem,
  onComposerMenuItemHighlighted,
  onSelectComposerItem,
  composerImages,
  usesCustomImageContextMenu,
  onImageActionMenu,
  setExpandedImage,
  nonPersistedComposerImageIdSet,
  removeComposerImage,
  isPendingTurnDispatchBlocked,
  composerFilePaths,
  activeThread,
  activeProject,
  removeComposerFilePath,
  composerEditorRef,
  activePendingProgress,
  prompt,
  composerCursor,
  composerTerminalContexts,
  removeComposerTerminalContextFromDraft,
  onPromptChange,
  onComposerCommandKey,
  onComposerPaste,
  phase,
  isConnecting,
  onRespondToApproval,
  isComposerFooterCompact,
  selectedProviderInstanceId,
  selectedModelForPickerWithCustomFallback,
  hasThreadStarted,
  modelOptionsByInstance,
  isClaudeUltrathink,
  providerStatuses,
  keybindings,
  terminalState,
  isModelPickerOpen,
  setIsModelPickerOpen,
  onProviderModelSelect,
  activePlan,
  planSidebarOpen,
  canCompactConversation,
  isWorking,
  hasPendingTurnDispatch,
  showInteractionModeToggle,
  selectedProvider,
  runtimeMode,
  threadId,
  selectedModel,
  showClaudeTraitsControls,
  selectedProviderModels,
  selectedProviderModelOptions,
  genericProviderTraitsMenuContent,
  onCompactConversation,
  toggleInteractionMode,
  togglePlanSidebar,
  handleRuntimeModeChange,
  genericProviderTraitsPicker,
  isPreparingWorktree,
  pendingComposerImageImportCount,
  onPreviousActivePendingUserInputQuestion,
  activePendingIsResponding,
  activePendingResolvedAnswers,
  composerSendState,
  isComposerSendBusy,
  composerSendBusyLabel,
  nextTurnQueueState,
  isServerThread,
  onInterrupt,
  isComposerImageImportPending,
  isSendBusy,
  planningMergeWorkflow,
  canImplementMergeFromChat,
  setWorkflowImplementDialogOpen,
  onImplementPlanInNewThread,
}: ChatComposerProps) {
  return (
    <form
      ref={composerFormRef}
      onSubmit={onSend}
      className="mx-auto w-full min-w-0 max-w-3xl"
      data-chat-composer-form="true"
    >
      <div
        data-chat-composer-shell="true"
        className={cn(
          "group rounded-[20px] border bg-card transition-colors duration-200",
          isDragOverComposer
            ? "border-primary/70 bg-accent/30"
            : interactionMode === "plan"
              ? "border-warning/10 focus-within:border-warning/45"
              : "border-border focus-within:border-ring/45",
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onDragEnterCapture={onComposerFileMentionDragEnterCapture}
        onDragOverCapture={onComposerFileMentionDragOverCapture}
        onDragLeaveCapture={onComposerFileMentionDragLeaveCapture}
        onDropCapture={onComposerFileMentionDropCapture}
      >
        {activePendingApproval ? (
          <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
            <ComposerPendingApprovalPanel
              approval={activePendingApproval}
              pendingCount={pendingApprovals.length}
            />
          </div>
        ) : pendingUserInputs.length > 0 ? (
          <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
            <ComposerPendingUserInputPanel
              pendingUserInputs={pendingUserInputs}
              respondingRequestIds={respondingRequestIds}
              answers={activePendingDraftAnswers}
              questionIndex={activePendingQuestionIndex}
              onSelectOption={onSelectActivePendingUserInputOption}
              onToggleOption={onToggleActivePendingUserInputOption}
              onAdvance={onAdvanceActivePendingUserInput}
            />
          </div>
        ) : showPlanFollowUpPrompt && activeProposedPlan ? (
          <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
            <ComposerPlanFollowUpBanner
              key={activeProposedPlan.id}
              planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
            />
          </div>
        ) : null}

        {/* Textarea area */}
        <div
          className={cn(
            "relative px-3 pb-2 sm:px-4",
            hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
          )}
        >
          {composerMenuOpen && !isComposerApprovalState && (
            <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
              <ComposerCommandMenu
                items={composerMenuItems}
                resolvedTheme={resolvedTheme}
                isLoading={isComposerMenuLoading}
                triggerKind={composerTriggerKind}
                activeItemId={activeComposerMenuItem?.id ?? null}
                onHighlightedItemChange={onComposerMenuItemHighlighted}
                onSelect={onSelectComposerItem}
              />
            </div>
          )}

          {!isComposerApprovalState && pendingUserInputs.length === 0 && (
            <>
              {composerImages.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                    >
                      {image.previewUrl ? (
                        <button
                          type="button"
                          className="h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${image.name}`}
                          onContextMenu={(event) => {
                            if (!usesCustomImageContextMenu || !image.previewUrl) return;
                            event.preventDefault();
                            event.stopPropagation();
                            onImageActionMenu(
                              {
                                src: image.previewUrl,
                                name: image.name,
                                mimeType: image.mimeType,
                                sourceBlob: image.file,
                              },
                              { x: event.clientX, y: event.clientY },
                            );
                          }}
                          onClick={() => {
                            const preview = buildExpandedImagePreview(composerImages, image.id);
                            if (!preview) return;
                            setExpandedImage(preview);
                          }}
                        >
                          <img
                            src={image.previewUrl}
                            alt={image.name}
                            className="h-full w-full object-cover"
                            draggable={false}
                          />
                        </button>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                          {image.name}
                        </div>
                      )}
                      {nonPersistedComposerImageIdSet.has(image.id) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                aria-label="Draft attachment may not persist"
                                className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                              >
                                <CircleAlertIcon className="size-3" />
                              </span>
                            }
                          />
                          <TooltipPopup
                            side="top"
                            className="max-w-64 whitespace-normal leading-tight"
                          >
                            Draft attachment could not be saved locally and may be lost on
                            navigation.
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                        onClick={() => removeComposerImage(image.id)}
                        aria-label={`Remove ${image.name}`}
                        disabled={isPendingTurnDispatchBlocked}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {composerFilePaths.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {composerFilePaths.map((filePath) => {
                    const displayPath = relativePathForDisplay(
                      filePath,
                      activeThread?.worktreePath ?? activeProject?.cwd,
                    );
                    return (
                      <span
                        key={filePath}
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-1 text-[12px] text-foreground"
                        title={displayPath}
                      >
                        <VscodeEntryIcon
                          pathValue={filePath}
                          kind="file"
                          theme={resolvedTheme}
                          className="size-3.5"
                        />
                        <span className="max-w-[200px] truncate">
                          {basenameOfPath(displayPath)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeComposerFilePath(filePath)}
                          disabled={isPendingTurnDispatchBlocked}
                          aria-label={`Remove ${displayPath}`}
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          )}
          <ComposerPromptEditor
            ref={composerEditorRef}
            value={
              isComposerApprovalState
                ? ""
                : activePendingProgress
                  ? activePendingProgress.customAnswer
                  : prompt
            }
            cursor={composerCursor}
            terminalContexts={
              !isComposerApprovalState && pendingUserInputs.length === 0
                ? composerTerminalContexts
                : []
            }
            onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
            onChange={onPromptChange}
            onCommandKeyDown={onComposerCommandKey}
            onPaste={onComposerPaste}
            placeholder={
              isComposerApprovalState
                ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                : activePendingProgress
                  ? "Type your own answer, or leave this blank to use the selected option"
                  : showPlanFollowUpPrompt && activeProposedPlan
                    ? "Add feedback to refine the plan, or leave this blank to implement it"
                    : phase === "disconnected"
                      ? "Ask for follow-up changes or attach files"
                      : "Ask anything, @tag files/folders, or use / for skills and slash commands"
            }
            disabled={isConnecting || isComposerApprovalState || isPendingTurnDispatchBlocked}
          />
        </div>

        {/* Bottom toolbar */}
        {activePendingApproval ? (
          <div className="flex flex-wrap items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
            <ComposerPendingApprovalActions
              requestId={activePendingApproval.requestId}
              requestKind={activePendingApproval.requestKind}
              approvalOptions={activePendingApproval.approvalOptions}
              canApprove={
                activePendingApproval.requestKind !== "permission" ||
                activePendingApproval.requestedPermissions !== undefined
              }
              isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
              onRespondToApproval={onRespondToApproval}
            />
          </div>
        ) : (
          <div
            data-chat-composer-footer="true"
            className={cn(
              "flex items-center justify-between px-2.5 pb-2.5 sm:px-3 sm:pb-3",
              isComposerFooterCompact ? "gap-1.5" : "flex-wrap gap-2 sm:flex-nowrap sm:gap-0",
            )}
          >
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center",
                isComposerFooterCompact
                  ? "-m-1 gap-1 overflow-hidden p-1"
                  : "-m-1 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              )}
            >
              {/* Provider/model picker */}
              <ProviderInstanceModelPicker
                compact={isComposerFooterCompact}
                instanceId={selectedProviderInstanceId}
                model={selectedModelForPickerWithCustomFallback}
                lockedInstanceId={hasThreadStarted ? selectedProviderInstanceId : null}
                modelOptionsByInstance={modelOptionsByInstance}
                ultrathinkActive={isClaudeUltrathink}
                providers={providerStatuses}
                keybindings={keybindings}
                terminalOpen={Boolean(terminalState.terminalOpen)}
                open={isModelPickerOpen}
                onOpenChange={setIsModelPickerOpen}
                disabled={isPendingTurnDispatchBlocked}
                onInstanceModelChange={onProviderModelSelect}
              />

              {isComposerFooterCompact ? (
                <CompactComposerControlsMenu
                  activePlan={Boolean(activePlan || activeProposedPlan || planSidebarOpen)}
                  canCompactConversation={canCompactConversation}
                  compactConversationDisabled={isWorking || hasPendingTurnDispatch}
                  disabled={isPendingTurnDispatchBlocked}
                  interactionMode={interactionMode}
                  showInteractionModeToggle={showInteractionModeToggle}
                  planSidebarOpen={planSidebarOpen}
                  provider={selectedProvider}
                  runtimeMode={runtimeMode}
                  traitsMenuContent={
                    selectedProvider === "codex" ? (
                      <CodexTraitsMenuContent threadId={threadId} model={selectedModel} />
                    ) : showClaudeTraitsControls ? (
                      <ClaudeTraitsMenuContent
                        threadId={threadId}
                        model={selectedModel}
                        models={selectedProviderModels}
                        modelOptions={selectedProviderModelOptions}
                      />
                    ) : (
                      genericProviderTraitsMenuContent
                    )
                  }
                  onCompactConversation={onCompactConversation}
                  onToggleInteractionMode={toggleInteractionMode}
                  onTogglePlanSidebar={togglePlanSidebar}
                  onRuntimeModeChange={handleRuntimeModeChange}
                />
              ) : (
                <>
                  {selectedProvider === "codex" ? (
                    <>
                      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                      <CodexTraitsPicker threadId={threadId} model={selectedModel} />
                    </>
                  ) : showClaudeTraitsControls ? (
                    <>
                      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                      <ClaudeTraitsPicker
                        threadId={threadId}
                        model={selectedModel}
                        models={selectedProviderModels}
                        modelOptions={selectedProviderModelOptions}
                      />
                    </>
                  ) : genericProviderTraitsPicker ? (
                    <>
                      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                      {genericProviderTraitsPicker}
                    </>
                  ) : null}

                  {showInteractionModeToggle ? (
                    <>
                      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                      <Button
                        variant="ghost"
                        className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                        size="sm"
                        type="button"
                        onClick={toggleInteractionMode}
                        disabled={isPendingTurnDispatchBlocked}
                        title={
                          interactionMode === "plan"
                            ? "Plan mode — click to return to normal chat mode"
                            : "Default mode — click to enter plan mode"
                        }
                      >
                        {interactionMode === "plan" ? <NotebookPenIcon /> : <BotIcon />}
                        <span className="sr-only sm:not-sr-only">
                          {interactionMode === "plan" ? "Plan" : "Agent"}
                        </span>
                      </Button>
                    </>
                  ) : null}

                  <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                  <RuntimeModePicker
                    disabled={isPendingTurnDispatchBlocked}
                    provider={selectedProvider}
                    value={runtimeMode}
                    onValueChange={handleRuntimeModeChange}
                  />

                  {activePlan || activeProposedPlan || planSidebarOpen ? (
                    <>
                      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                      <Button
                        variant="ghost"
                        className={cn(
                          "shrink-0 whitespace-nowrap px-2 sm:px-3",
                          planSidebarOpen
                            ? "text-blue-400 hover:text-blue-300"
                            : "text-muted-foreground/70 hover:text-foreground/80",
                        )}
                        size="sm"
                        type="button"
                        onClick={togglePlanSidebar}
                        disabled={isPendingTurnDispatchBlocked}
                        title={planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
                      >
                        <ListTodoIcon />
                        <span className="sr-only sm:not-sr-only">Plan</span>
                      </Button>
                    </>
                  ) : null}
                </>
              )}
            </div>

            {/* Right side: send / stop button */}
            <div data-chat-composer-actions="right" className="flex shrink-0 items-center gap-2">
              {isPreparingWorktree ? (
                <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
              ) : null}
              {pendingComposerImageImportCount > 0 ? (
                <span className="text-muted-foreground/70 text-xs">
                  Preparing {pendingComposerImageImportCount === 1 ? "image" : "images"}
                  ...
                </span>
              ) : null}
              {activePendingProgress ? (
                <div className="flex items-center gap-2">
                  {activePendingProgress.questionIndex > 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full"
                      onClick={onPreviousActivePendingUserInputQuestion}
                      disabled={activePendingIsResponding}
                    >
                      Previous
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    size="sm"
                    className="rounded-full px-4"
                    disabled={
                      activePendingIsResponding ||
                      (activePendingProgress.isLastQuestion
                        ? !activePendingResolvedAnswers
                        : !activePendingProgress.canAdvance)
                    }
                  >
                    {activePendingIsResponding
                      ? "Submitting..."
                      : activePendingProgress.isLastQuestion
                        ? "Submit answers"
                        : "Next question"}
                  </Button>
                </div>
              ) : phase === "running" ? (
                <ComposerSendControl
                  running
                  hasSendableContent={composerSendState.hasSendableContent}
                  dispatchBlocked={isPendingTurnDispatchBlocked}
                  connecting={isConnecting}
                  busy={isComposerSendBusy}
                  busyLabel={composerSendBusyLabel}
                  paused={nextTurnQueueState.snapshot?.paused ?? false}
                  runnableQueueCount={
                    nextTurnQueueState.snapshot?.paused
                      ? 0
                      : (nextTurnQueueState.snapshot?.items.filter(
                          (item) => item.status !== "failed",
                        ).length ?? 0)
                  }
                  itemCount={nextTurnQueueState.snapshot?.items.length ?? 0}
                  maxItems={nextTurnQueueState.snapshot?.maxItems ?? 20}
                  serverThread={isServerThread}
                  onIntent={(intent) => void onSend(undefined, intent)}
                  onInterrupt={() => void onInterrupt()}
                />
              ) : pendingUserInputs.length === 0 ? (
                showPlanFollowUpPrompt ? (
                  prompt.trim().length > 0 ? (
                    <Button
                      type="submit"
                      size="sm"
                      className="h-9 rounded-full px-4 sm:h-8"
                      disabled={
                        isPendingTurnDispatchBlocked || isConnecting || isComposerImageImportPending
                      }
                    >
                      {isComposerImageImportPending
                        ? "Preparing..."
                        : isConnecting || isSendBusy
                          ? "Sending..."
                          : "Refine"}
                    </Button>
                  ) : (
                    <>
                      {planningMergeWorkflow != null ? (
                        canImplementMergeFromChat ? (
                          <Button
                            type="button"
                            size="sm"
                            className="h-9 rounded-full px-4 sm:h-8"
                            onClick={() => setWorkflowImplementDialogOpen(true)}
                            disabled={isComposerImageImportPending}
                          >
                            Implement
                          </Button>
                        ) : null
                      ) : (
                        <div className="flex items-center">
                          <Button
                            type="submit"
                            size="sm"
                            className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                            disabled={
                              isPendingTurnDispatchBlocked ||
                              isConnecting ||
                              isComposerImageImportPending
                            }
                          >
                            {isComposerImageImportPending
                              ? "Preparing..."
                              : isConnecting || isSendBusy
                                ? "Sending..."
                                : "Implement"}
                          </Button>
                          <Menu>
                            <MenuTrigger
                              render={
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                  aria-label="Implementation actions"
                                  disabled={
                                    isPendingTurnDispatchBlocked ||
                                    isConnecting ||
                                    isComposerImageImportPending
                                  }
                                />
                              }
                            >
                              <ChevronDownIcon className="size-3.5" />
                            </MenuTrigger>
                            <MenuPopup align="end" side="top">
                              <MenuItem
                                disabled={
                                  isPendingTurnDispatchBlocked ||
                                  isConnecting ||
                                  isComposerImageImportPending
                                }
                                onClick={() => void onImplementPlanInNewThread()}
                              >
                                Implement in a new thread
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </div>
                      )}
                    </>
                  )
                ) : (
                  <ComposerSendControl
                    running={false}
                    hasSendableContent={composerSendState.hasSendableContent}
                    dispatchBlocked={isPendingTurnDispatchBlocked}
                    connecting={isConnecting}
                    busy={isComposerSendBusy || isPreparingWorktree}
                    busyLabel={isPreparingWorktree ? "Preparing worktree" : composerSendBusyLabel}
                    paused={nextTurnQueueState.snapshot?.paused ?? false}
                    runnableQueueCount={
                      nextTurnQueueState.snapshot?.paused
                        ? 0
                        : (nextTurnQueueState.snapshot?.items.filter(
                            (item) => item.status !== "failed",
                          ).length ?? 0)
                    }
                    itemCount={nextTurnQueueState.snapshot?.items.length ?? 0}
                    maxItems={nextTurnQueueState.snapshot?.maxItems ?? 20}
                    serverThread={isServerThread}
                    onIntent={(intent) => void onSend(undefined, intent)}
                    onInterrupt={() => void onInterrupt()}
                  />
                )
              ) : null}
            </div>
          </div>
        )}
      </div>
    </form>
  );
}
