import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { usePendingUserInputDraftStore } from "./pendingUserInputDraftStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

const store = () => usePendingUserInputDraftStore.getState();

beforeEach(() => {
  usePendingUserInputDraftStore.setState({ answersByThreadId: {}, questionIndexByThreadId: {} });
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
});
