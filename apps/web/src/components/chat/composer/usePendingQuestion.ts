import type { ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import {
  derivePendingUserInputProgress,
  seedPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import { usePendingUserInputDraftStore } from "~/pendingUserInputDraftStore";
import type { PendingUserInput } from "~/session-logic";

export const EMPTY_PENDING_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

export function readPendingQuestion(threadId: ThreadId, request: PendingUserInput | null) {
  if (!request) return null;
  const state = usePendingUserInputDraftStore.getState();
  const answers = seedPendingUserInputAnswers(
    request.questions,
    state.answersByThreadId[threadId]?.[request.requestId] ?? EMPTY_PENDING_ANSWERS,
  );
  const index = state.questionIndexByThreadId[threadId]?.[request.requestId] ?? 0;
  return { answers, progress: derivePendingUserInputProgress(request.questions, answers, index) };
}

export function usePendingQuestion(threadId: ThreadId, request: PendingUserInput | null) {
  const answers = usePendingUserInputDraftStore((state) =>
    request
      ? (state.answersByThreadId[threadId]?.[request.requestId] ?? EMPTY_PENDING_ANSWERS)
      : EMPTY_PENDING_ANSWERS,
  );
  const index = usePendingUserInputDraftStore((state) =>
    request ? (state.questionIndexByThreadId[threadId]?.[request.requestId] ?? 0) : 0,
  );
  return useMemo(() => {
    const seeded = request ? seedPendingUserInputAnswers(request.questions, answers) : answers;
    return {
      answers: seeded,
      index,
      progress: request ? derivePendingUserInputProgress(request.questions, seeded, index) : null,
    };
  }, [answers, index, request]);
}
