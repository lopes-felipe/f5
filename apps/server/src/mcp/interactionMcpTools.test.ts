import { describe, expect, it } from "vitest";

import {
  callInteractionTool,
  parseAskUserQuestionInput,
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

  it("returns the answers, or that the user did not answer", async () => {
    const answered: InteractionSession = {
      askUserQuestion: async () => ({ answers: { "Which one?": "Option 2" } }),
    };
    expect(await callInteractionTool(answered, "ask_user_question", input, signal)).toMatchObject({
      structuredContent: { answers: { "Which one?": "Option 2" } },
    });
    const cancelled: InteractionSession = { askUserQuestion: async () => ({ cancelled: true }) };
    const result = await callInteractionTool(cancelled, "ask_user_question", input, signal);
    expect(result.structuredContent).toMatchObject({ cancelled: true });
    expect(result.isError).toBeUndefined();
  });

  it("errors for an unknown tool, a session without questions, or invalid input", async () => {
    const session: InteractionSession = { askUserQuestion: async () => ({ cancelled: true }) };
    expect((await callInteractionTool(session, "other", input, signal)).isError).toBe(true);
    expect((await callInteractionTool(undefined, "ask_user_question", input, signal)).isError).toBe(
      true,
    );
    expect((await callInteractionTool(session, "ask_user_question", {}, signal)).isError).toBe(
      true,
    );
  });
});
