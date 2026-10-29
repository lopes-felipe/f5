import type { ThreadId } from "@t3tools/contracts";
import type { SetStateAction } from "react";
import { create } from "zustand";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

export type PendingUserInputAnswersByRequestId = Record<
  string,
  Record<string, PendingUserInputDraftAnswer>
>;
export type PendingUserInputQuestionIndexByRequestId = Record<string, number>;

interface PendingUserInputDraftState {
  answersByThreadId: Record<string, PendingUserInputAnswersByRequestId>;
  questionIndexByThreadId: Record<string, PendingUserInputQuestionIndexByRequestId>;
  setAnswers: (
    threadId: ThreadId,
    update: SetStateAction<PendingUserInputAnswersByRequestId>,
  ) => void;
  setQuestionIndex: (
    threadId: ThreadId,
    update: SetStateAction<PendingUserInputQuestionIndexByRequestId>,
  ) => void;
  /** Drops a thread's drafts for requests that were resolved. */
  pruneRequests: (threadId: ThreadId, requestIds: Iterable<string>) => void;
}

export const EMPTY_PENDING_USER_INPUT_ANSWERS_BY_REQUEST_ID: PendingUserInputAnswersByRequestId =
  {};
export const EMPTY_PENDING_USER_INPUT_QUESTION_INDEX_BY_REQUEST_ID: PendingUserInputQuestionIndexByRequestId =
  {};

function updateThreadEntry<T extends object>(
  byThreadId: Record<string, T>,
  threadId: ThreadId,
  empty: T,
  update: SetStateAction<T>,
): Record<string, T> {
  const current = byThreadId[threadId] ?? empty;
  const next = typeof update === "function" ? (update as (value: T) => T)(current) : update;
  if (next === current) return byThreadId;
  if (Object.keys(next).length === 0) {
    if (!(threadId in byThreadId)) return byThreadId;
    const { [threadId]: _removed, ...rest } = byThreadId;
    return rest;
  }
  return { ...byThreadId, [threadId]: next };
}

function omitKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  if (!Object.keys(record).some((key) => keys.has(key))) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

/**
 * Answers and question positions for pending questions, kept for the browser
 * tab so leaving a thread (a new thread, Settings) and coming back keeps them.
 */
export const usePendingUserInputDraftStore = create<PendingUserInputDraftState>((set) => ({
  answersByThreadId: {},
  questionIndexByThreadId: {},
  setAnswers: (threadId, update) =>
    set((state) => {
      const answersByThreadId = updateThreadEntry(
        state.answersByThreadId,
        threadId,
        EMPTY_PENDING_USER_INPUT_ANSWERS_BY_REQUEST_ID,
        update,
      );
      return answersByThreadId === state.answersByThreadId ? state : { answersByThreadId };
    }),
  setQuestionIndex: (threadId, update) =>
    set((state) => {
      const questionIndexByThreadId = updateThreadEntry(
        state.questionIndexByThreadId,
        threadId,
        EMPTY_PENDING_USER_INPUT_QUESTION_INDEX_BY_REQUEST_ID,
        update,
      );
      return questionIndexByThreadId === state.questionIndexByThreadId
        ? state
        : { questionIndexByThreadId };
    }),
  pruneRequests: (threadId, requestIds) =>
    set((state) => {
      const resolved = new Set(requestIds);
      if (resolved.size === 0) return state;
      const answersByThreadId = updateThreadEntry(
        state.answersByThreadId,
        threadId,
        EMPTY_PENDING_USER_INPUT_ANSWERS_BY_REQUEST_ID,
        (entry) => omitKeys(entry, resolved),
      );
      const questionIndexByThreadId = updateThreadEntry(
        state.questionIndexByThreadId,
        threadId,
        EMPTY_PENDING_USER_INPUT_QUESTION_INDEX_BY_REQUEST_ID,
        (entry) => omitKeys(entry, resolved),
      );
      return answersByThreadId === state.answersByThreadId &&
        questionIndexByThreadId === state.questionIndexByThreadId
        ? state
        : { answersByThreadId, questionIndexByThreadId };
    }),
}));
