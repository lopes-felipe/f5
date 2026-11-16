import type { ThreadId } from "@t3tools/contracts";
import type { SetStateAction } from "react";
import { create } from "zustand";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

export type PendingUserInputAnswersByRequestId = Record<
  string,
  Record<string, PendingUserInputDraftAnswer>
>;
export type PendingUserInputQuestionIndexByRequestId = Record<string, number>;

/** Draft of a message (non-blocking) question, answered in its own panel. */
export interface AsyncUserInputDraft {
  answers: Record<string, string[]>;
  custom: Record<string, string>;
  customOpen: Record<string, boolean>;
  questionIndex: number;
}
type AsyncUserInputDraftsByRequestId = Record<string, AsyncUserInputDraft>;

interface PendingUserInputDraftState {
  answersByThreadId: Record<string, PendingUserInputAnswersByRequestId>;
  questionIndexByThreadId: Record<string, PendingUserInputQuestionIndexByRequestId>;
  asyncDraftsByThreadId: Record<string, AsyncUserInputDraftsByRequestId>;
  setAnswers: (
    threadId: ThreadId,
    update: SetStateAction<PendingUserInputAnswersByRequestId>,
  ) => void;
  setQuestionIndex: (
    threadId: ThreadId,
    update: SetStateAction<PendingUserInputQuestionIndexByRequestId>,
  ) => void;
  /** Returning `undefined` drops the request's draft. */
  updateAsyncDraft: (
    threadId: ThreadId,
    requestId: string,
    update: (current: AsyncUserInputDraft | undefined) => AsyncUserInputDraft | undefined,
  ) => void;
  /** Drops a thread's drafts for requests that are no longer pending. */
  pruneRequests: (threadId: ThreadId, requestIds: Iterable<string>) => void;
}

export const EMPTY_PENDING_USER_INPUT_ANSWERS_BY_REQUEST_ID: PendingUserInputAnswersByRequestId =
  {};
export const EMPTY_PENDING_USER_INPUT_QUESTION_INDEX_BY_REQUEST_ID: PendingUserInputQuestionIndexByRequestId =
  {};
const EMPTY_ASYNC_DRAFTS: AsyncUserInputDraftsByRequestId = {};

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
  asyncDraftsByThreadId: {},
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
  updateAsyncDraft: (threadId, requestId, update) =>
    set((state) => {
      const asyncDraftsByThreadId = updateThreadEntry(
        state.asyncDraftsByThreadId,
        threadId,
        EMPTY_ASYNC_DRAFTS,
        (drafts) => {
          const current = drafts[requestId];
          const next = update(current);
          if (next === current) return drafts;
          if (next !== undefined) return { ...drafts, [requestId]: next };
          return omitKeys(drafts, new Set([requestId]));
        },
      );
      return asyncDraftsByThreadId === state.asyncDraftsByThreadId
        ? state
        : { asyncDraftsByThreadId };
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
      const asyncDraftsByThreadId = updateThreadEntry(
        state.asyncDraftsByThreadId,
        threadId,
        EMPTY_ASYNC_DRAFTS,
        (entry) => omitKeys(entry, resolved),
      );
      return answersByThreadId === state.answersByThreadId &&
        questionIndexByThreadId === state.questionIndexByThreadId &&
        asyncDraftsByThreadId === state.asyncDraftsByThreadId
        ? state
        : { answersByThreadId, questionIndexByThreadId, asyncDraftsByThreadId };
    }),
}));

/**
 * Requests whose drafts can go. With a loaded thread, anything no longer pending
 * goes, except typed blocking answers: a turn end drops the request before its
 * dismissal arrives, and that answer still has to be carried into the composer.
 */
export function prunableUserInputRequestIds(
  state: Pick<
    PendingUserInputDraftState,
    "answersByThreadId" | "questionIndexByThreadId" | "asyncDraftsByThreadId"
  >,
  threadId: ThreadId,
  input: {
    readonly pendingRequestIds: Iterable<string>;
    readonly resolvedRequestIds: Iterable<string>;
    readonly threadLoaded: boolean;
  },
): string[] {
  const pending = new Set(input.pendingRequestIds);
  const resolved = new Set(input.resolvedRequestIds);
  const answers =
    state.answersByThreadId[threadId] ?? EMPTY_PENDING_USER_INPUT_ANSWERS_BY_REQUEST_ID;
  const requestIds = new Set([
    ...Object.keys(answers),
    ...Object.keys(state.questionIndexByThreadId[threadId] ?? {}),
    ...Object.keys(state.asyncDraftsByThreadId[threadId] ?? {}),
  ]);
  return [...requestIds].filter((requestId) => {
    if (pending.has(requestId)) return false;
    if (resolved.has(requestId)) return true;
    if (!input.threadLoaded) return false;
    return !Object.values(answers[requestId] ?? {}).some((answer) => answer.customAnswer?.trim());
  });
}
