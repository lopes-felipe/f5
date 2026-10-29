import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  prunableUserInputRequestIds,
  usePendingUserInputDraftStore,
} from "./pendingUserInputDraftStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

const store = () => usePendingUserInputDraftStore.getState();

beforeEach(() => {
  usePendingUserInputDraftStore.setState({
    answersByThreadId: {},
    questionIndexByThreadId: {},
    asyncDraftsByThreadId: {},
  });
});

describe("usePendingUserInputDraftStore", () => {
  it("keeps answers and question positions per thread", () => {
    store().setAnswers(THREAD_A, { request: { q1: { customAnswer: "typed" } } });
    store().setAnswers(THREAD_B, (existing) => ({
      ...existing,
      request: { q1: { selectedOptionLabels: ["Option"] } },
    }));
    store().setQuestionIndex(THREAD_A, (existing) => ({ ...existing, request: 1 }));

    expect(store().answersByThreadId).toEqual({
      [THREAD_A]: { request: { q1: { customAnswer: "typed" } } },
      [THREAD_B]: { request: { q1: { selectedOptionLabels: ["Option"] } } },
    });
    expect(store().questionIndexByThreadId).toEqual({ [THREAD_A]: { request: 1 } });
  });

  it("does not notify subscribers for unchanged updates", () => {
    store().setAnswers(THREAD_A, { request: {} });
    const before = store();
    store().setAnswers(THREAD_A, (existing) => existing);
    store().setQuestionIndex(THREAD_A, (existing) => existing);
    store().pruneRequests(THREAD_A, ["missing"]);
    store().pruneRequests(THREAD_A, []);
    expect(store()).toBe(before);
  });

  it("prunes only the resolved requests of one thread", () => {
    store().setAnswers(THREAD_A, {
      resolved: { q1: { customAnswer: "done" } },
      open: { q1: { customAnswer: "keep" } },
    });
    store().setQuestionIndex(THREAD_A, { resolved: 2, open: 1 });
    store().setAnswers(THREAD_B, { resolved: { q1: { customAnswer: "other thread" } } });

    store().pruneRequests(THREAD_A, ["resolved"]);

    expect(store().answersByThreadId).toEqual({
      [THREAD_A]: { open: { q1: { customAnswer: "keep" } } },
      [THREAD_B]: { resolved: { q1: { customAnswer: "other thread" } } },
    });
    expect(store().questionIndexByThreadId).toEqual({ [THREAD_A]: { open: 1 } });

    store().pruneRequests(THREAD_A, ["open"]);
    expect(store().answersByThreadId).toEqual({
      [THREAD_B]: { resolved: { q1: { customAnswer: "other thread" } } },
    });
    expect(store().questionIndexByThreadId).toEqual({});
  });

  it("keeps message-question drafts per request and drops them on demand", () => {
    const draft = { answers: { q1: ["A"] }, custom: {}, customOpen: {}, questionIndex: 1 };
    store().updateAsyncDraft(THREAD_A, "message", () => draft);
    store().updateAsyncDraft(THREAD_A, "other", (current) => current);
    expect(store().asyncDraftsByThreadId).toEqual({ [THREAD_A]: { message: draft } });

    store().pruneRequests(THREAD_A, ["message"]);
    expect(store().asyncDraftsByThreadId).toEqual({});

    store().updateAsyncDraft(THREAD_A, "message", () => draft);
    store().updateAsyncDraft(THREAD_A, "message", () => undefined);
    expect(store().asyncDraftsByThreadId).toEqual({});
  });
});

describe("prunableUserInputRequestIds", () => {
  beforeEach(() => {
    store().setAnswers(THREAD_A, {
      pending: { q1: { customAnswer: "still open" } },
      selected: { q1: { selectedOptionLabels: ["Option"] } },
      typed: { q1: { customAnswer: "typed" } },
      resolvedTyped: { q1: { customAnswer: "typed" } },
    });
    store().setQuestionIndex(THREAD_A, { position: 1 });
    store().updateAsyncDraft(THREAD_A, "message", () => ({
      answers: {},
      custom: { q1: "typed" },
      customOpen: { q1: true },
      questionIndex: 0,
    }));
  });

  const prunable = (threadLoaded: boolean) =>
    prunableUserInputRequestIds(store(), THREAD_A, {
      pendingRequestIds: ["pending"],
      resolvedRequestIds: ["resolvedTyped", "pending"],
      threadLoaded,
    }).toSorted();

  it("drops only visibly resolved requests until the thread is loaded", () => {
    expect(prunable(false)).toEqual(["resolvedTyped"]);
  });

  it("keeps typed blocking answers that still await their dismissal", () => {
    expect(prunable(true)).toEqual(["message", "position", "resolvedTyped", "selected"]);
  });
});
