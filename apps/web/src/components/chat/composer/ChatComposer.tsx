import { useComposerScrollCollapse } from "./useComposerScrollCollapse";
import { useComposerExpandBudget } from "./useComposerExpandBudget";
import { composerAttachmentStatus } from "~/lib/attachmentValidation";
import { getAttachmentUploadState, subscribeAttachmentUploads } from "~/lib/attachmentUploadQueue";
import { AttachmentUploadProgress } from "./AttachmentUploadProgress";
import { PopupFocusContext, PopupOwnerAttributesContext } from "~/components/ui/popupFocus";
import { EXPANDED_COMPOSER_ATTRIBUTE } from "~/keybindings";
import { type ComposerMention, insertComposerMentionTrigger } from "~/composer-editor-mentions";
import { recallComposerMentions } from "~/composerMentionHistoryStore";
import { collapseExpandedComposerCursor } from "~/composer-logic";
import { type AppSettings, useAppSettingsSelector } from "~/appSettings";
import { useEffect, useRef, useId, useState, useSyncExternalStore } from "react";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { isKeyboardEventComposing } from "~/lib/keyboardComposition";
import { stepPromptHistory, type PromptHistoryPosition } from "./promptHistory";
import type * as React from "react";
import { proposedPlanTitle } from "~/proposedPlan";
import { basenameOfPath } from "~/vscode-icons";
import {
  AtSignIcon,
  CircleAlertIcon,
  Maximize2Icon,
  Minimize2Icon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { ComposerPromptEditor } from "~/components/ComposerPromptEditor";
import { buildExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import {
  ComposerCommandMenu,
  composerCommandMenuEmptyText,
  composerSuggestionOptionId,
} from "~/components/chat/ComposerCommandMenu";
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

/** Stamped on composer popups while expanded; one object so open popups don't re-render. */
const EXPANDED_POPUP_OWNER_ATTRIBUTES = { [EXPANDED_COMPOSER_ATTRIBUTE]: "true" } as const;

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

const EDITOR_SELECTOR = '[data-testid="composer-editor"]';
/** Attachments shown before "Show all N attachments". */
const ATTACHMENT_PREVIEW_LIMIT = 6;
/** A draft this long, or with this many line breaks, offers the expand toggle. */
const EXPAND_TOGGLE_MIN_CHARS = 280;
const EXPAND_TOGGLE_MIN_NEWLINES = 3;

function hasAtLeastNewlines(text: string, count: number): boolean {
  let found = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    found += 1;
    if (found >= count) return true;
  }
  return false;
}

// Only these settings re-render the composer; other setting writes keep the selection.
function selectComposerSettings(settings: AppSettings) {
  return {
    composerCollapseOnScroll: settings.composerCollapseOnScroll,
    composerRichTextEnabled: settings.composerRichTextEnabled,
    sendShortcut: settings.sendShortcut,
  };
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
  const settings = useAppSettingsSelector(selectComposerSettings);
  const attachmentTrayId = useId();
  const composerEditorId = `${useId()}-editor`;
  const composerSuggestionListId = `${useId()}-suggestions`;
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
  // The editor points at the highlighted option only while the list is on screen.
  const composerSuggestionsVisible = composerMenuOpen && !isComposerApprovalState;
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
  const dropLabel =
    attachments.composerDropKind === "reference" ? "Drop to mention" : "Drop files to attach";
  const attachmentCount = composerImages.length + composerFilePaths.length;
  const attachmentStatus = composerAttachmentStatus(composerImages, modelControls.selectedProvider);
  const attachmentUploadFailed = useSyncExternalStore(
    subscribeAttachmentUploads,
    () => composerImages.some((image) => getAttachmentUploadState(image.file)?.status === "failed"),
    () => false,
  );
  const [showAllAttachments, setShowAllAttachments] = useState(false);
  // Warnings stay in view: the disclosure opens itself while one needs attention.
  const attachmentsNeedAttention =
    !!attachmentStatus.error ||
    !!attachmentStatus.notice ||
    attachmentUploadFailed ||
    attachments.nonPersistedComposerImageIdSet.size > 0;
  const attachmentsDisclosed =
    showAllAttachments || attachmentsNeedAttention || attachmentCount <= ATTACHMENT_PREVIEW_LIMIT;
  const visibleComposerImages = attachmentsDisclosed
    ? composerImages
    : composerImages.slice(0, ATTACHMENT_PREVIEW_LIMIT);
  const visibleComposerFilePaths = attachmentsDisclosed
    ? composerFilePaths
    : composerFilePaths.slice(0, ATTACHMENT_PREVIEW_LIMIT - visibleComposerImages.length);

  // The expanded editor is a per-thread, never-persisted view state. It ends
  // (without touching the draft) when the draft empties, the room for it goes
  // away, or the composer turns into an approval or question surface.
  const expandBudget = useComposerExpandBudget(composerFormRef);
  const [expandedFor, setExpandedFor] = useState<import("@t3tools/contracts").ThreadId | null>(
    null,
  );
  if (
    expandedFor !== null &&
    (expandedFor !== threadId ||
      prompt.length === 0 ||
      expandBudget === null ||
      isComposerApprovalState ||
      pendingUserInputs.length > 0)
  ) {
    setExpandedFor(null);
  }
  const expanded =
    expandedFor === threadId &&
    prompt.length > 0 &&
    expandBudget !== null &&
    !isComposerApprovalState &&
    pendingUserInputs.length === 0;

  // Opt-in redesign: a resting composer collapses on timeline scroll. Never
  // while something needs the editor (errors, menus, drafts being prepared,
  // approvals, questions, the plan follow-up, an expanded editor).
  const { collapsed, expand } = useComposerScrollCollapse({
    enabled: redesignEnabled && settings.composerCollapseOnScroll && sendControls.isServerThread,
    threadId,
    blocked:
      expanded ||
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

  // Escape order: an open composer popup closes itself (it holds focus), then
  // ChatView dismisses suggestions, then an expanded editor shrinks.
  const handleCommandKey: ChatComposerProps["onComposerCommandKey"] = (key, event) => {
    if (key === "Escape" && isKeyboardEventComposing(event)) return false;
    if (onComposerCommandKey(key, event)) return true;
    if (key === "Escape" && expanded) {
      setExpandedFor(null);
      return true;
    }
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

  const expandToggleVisible =
    expandBudget !== null &&
    !collapsed &&
    !isComposerApprovalState &&
    pendingUserInputs.length === 0 &&
    (expanded ||
      prompt.length >= EXPAND_TOGGLE_MIN_CHARS ||
      hasAtLeastNewlines(prompt, EXPAND_TOGGLE_MIN_NEWLINES));
  const toggleExpanded = (event: React.MouseEvent<HTMLButtonElement>) => {
    setExpandedFor(expanded ? null : threadId);
    // A pointer press never took focus (see onMouseDown), so the editor kept its
    // selection. Keyboard activation moved focus here: hand it back without
    // moving the caret, which restores the editor's own selection.
    if (event.detail === 0) {
      composerFormRef.current
        ?.querySelector<HTMLElement>(EDITOR_SELECTOR)
        ?.focus({ preventScroll: true });
    }
  };

  return (
    <PopupOwnerAttributesContext value={expanded ? EXPANDED_POPUP_OWNER_ATTRIBUTES : undefined}>
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
          {...(expanded ? { [EXPANDED_COMPOSER_ATTRIBUTE]: "true" } : {})}
          style={
            expanded
              ? ({ "--composer-editor-max-height": `${expandBudget}px` } as React.CSSProperties)
              : undefined
          }
        >
          <div
            data-chat-composer-shell="true"
            className={cn(
              "group relative rounded-xl border bg-card shadow-lg/5 transition-[border-color,box-shadow,background-color] duration-(--duration-fast)",
              isDragOverComposer
                ? "border-primary/70 bg-accent/30"
                : isComposerApprovalState
                  ? "border-warning/50 ring-1 ring-warning/40"
                  : interactionMode === "plan"
                    ? "border-warning/40 focus-within:border-warning/70"
                    : "border-border focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15",
            )}
            onDragEnterCapture={attachments.onComposerFileMentionDragEnterCapture}
            onDragOverCapture={attachments.onComposerFileMentionDragOverCapture}
            onDragLeaveCapture={attachments.onComposerFileMentionDragLeaveCapture}
            onDropCapture={attachments.onComposerFileMentionDropCapture}
          >
            <div role="status" aria-atomic="true" className="sr-only">
              {isDragOverComposer ? dropLabel : ""}
            </div>
            {isDragOverComposer ? (
              <div
                aria-hidden="true"
                data-composer-drop-overlay=""
                data-drop-kind={attachments.composerDropKind}
                className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-card/90 text-sm font-medium text-foreground motion-safe:animate-fade-in"
              >
                {attachments.composerDropKind === "reference" ? (
                  <AtSignIcon className="size-4 text-primary" />
                ) : (
                  <PaperclipIcon className="size-4 text-primary" />
                )}
                {dropLabel}
              </div>
            ) : null}
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
                  cwd={threadWorkspaceCwd(activeThread, activeProject)}
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
                expandToggleVisible && "pe-9 sm:pe-9",
              )}
            >
              {expandToggleVisible ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-2 right-2 z-10 text-muted-foreground"
                        aria-label={expanded ? "Shrink editor" : "Expand editor"}
                        aria-expanded={expanded}
                        aria-controls={composerEditorId}
                        data-composer-expand-toggle=""
                        // Keeps focus (and the editor's selection) where it is.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={toggleExpanded}
                      />
                    }
                  >
                    {expanded ? (
                      <Minimize2Icon aria-hidden="true" />
                    ) : (
                      <Maximize2Icon aria-hidden="true" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {expanded ? "Shrink editor" : "Expand editor"}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <div role="status" aria-atomic="true" className="sr-only">
                {composerSuggestionsVisible && composerMenuItems.length === 0
                  ? composerCommandMenuEmptyText(isComposerMenuLoading, composerTriggerKind)
                  : ""}
              </div>
              {composerSuggestionsVisible && (
                <div
                  data-composer-command-drawer={redesignEnabled || undefined}
                  className={cn(
                    "z-20 px-1",
                    redesignEnabled ? "relative" : "absolute inset-x-0 bottom-full mb-2",
                  )}
                >
                  <ComposerCommandMenu
                    listId={composerSuggestionListId}
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
                      {visibleComposerImages.map((image) => (
                        <div
                          key={image.id}
                          className="relative size-16 overflow-hidden rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring"
                          title={image.name}
                        >
                          {image.type === "image" && image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in outline-none"
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
                            <div className="flex h-full w-full items-center justify-center overflow-hidden px-1 text-center text-2xs break-all text-muted-foreground">
                              <span className="line-clamp-3">{image.name}</span>
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
                  {visibleComposerFilePaths.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {visibleComposerFilePaths.map((filePath) => {
                        const displayPath = relativePathForDisplay(
                          filePath,
                          threadWorkspaceCwd(activeThread, activeProject),
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
                  {attachmentCount > ATTACHMENT_PREVIEW_LIMIT && !attachmentsNeedAttention ? (
                    <button
                      type="button"
                      className="mb-2 rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={showAllAttachments}
                      onClick={() => setShowAllAttachments((current) => !current)}
                    >
                      {showAllAttachments
                        ? "Show fewer attachments"
                        : `Show all ${attachmentCount} attachments`}
                    </button>
                  ) : null}
                </div>
              )}
              {collapsed && attachmentCount > 0 ? (
                <button
                  type="button"
                  className="mb-1 flex motion-safe:animate-fade-in items-center gap-1 text-xs text-muted-foreground"
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
                id={composerEditorId}
                ariaLabel="Message"
                suggestionListId={composerSuggestionListId}
                activeSuggestionId={
                  composerSuggestionsVisible &&
                  composerMenuItems.length > 0 &&
                  activeComposerMenuItem
                    ? composerSuggestionOptionId(
                        composerSuggestionListId,
                        activeComposerMenuItem.id,
                      )
                    : undefined
                }
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
                  leading={
                    isComposerFooterCompact ? null : (
                      <>
                        {sendControls.phase !== "running" && !activePendingProgress ? (
                          <span
                            data-composer-send-hint=""
                            className="hidden text-2xs whitespace-nowrap text-faint-foreground @xl/composer-footer:inline"
                          >
                            {sendShortcutLabel} to send
                          </span>
                        ) : null}
                        <ContextMeter tokenUsage={tokenUsage} />
                      </>
                    )
                  }
                />
              </div>
            )}
          </div>
        </form>
      </PopupFocusContext>
    </PopupOwnerAttributesContext>
  );
}
