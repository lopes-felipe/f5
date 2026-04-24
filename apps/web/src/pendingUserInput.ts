import type { UserInputQuestion } from "@t3tools/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

/**
 * Value shape sent to the provider for a single question. Multi-select
 * questions pass a `string[]` (preserving cardinality so labels like
 * "Docker, Compose v2" cannot be confused with two separate labels).
 * Single-answer questions pass a plain `string`.
 */
export type PendingUserInputAnswerValue = string | readonly string[];

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: PendingUserInputAnswerValue | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedLabels(labels: readonly string[] | undefined): string[] {
  if (!labels || labels.length === 0) return [];
  // Trim and filter empties; preserve insertion order, drop duplicates.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Resolve the canonical answer value for a single question draft. Returns:
 * - `string` for a custom free-text answer (which supersedes option picks)
 * - `string` for a single selected option (common case)
 * - `string[]` when multiple options are selected (e.g. multi-select), so
 *   downstream consumers preserve cardinality. Joining into a comma string
 *   here would corrupt labels that legitimately contain `, `.
 * - `null` when nothing is answered.
 */
export function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): PendingUserInputAnswerValue | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const labels = normalizeSelectedLabels(draft?.selectedOptionLabels);
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0] ?? null;
  return labels;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabels;

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

/**
 * Toggle an option for a multi-select question. If the option is already
 * selected it is removed; otherwise it is appended. Entering toggles always
 * clears any custom answer for the question, since the two are mutually
 * exclusive when resolving the final answer.
 */
export function togglePendingUserInputOption(
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  const current = normalizeSelectedLabels(draft?.selectedOptionLabels);
  const trimmed = optionLabel.trim();
  if (trimmed.length === 0) return draft ?? {};
  const next = current.includes(trimmed)
    ? current.filter((label) => label !== trimmed)
    : [...current, trimmed];
  if (next.length === 0) return {};
  return { selectedOptionLabels: next };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputAnswerValue> | null {
  const answers: Record<string, PendingUserInputAnswerValue> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(draftAnswers[question.id]) !== null ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => resolvePendingUserInputAnswer(draftAnswers[question.id]) === null,
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = resolvePendingUserInputAnswer(activeDraft);
  const customAnswer = activeDraft?.customAnswer ?? "";
  const selectedOptionLabels = normalizeSelectedLabels(activeDraft?.selectedOptionLabels);
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels,
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: resolvedAnswer !== null,
  };
}
