import { useComposerScrollCollapse } from "./useComposerScrollCollapse";
import { composerAttachmentStatus } from "~/lib/attachmentValidation";
import { AttachmentUploadProgress } from "./AttachmentUploadProgress";
import { PopupFocusContext } from "~/components/ui/popupFocus";
import { type ComposerMention, insertComposerMentionTrigger } from "~/composer-editor-mentions";
import { recallComposerMentions } from "~/composerMentionHistoryStore";
import { collapseExpandedComposerCursor } from "~/composer-logic";
import { useAppSettings } from "~/appSettings";
import { useEffect, useRef, useId } from "react";
import { isKeyboardEventComposing } from "~/lib/keyboardComposition";
import { stepPromptHistory, type PromptHistoryPosition } from "./promptHistory";
import type * as React from "react";
import { proposedPlanTitle } from "~/proposedPlan";
import { basenameOfPath } from "~/vscode-icons";
import { CircleAlertIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { ComposerPromptEditor } from "~/components/ComposerPromptEditor";
import { buildExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { ComposerCommandMenu } from "~/components/chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "~/components/chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "~/components/chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "~/components/chat/ComposerPlanFollowUpBanner";
import { FileChip } from "~/components/chat/FileChip";
import type {
  ComposerAttachments,
  ComposerModeControls,
  ComposerModelControls,
  ComposerPendingInteraction,
  ComposerSendControls,
} from "./composerControls";
import { ComposerFooterControls } from "./ComposerFooterControls";
import { ComposerPrimaryAction } from "./ComposerPrimaryAction";
import { ContextMeter } from "./ContextMeter";
import { contextUsageSummaryLine, type ComposerTokenUsage } from "./contextMeter.logic";
import { composerSendShortcutLabel } from "./sendShortcut";
import { isMacPlatform } from "~/lib/utils";

export interface ChatComposerProps {
  redesignEnabled: boolean;
  getTimeline: () => HTMLElement | null;
  composerFormRef: React.RefObject<HTMLFormElement | null>;
  composerEditorRef: React.RefObject<
    import("~/components/ComposerPromptEditor").ComposerPromptEditorHandle | null
  >;
  threadId: import("@t3tools/contracts").ThreadId;
  activeThread: import("~/types").Thread;
  activeProject: import("~/types").Project | undefined;
  resolvedTheme: "light" | "dark";
  hasComposerHeader: boolean;
  isComposerFooterCompact: boolean;

  prompt: string;
  mentions: readonly ComposerMention[];
  composerCursor: number;
  onPromptChange: (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
    mentions: readonly ComposerMention[],
    options?: { suppressAutocomplete?: boolean },
  ) => void;
  onComposerCommandKey: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape",
    event: KeyboardEvent,
  ) => boolean;

  composerMenuOpen: boolean;
  composerMenuItems: import("~/components/chat/ComposerCommandMenu").ComposerCommandItem[];
  isComposerMenuLoading: boolean;
  composerTriggerKind: import("~/composer-logic").ComposerTriggerKind | null;
  activeComposerMenuItem:
    | import("~/components/chat/ComposerCommandMenu").ComposerCommandItem
    | null;
  onComposerMenuItemHighlighted: (itemId: string | null) => void;
  onSelectComposerItem: (
    item: import("~/components/chat/ComposerCommandMenu").ComposerCommandItem,
  ) => void;

  tokenUsage: ComposerTokenUsage;
  pendingInteraction: ComposerPendingInteraction;
  modelControls: ComposerModelControls;
  modeControls: ComposerModeControls;
  sendControls: ComposerSendControls;
  attachments: ComposerAttachments;
}

export function ChatComposer({
  redesignEnabled,
  getTimeline,
  composerFormRef,
  composerEditorRef,
  threadId,
  activeThread,
  activeProject,
  resolvedTheme,
  hasComposerHeader,
  isComposerFooterCompact,
  prompt,
  mentions,
  composerCursor,
  onPromptChange,
  onComposerCommandKey,
  composerMenuOpen,
  composerMenuItems,
  isComposerMenuLoading,
  composerTriggerKind,
  activeComposerMenuItem,
  onComposerMenuItemHighlighted,
  onSelectComposerItem,
  tokenUsage,
  pendingInteraction,
  modelControls,
  modeControls,
  sendControls,
  attachments,
}: ChatComposerProps) {
  const { settings } = useAppSettings();
  const attachmentTrayId = useId();
  const historyPosition = useRef<PromptHistoryPosition | null>(null);
  const sendShortcutLabel = composerSendShortcutLabel(
    settings.sendShortcut,
    prompt,
    isMacPlatform(navigator.platform),
  );
  const contextSummary = isComposerFooterCompact ? contextUsageSummaryLine(tokenUsage) : null;
  const {
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    respondingRequestIds,
    activePendingProgress,
    isComposerApprovalState,
  } = pendingInteraction;
  const { interactionMode, showPlanFollowUpPrompt, activeProposedPlan } = modeControls;
  const { isConnecting, isPendingTurnDispatchBlocked, phase, revertInProgress } = sendControls;
  const {
    composerImages,
    isDragOverComposer,
    composerFilePaths,
    composerTerminalContexts,
    removeComposerImage,
    removeComposerFilePath,
  } = attachments;
  const attachmentCount = composerImages.length + composerFilePaths.length;
  const attachmentStatus = composerAttachmentStatus(composerImages, modelControls.selectedProvider);
  // Opt-in redesign: a resting composer collapses on timeline scroll. Never
  // while something needs the editor (errors, menus, drafts being prepared,
  // approvals, questions, the plan follow-up).
  const { collapsed, expand } = useComposerScrollCollapse({
    enabled: redesignEnabled && settings.composerCollapseOnScroll && sendControls.isServerThread,
    threadId,
    blocked:
      !!attachmentStatus.error ||
      composerMenuOpen ||
      isDragOverComposer ||
      sendControls.isPreparingWorktree ||
      !!activePendingApproval ||
      pendingUserInputs.length > 0 ||
      showPlanFollowUpPrompt ||
      sendControls.pendingComposerImageImportCount > 0 ||
      attachments.nonPersistedComposerImageIdSet.size > 0,
    formRef: composerFormRef,
    getTimeline,
  });

  useEffect(() => {
    const focus = () => {
      const active = document.activeElement;
      if (
        collapsed ||
        isConnecting ||
        isComposerApprovalState ||
        isPendingTurnDispatchBlocked ||
        document.querySelector('[role="dialog"][data-state="open"]') ||
        (active && active !== document.body && !composerFormRef.current?.contains(active))
      )
        return;
      composerEditorRef.current?.focus();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [
    collapsed,
    composerEditorRef,
    composerFormRef,
    isConnecting,
    isComposerApprovalState,
    isPendingTurnDispatchBlocked,
  ]);

  const handleCommandKey: ChatComposerProps["onComposerCommandKey"] = (key, event) => {
    if (onComposerCommandKey(key, event)) return true;
    if (
      (key !== "ArrowUp" && key !== "ArrowDown") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      isKeyboardEventComposing(event) ||
      pendingUserInputs.length > 0 ||
      isComposerApprovalState ||
      composerMenuOpen ||
      isPendingTurnDispatchBlocked
    )
      return false;
    const current = composerEditorRef.current?.readSnapshot();
    if (!current) return false;
    const beforeCursor = current.value.slice(0, current.expandedCursor);
    const afterCursor = current.value.slice(current.expandedCursor);
    if (key === "ArrowUp" ? /[\r\n]/.test(beforeCursor) : /[\r\n]/.test(afterCursor)) return false;
    const result = stepPromptHistory({
      threadId,
      messages: activeThread.messages,
      position: historyPosition.current,
      prompt: current.value,
      direction: key === "ArrowUp" ? "up" : "down",
    });
    if (!result) return false;
    historyPosition.current = result.position;
    const restoredMentions = result.position
      ? recallComposerMentions(threadId, result.position.messageId, result.prompt)
      : [];
    onPromptChange(
      result.prompt,
      collapseExpandedComposerCursor(result.prompt, result.prompt.length, restoredMentions),
      result.prompt.length,
      false,
      current.terminalContextIds,
      restoredMentions,
      { suppressAutocomplete: true },
    );
    return true;
  };

  // Insert "@" at the caret so the file autocomplete opens, as if typed.
  const handleMentionFile = () => {
    const current = composerEditorRef.current?.readSnapshot();
    if (!current) return;
    const next = insertComposerMentionTrigger(
      current.value,
      current.expandedCursor,
      current.mentions,
    );
    const nextCursor = collapseExpandedComposerCursor(
      next.value,
      next.expandedCursor,
      next.mentions,
    );
    onPromptChange(
      next.value,
      nextCursor,
      next.expandedCursor,
      false,
      current.terminalContextIds,
      next.mentions,
    );
    composerEditorRef.current?.focusAt(nextCursor);
  };

  return (
    <PopupFocusContext
      value={() => {
        const active = document.activeElement;
        if (
          !active ||
          active === document.body ||
          composerFormRef.current?.contains(active) ||
          active.closest(
            '[data-slot="menu-popup"], [data-slot="popover-popup"], [data-slot="combobox-popup"]',
          )
        ) {
          composerEditorRef.current?.focus();
        }
        return false;
      }}
    >
      <form
        ref={composerFormRef}
        onSubmit={sendControls.onSend}
        className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width) shrink-0"
        aria-label={collapsed ? "Message composer (collapsed)" : "Message composer"}
        data-chat-composer-form="true"
        data-composer-collapsed={collapsed ? "true" : "false"}
      >
        <div
          data-chat-composer-shell="true"
          className={cn(
            "group rounded-xl border bg-card shadow-lg/5 transition-colors duration-(--duration-fast)",
            isDragOverComposer
              ? "border-primary/70 bg-accent/30"
              : interactionMode === "plan"
                ? "border-warning/40 focus-within:border-warning/60"
                : "border-border focus-within:border-ring/60",
            isComposerApprovalState && "ring-1 ring-warning/40",
          )}
          onDragEnterCapture={attachments.onComposerFileMentionDragEnterCapture}
          onDragOverCapture={attachments.onComposerFileMentionDragOverCapture}
          onDragLeaveCapture={attachments.onComposerFileMentionDragLeaveCapture}
          onDropCapture={attachments.onComposerFileMentionDropCapture}
        >
          {activePendingApproval ? (
            <div className="rounded-t-[calc(var(--radius-xl)-1px)] border-b border-border bg-muted/40">
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
            </div>
          ) : pendingUserInputs.length > 0 ? (
            <div className="rounded-t-[calc(var(--radius-xl)-1px)] border-b border-border bg-muted/40">
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={pendingInteraction.activePendingDraftAnswers}
                questionIndex={pendingInteraction.activePendingQuestionIndex}
                onSelectOption={pendingInteraction.onSelectActivePendingUserInputOption}
                onToggleOption={pendingInteraction.onToggleActivePendingUserInputOption}
                onAdvance={pendingInteraction.onAdvanceActivePendingUserInput}
              />
            </div>
          ) : showPlanFollowUpPrompt && activeProposedPlan ? (
            <div className="rounded-t-[calc(var(--radius-xl)-1px)] border-b border-border bg-muted/40">
              <ComposerPlanFollowUpBanner
                key={activeProposedPlan.id}
                planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
              />
            </div>
          ) : null}

          {/* Textarea area: never remount the editor when its layout changes. */}
          <div
            data-composer-editor-area="true"
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
            )}
          >
            {composerMenuOpen && !isComposerApprovalState && (
              <div
                data-composer-command-drawer={redesignEnabled || undefined}
                className={cn(
                  "z-20 px-1",
                  redesignEnabled ? "relative" : "absolute inset-x-0 bottom-full mb-2",
                )}
              >
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
              <div id={attachmentTrayId} data-composer-attachment-tray="true">
                {composerImages.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {(() => {
                      const status = attachmentStatus;
                      return status.error || status.notice ? (
                        <p
                          role={status.error ? "alert" : "status"}
                          className="w-full text-xs text-muted-foreground"
                        >
                          {status.error ?? status.notice}
                        </p>
                      ) : null;
                    })()}
                    {composerImages.map((image) => (
                      <div
                        key={image.id}
                        className="relative size-16 overflow-hidden rounded-lg border border-border bg-background"
                      >
                        {image.type === "image" && image.previewUrl ? (
                          <button
                            type="button"
                            className="h-full w-full cursor-zoom-in"
                            aria-label={`Preview ${image.name}`}
                            onContextMenu={(event) => {
                              if (!attachments.usesCustomImageContextMenu || !image.previewUrl)
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              attachments.onImageActionMenu(
                                {
                                  src: image.previewUrl,
                                  name: image.name,
                                  mimeType: image.mimeType,
                                  ...(image.uploadId ? {} : { sourceBlob: image.file }),
                                },
                                { x: event.clientX, y: event.clientY },
                              );
                            }}
                            onClick={() => {
                              const preview = buildExpandedImagePreview(composerImages, image.id);
                              if (!preview) return;
                              attachments.setExpandedImage(preview);
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
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-2xs text-muted-foreground">
                            {image.name}
                          </div>
                        )}
                        <AttachmentUploadProgress image={image} threadId={threadId} />
                        {attachments.nonPersistedComposerImageIdSet.has(image.id) && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label="Draft attachment may not persist"
                                  className="absolute left-1 top-1 inline-flex items-center justify-center rounded-sm bg-background/85 p-0.5 text-warning-foreground"
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
                        <FileChip
                          key={filePath}
                          path={filePath}
                          label={basenameOfPath(displayPath)}
                          title={displayPath}
                          theme={resolvedTheme}
                          className="max-w-60"
                          onRemove={() => removeComposerFilePath(filePath)}
                          removeDisabled={isPendingTurnDispatchBlocked}
                          removeLabel={`Remove ${displayPath}`}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {collapsed && attachmentCount > 0 ? (
              <button
                type="button"
                className="mb-1 flex animate-fade-in items-center gap-1 text-xs text-muted-foreground"
                onClick={expand}
                aria-expanded={false}
                aria-controls={attachmentTrayId}
              >
                <PaperclipIcon className="size-3" />
                {attachmentCount} {attachmentCount === 1 ? "attachment" : "attachments"}
              </button>
            ) : null}
            <ComposerPromptEditor
              richTextEnabled={settings.composerRichTextEnabled}
              ref={composerEditorRef}
              mentions={
                isComposerApprovalState
                  ? []
                  : activePendingProgress
                    ? (activePendingProgress.activeDraft?.mentions ?? [])
                    : mentions
              }
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
              onRemoveTerminalContext={attachments.removeComposerTerminalContextFromDraft}
              onChange={onPromptChange}
              onCommandKeyDown={handleCommandKey}
              onPaste={attachments.onComposerPaste}
              placeholder={
                isComposerApprovalState
                  ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                  : activePendingProgress
                    ? "Type your own answer, or leave this blank to use the selected option"
                    : showPlanFollowUpPrompt && activeProposedPlan
                      ? "Add feedback to refine the plan, or leave this blank to implement it"
                      : revertInProgress
                        ? "Reverting… you can type, sending resumes when it's done"
                        : phase === "disconnected" && modelControls.hasThreadStarted
                          ? "Ask for follow-up changes or attach files"
                          : "Ask F5 to build, fix, or explain... (@ files, / commands)"
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
                defaultToNo={activePendingApproval.presentation?.defaultToNo}
                suppressAlwaysAllowRule={
                  activePendingApproval.presentation?.suppressAlwaysAllowRule
                }
                canApprove={
                  activePendingApproval.requestKind !== "permission" ||
                  activePendingApproval.requestedPermissions !== undefined
                }
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={pendingInteraction.onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              className={cn(
                "@container/composer-footer flex w-full items-center justify-between px-2 pb-2",
                isComposerFooterCompact ? "gap-1.5" : "flex-wrap gap-2 sm:flex-nowrap sm:gap-1",
              )}
            >
              <ComposerFooterControls
                threadId={threadId}
                compact={isComposerFooterCompact}
                isComposerApprovalState={isComposerApprovalState}
                model={modelControls}
                mode={modeControls}
                send={sendControls}
                onAttachFiles={(files) => {
                  // Attaching expands a scroll-collapsed composer (redesign).
                  expand();
                  attachments.onAttachFiles(files);
                }}
                onMentionFile={handleMentionFile}
                contextSummary={contextSummary}
              />
              <ComposerPrimaryAction
                prompt={prompt}
                send={sendControls}
                mode={modeControls}
                pending={pendingInteraction}
                sendShortcutLabel={sendShortcutLabel}
                leading={isComposerFooterCompact ? null : <ContextMeter tokenUsage={tokenUsage} />}
              />
            </div>
          )}
        </div>
      </form>
    </PopupFocusContext>
  );
}
