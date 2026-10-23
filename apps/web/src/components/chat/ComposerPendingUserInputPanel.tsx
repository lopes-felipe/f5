import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import { UserInputQuestionStep } from "./UserInputQuestionStep";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd?: string | undefined;
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
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
      cwd={cwd}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
    />
  );
});

/** Blocking questions: custom answers are typed in the composer below. */
const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
  onToggleOption,
  onAdvance,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  if (!activeQuestion) return null;

  const isMultiSelect = activeQuestion.multiSelect === true;
  const continueLabel = progress.isLastQuestion ? "Submit" : "Continue";
  const canContinue = progress.canAdvance && !isResponding;

  return (
    <div className="px-4 py-3 sm:px-5">
      <UserInputQuestionStep
        question={activeQuestion}
        cwd={cwd}
        questionIndex={progress.questionIndex}
        questionCount={prompt.questions.length}
        selectedOptionLabels={progress.selectedOptionLabels}
        disabled={isResponding}
        customMode="composer"
        shortcutScope="document"
        hasComposerCustomAnswer={progress.customAnswer.length > 0}
        onSelectOption={(label) => onSelectOption(activeQuestion.id, label)}
        onToggleOption={(label) => onToggleOption(activeQuestion.id, label)}
        // Previous/Next live in the composer's primary action, so no header arrows.
        onAdvance={onAdvance}
        footer={
          isMultiSelect ? (
            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={!canContinue}
                onClick={() => onAdvance()}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                  canContinue
                    ? "bg-info/15 text-info-foreground hover:bg-info/25"
                    : "bg-muted/30 text-muted-foreground cursor-not-allowed",
                )}
              >
                {continueLabel}
              </button>
            </div>
          ) : null
        }
      />
    </div>
  );
});
