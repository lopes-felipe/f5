import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
  onToggleOption,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
  onToggleOption,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const isMultiSelect = activeQuestion?.multiSelect === true;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  // Track which question the pending auto-advance was armed for so a fast
  // question switch inside the 200ms window doesn't fire `onAdvance()` with
  // an unrelated active question.
  const autoAdvanceQuestionIdRef = useRef<string | null>(null);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  // Cancel any pending auto-advance whenever the active question changes,
  // so selecting option 1 on question A and immediately navigating to
  // question B doesn't fire the advance callback against B's context.
  const activeQuestionId = activeQuestion?.id ?? null;
  useEffect(() => {
    if (
      autoAdvanceTimerRef.current !== null &&
      autoAdvanceQuestionIdRef.current !== activeQuestionId
    ) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
      autoAdvanceQuestionIdRef.current = null;
    }
  }, [activeQuestionId]);

  const selectOptionAndAutoAdvance = useCallback(
    (questionId: string, optionLabel: string) => {
      onSelectOption(questionId, optionLabel);
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceQuestionIdRef.current = questionId;
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        // Guard against firing after the active question changed in the
        // 200ms window (e.g. user clicked back to a previous question).
        if (autoAdvanceQuestionIdRef.current !== questionId) {
          autoAdvanceQuestionIdRef.current = null;
          return;
        }
        autoAdvanceQuestionIdRef.current = null;
        onAdvance();
      }, 200);
    },
    [onSelectOption, onAdvance],
  );

  // Keyboard shortcut: number keys 1-9 select corresponding option. Single-select
  // also auto-advances; multi-select toggles without advancing so the user can
  // pick several before pressing Enter (handled elsewhere) or clicking Continue.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      // If the user has started typing a custom answer in the contenteditable
      // composer, let digit keys pass through so they can type numbers.
      if (target instanceof HTMLElement && target.isContentEditable) {
        const hasCustomText = progress.customAnswer.length > 0;
        if (hasCustomText) return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      if (isMultiSelect) {
        onToggleOption(activeQuestion.id, option.label);
      } else {
        selectOptionAndAutoAdvance(activeQuestion.id, option.label);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    activeQuestion,
    isMultiSelect,
    isResponding,
    onToggleOption,
    selectOptionAndAutoAdvance,
    progress.customAnswer.length,
  ]);

  if (!activeQuestion) {
    return null;
  }

  const selectedSet = new Set(progress.selectedOptionLabels);
  const continueLabel = progress.isLastQuestion ? "Submit" : "Continue";
  const canContinue = isMultiSelect ? progress.canAdvance && !isResponding : false;

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {prompt.questions.length > 1 ? (
            <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            {activeQuestion.header}
          </span>
          {isMultiSelect ? (
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground/40 uppercase">
              Select all that apply
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">{activeQuestion.question}</p>
      <div className="mt-3 space-y-1">
        {activeQuestion.options.map((option, index) => {
          const isSelected = isMultiSelect
            ? selectedSet.has(option.label)
            : progress.selectedOptionLabels[0] === option.label;
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              aria-pressed={isMultiSelect ? isSelected : undefined}
              onClick={() => {
                if (isMultiSelect) {
                  onToggleOption(activeQuestion.id, option.label);
                } else {
                  selectOptionAndAutoAdvance(activeQuestion.id, option.label);
                }
              }}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                isSelected
                  ? "border-blue-500/40 bg-blue-500/8 text-foreground"
                  : "border-transparent bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:border-border/40",
                isResponding && "opacity-50 cursor-not-allowed",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                    isSelected
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-xs text-muted-foreground/50">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-blue-400" /> : null}
            </button>
          );
        })}
      </div>
      {isMultiSelect ? (
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            disabled={!canContinue}
            onClick={() => onAdvance()}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150",
              canContinue
                ? "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25"
                : "bg-muted/30 text-muted-foreground/40 cursor-not-allowed",
            )}
          >
            {continueLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
});
