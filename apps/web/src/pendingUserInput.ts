import type { UserInputQuestion } from "@t3tools/contracts";
import {
  seedPendingUserInputAnswers as seedSharedAnswers,
  togglePendingUserInputOption as toggleSharedOption,
  type PendingUserInputDraftAnswer as SharedDraftAnswer,
  type PendingUserInputProgress as SharedProgress,
} from "@t3tools/shared/pendingQuestionAnswers";
import {
  normalizeComposerMentions,
  reconcileComposerMentions,
  type ComposerMention,
} from "./composer-editor-mentions";

export {
  resolvePendingUserInputOptionValues,
  resolvePendingUserInputAnswer,
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  findFirstUnansweredPendingUserInputQuestionIndex,
  derivePendingUserInputProgress,
  type PendingUserInputAnswerValue,
} from "@t3tools/shared/pendingQuestionAnswers";

export interface PendingUserInputDraftAnswer extends SharedDraftAnswer {
  mentions?: readonly ComposerMention[];
}
export type PendingUserInputProgress = SharedProgress<PendingUserInputDraftAnswer>;

export function seedPendingUserInputAnswers(
  questions: readonly UserInputQuestion[],
  drafts: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputDraftAnswer> {
  return seedSharedAnswers(questions, drafts);
}

export function togglePendingUserInputOption(
  draft: PendingUserInputDraftAnswer | undefined,
  label: string,
): PendingUserInputDraftAnswer {
  return toggleSharedOption(draft, label);
}

export function appendPendingUserInputFileReferences(
  draft: PendingUserInputDraftAnswer | undefined,
  paths: ReadonlyArray<string>,
): PendingUserInputDraftAnswer {
  const text = [draft?.customAnswer ?? "", ...paths].filter(Boolean).join("\n");
  return setPendingUserInputCustomAnswer(draft, text, draft?.mentions);
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
  mentions?: readonly ComposerMention[],
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabels;

  const nextMentions =
    mentions === undefined
      ? reconcileComposerMentions(draft?.customAnswer ?? "", customAnswer, draft?.mentions ?? [])
      : normalizeComposerMentions(customAnswer, mentions);
  return {
    customAnswer,
    ...(nextMentions.length > 0 ? { mentions: nextMentions } : {}),
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

/** Preserve displaced answer text as a draft when an option replaces it. */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (!displaced) return prompt;
  return prompt.trim() ? `${prompt.trimEnd()}\n\n${displaced}` : displaced;
}
