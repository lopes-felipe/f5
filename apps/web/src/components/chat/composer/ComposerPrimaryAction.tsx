import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";

import { ComposerSendControl } from "~/components/chat/ComposerSendControl";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import {
  composerQueueControlProps,
  type ComposerModeControls,
  type ComposerPendingInteraction,
  type ComposerSendControls,
} from "./composerControls";

/**
 * Right side of the composer footer: progress notes plus the one primary
 * action for the current state (answer questions, stop or queue while
 * running, refine or implement a proposed plan, or send).
 */
export function ComposerPrimaryAction(props: {
  prompt: string;
  /** Rendered before the primary action, e.g. the context meter. */
  leading?: React.ReactNode;
  sendShortcutLabel?: string | undefined;
  send: ComposerSendControls;
  mode: Pick<ComposerModeControls, "showPlanFollowUpPrompt">;
  pending: Pick<
    ComposerPendingInteraction,
    | "pendingUserInputs"
    | "activePendingProgress"
    | "activePendingIsResponding"
    | "activePendingResolvedAnswers"
    | "onPreviousActivePendingUserInputQuestion"
  >;
}) {
  const { prompt, send, mode, pending } = props;
  const {
    isPreparingWorktree,
    pendingComposerImageImportCount,
    isPendingTurnDispatchBlocked,
    isConnecting,
    isComposerImageImportPending,
    isSendBusy,
    isComposerSendBusy,
    composerSendBusyLabel,
    revertInProgress,
  } = send;
  const activePendingProgress = pending.activePendingProgress;
  const queueProps = composerQueueControlProps(send.nextTurnQueueState);
  const onIntent = (intent: Parameters<ComposerSendControls["onSend"]>[1]) =>
    void send.onSend(undefined, intent);
  const onInterrupt = () => void send.onInterrupt();
  const planActionDisabled =
    isPendingTurnDispatchBlocked || isConnecting || isComposerImageImportPending;
  const planActionLabel = (idleLabel: string) =>
    isComposerImageImportPending
      ? "Preparing..."
      : isConnecting || isSendBusy
        ? "Sending..."
        : idleLabel;

  return (
    <div data-chat-composer-actions="right" className="flex shrink-0 items-center gap-1.5">
      {isPreparingWorktree ? (
        <span className="text-2xs text-muted-foreground">Preparing worktree...</span>
      ) : null}
      {pendingComposerImageImportCount > 0 ? (
        <span className="text-2xs text-muted-foreground">
          Preparing {pendingComposerImageImportCount === 1 ? "image" : "images"}
          ...
        </span>
      ) : null}
      {props.leading}
      {activePendingProgress ? (
        <div className="flex items-center gap-2">
          {activePendingProgress.questionIndex > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={pending.onPreviousActivePendingUserInputQuestion}
              disabled={pending.activePendingIsResponding}
            >
              Previous
            </Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            className="rounded-full px-4"
            disabled={
              pending.activePendingIsResponding ||
              (activePendingProgress.isLastQuestion
                ? !pending.activePendingResolvedAnswers
                : !activePendingProgress.canAdvance)
            }
          >
            {pending.activePendingIsResponding
              ? "Submitting..."
              : activePendingProgress.isLastQuestion
                ? "Submit answers"
                : "Next question"}
          </Button>
        </div>
      ) : send.phase === "running" ? (
        <ComposerSendControl
          running
          hasSendableContent={send.composerSendState.hasSendableContent}
          dispatchBlocked={isPendingTurnDispatchBlocked}
          connecting={isConnecting}
          busy={isComposerSendBusy}
          busyLabel={composerSendBusyLabel}
          {...queueProps}
          serverThread={send.isServerThread}
          sendShortcutLabel={props.sendShortcutLabel}
          onIntent={onIntent}
          onInterrupt={onInterrupt}
        />
      ) : pending.pendingUserInputs.length === 0 ? (
        mode.showPlanFollowUpPrompt ? (
          prompt.trim().length > 0 ? (
            <Button
              type="submit"
              size="sm"
              className="h-9 rounded-full px-4 sm:h-8"
              disabled={planActionDisabled}
            >
              {planActionLabel("Refine")}
            </Button>
          ) : send.planImplementationManagedByWorkflow ? (
            send.canImplementMergeFromChat ? (
              <Button
                type="button"
                size="sm"
                className="h-9 rounded-full px-4 sm:h-8"
                onClick={() => send.setWorkflowImplementDialogOpen(true)}
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
                disabled={planActionDisabled}
              >
                {planActionLabel("Implement")}
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="default"
                      className="h-9 rounded-l-none rounded-r-full border-l-primary-foreground/20 px-2 sm:h-8"
                      aria-label="Implementation actions"
                      disabled={planActionDisabled}
                    />
                  }
                >
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" side="top">
                  <MenuItem
                    disabled={planActionDisabled}
                    onClick={() => void send.onImplementPlanInNewThread()}
                  >
                    Implement in a new thread
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          )
        ) : (
          <ComposerSendControl
            running={false}
            hasSendableContent={send.composerSendState.hasSendableContent}
            dispatchBlocked={isPendingTurnDispatchBlocked}
            connecting={isConnecting}
            busy={isComposerSendBusy || isPreparingWorktree || revertInProgress}
            busyLabel={
              isPreparingWorktree
                ? "Preparing worktree"
                : revertInProgress && !isComposerSendBusy
                  ? "Reverting"
                  : composerSendBusyLabel
            }
            {...queueProps}
            serverThread={send.isServerThread}
            sendShortcutLabel={props.sendShortcutLabel}
            onIntent={onIntent}
            onInterrupt={onInterrupt}
          />
        )
      ) : null}
    </div>
  );
}
