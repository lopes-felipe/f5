import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_INTERACTION_GUIDANCE,
  antigravityInteractionAnswers,
  antigravityInteractionSessionMeta,
  isAntigravityInteractionToolCall,
} from "./AntigravityInteraction.ts";

const questions = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "SQLite", description: "Embedded" },
    ],
    multiSelect: false,
  },
  {
    question: "Which features?",
    header: "Features",
    options: [
      { label: "Auth", description: "Sign-in" },
      { label: "Billing", description: "Payments" },
    ],
    multiSelect: true,
  },
];

describe("isAntigravityInteractionToolCall", () => {
  it("matches the exact tool of the session's own server", () => {
    const server = "f5_interaction_1a2b3c4d";
    expect(
      isAntigravityInteractionToolCall({ title: `Run mcp_${server}_ask_user_question` }, server),
    ).toBe(true);
    expect(
      isAntigravityInteractionToolCall({ title: `mcp_${server}_ask_user_question` }, server),
    ).toBe(true);
    expect(
      isAntigravityInteractionToolCall(
        { title: "Run something", name: `mcp_${server}_ask_user_question` } as never,
        server,
      ),
    ).toBe(true);
    for (const title of [
      `Run mcp_${server}_ask_user_question_and_delete`,
      `Run mcp_f5_interaction_ffffffff_ask_user_question`,
      `Run mcp_${server}_other`,
      "Run mcp_f5_interaction",
    ])
      expect(isAntigravityInteractionToolCall({ title }, server)).toBe(false);
    expect(
      isAntigravityInteractionToolCall({ title: `Run mcp_${server}_ask_user_question` }, undefined),
    ).toBe(false);
  });
});

describe("antigravityInteractionAnswers", () => {
  it("keys answers by question text and drops empty ones", () => {
    expect(
      antigravityInteractionAnswers(questions, {
        "Which database?": "SQLite",
        "Which features?": ["Auth", "", 3],
        "Not asked": "x",
      }),
    ).toEqual({ "Which database?": "SQLite", "Which features?": ["Auth"] });
    expect(antigravityInteractionAnswers(questions, { "Which database?": "  " })).toEqual({});
  });
});

describe("antigravityInteractionSessionMeta", () => {
  it("appends the guidance only for an agent that advertises it", () => {
    expect(
      antigravityInteractionSessionMeta({
        protocolVersion: 1,
        agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
      }),
    ).toEqual({ antigravity: { systemPrompt: { append: ANTIGRAVITY_INTERACTION_GUIDANCE } } });
    expect(
      antigravityInteractionSessionMeta({ protocolVersion: 1, agentCapabilities: {} }),
    ).toBeUndefined();
  });
});
