import { describe, expect, it } from "vitest";

import {
  callInteractionTool,
  parseAskUserQuestionInput,
  type InteractionOutcome,
  type InteractionSession,
} from "./interactionMcpTools.ts";

const question = (text: string, options = 2) => ({
  question: text,
  header: "Choice",
  options: Array.from({ length: options }, (_, index) => ({
    label: `Option ${index + 1}`,
    description: `Description ${index + 1}`,
  })),
});

describe("parseAskUserQuestionInput", () => {
  it("accepts one to four questions with two to four options, and extra fields", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [{ ...question("Which one?"), multiSelect: true }, question("And this?", 4)],
      toolSummary: "Ask the user",
    });
    expect(parsed).toEqual({
      ok: true,
      questions: [
        { ...question("Which one?"), multiSelect: true },
        { ...question("And this?", 4), multiSelect: false },
      ],
    });
  });

  it.each([
    ["no questions", { questions: [] }],
    ["five questions", { questions: ["a", "b", "c", "d", "e"].map((text) => question(text)) }],
    ["one option", { questions: [question("Which one?", 1)] }],
    ["five options", { questions: [question("Which one?", 5)] }],
    ["a blank question", { questions: [question("  ")] }],
    ["a long header", { questions: [{ ...question("Which one?"), header: "x".repeat(41) }] }],
    ["duplicate questions", { questions: [question("Same?"), question("Same?")] }],
    ["no input", undefined],
  ])("rejects %s", (_name, input) => {
    expect(parseAskUserQuestionInput(input).ok).toBe(false);
  });
});

describe("callInteractionTool", () => {
  const signal = new AbortController().signal;
  const input = { questions: [question("Which one?")] };
  const session = (
    outcome: Promise<InteractionOutcome> | undefined,
    opened: { questionId: string } | { cancelled: true } = { questionId: "q1" },
  ): InteractionSession => ({
    openQuestion: async () => opened,
    questionOutcome: (questionId) => (questionId === "q1" ? outcome : undefined),
  });

  it("returns the answers, or that the user did not answer", async () => {
    const answered = session(Promise.resolve({ answers: { "Which one?": "Option 2" } }));
    expect(await callInteractionTool(answered, "ask_user_question", input, signal)).toMatchObject({
      structuredContent: { answers: { "Which one?": "Option 2" } },
    });
    for (const cancelled of [
      session(Promise.resolve({ cancelled: true })),
      session(undefined, { cancelled: true }),
    ]) {
      const result = await callInteractionTool(cancelled, "ask_user_question", input, signal);
      expect(result.structuredContent).toMatchObject({ cancelled: true });
      expect(result.isError).toBeUndefined();
    }
  });

  it("returns pending past the wait window, then waits again by id", async () => {
    let answer!: (outcome: InteractionOutcome) => void;
    const open = session(new Promise((resolve) => (answer = resolve)));
    const first = await callInteractionTool(open, "ask_user_question", input, signal, {
      waitMs: 10,
    });
    expect(first.structuredContent).toMatchObject({ pending: true, questionId: "q1" });
    const aborted = new AbortController();
    const waiting = callInteractionTool(
      open,
      "wait_for_user_answer",
      { questionId: "q1" },
      aborted.signal,
    );
    aborted.abort();
    expect((await waiting).structuredContent).toMatchObject({ pending: true });
    const again = callInteractionTool(open, "wait_for_user_answer", { questionId: "q1" }, signal);
    answer({ answers: { "Which one?": "Option 1" } });
    expect((await again).structuredContent).toEqual({ answers: { "Which one?": "Option 1" } });
  });

  it("errors for an unknown tool or question, a session without questions, or invalid input", async () => {
    const open = session(Promise.resolve({ cancelled: true }));
    expect((await callInteractionTool(open, "other", input, signal)).isError).toBe(true);
    expect((await callInteractionTool(undefined, "ask_user_question", input, signal)).isError).toBe(
      true,
    );
    expect((await callInteractionTool(open, "ask_user_question", {}, signal)).isError).toBe(true);
    for (const args of [{}, { questionId: "unknown" }])
      expect((await callInteractionTool(open, "wait_for_user_answer", args, signal)).isError).toBe(
        true,
      );
  });
});
