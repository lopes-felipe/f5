/**
 * The `interaction` MCP catalog: `ask_user_question` shows the agent's
 * questions as F5's question card and returns the user's answers, and
 * `wait_for_user_answer` keeps waiting for a question still open.
 *
 * Offered to agents with no native question channel F5 can show (Antigravity).
 * Antigravity cancels an MCP tool call after three minutes, and progress
 * notifications do not extend that, so one call waits at most
 * `INTERACTION_WAIT_MS`. It then returns `pending` with the question's id,
 * the card stays open, and the agent waits again with `wait_for_user_answer`.
 *
 * @module mcp/interactionMcpTools
 */
import { z } from "zod";

import type { McpToolResult } from "./previewMcpTools.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const WAIT_FOR_USER_ANSWER_TOOL_NAME = "wait_for_user_answer";
export const INTERACTION_TOOL_NAMES = [
  ASK_USER_QUESTION_TOOL_NAME,
  WAIT_FOR_USER_ANSWER_TOOL_NAME,
] as const;

/** How long one tool call waits for the answer: under Antigravity's three-minute call limit. */
export const INTERACTION_WAIT_MS = 150_000;

export interface InteractionQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}

export type InteractionOutcome =
  | { readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>> }
  | { readonly cancelled: true };

/** The session side of the catalog: the provider adapter that owns the thread. */
export interface InteractionSession {
  /**
   * Shows the questions as F5's question card. The card stays open until the
   * user answers or dismisses it, or the turn that asked ends.
   */
  readonly openQuestion: (
    questions: ReadonlyArray<InteractionQuestion>,
  ) => Promise<{ readonly questionId: string } | { readonly cancelled: true }>;
  /** Settles with the question's outcome; `undefined` for an id this session does not know. */
  readonly questionOutcome: (questionId: string) => Promise<InteractionOutcome> | undefined;
}

const text = (max: number) => z.string().trim().min(1).max(max);

// Not strict: Antigravity adds its own `toolSummary` to every tool call's arguments.
const AskUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: text(2_000),
        header: text(40),
        options: z
          .array(z.object({ label: text(200), description: text(1_000) }))
          .min(2)
          .max(4),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(4),
});

const WaitForUserAnswerInput = z.object({ questionId: text(200) });

export const WAIT_FOR_USER_ANSWER_TOOL = {
  name: WAIT_FOR_USER_ANSWER_TOOL_NAME,
  title: "Wait for the user's answer",
  description:
    "Keep waiting for the answer to a question ask_user_question returned as pending. Call it again with the same questionId while it returns pending. Do not ask the question again.",
  inputSchema: {
    type: "object",
    properties: {
      questionId: {
        type: "string",
        description: "The questionId ask_user_question or this tool returned.",
      },
    },
    required: ["questionId"],
  },
  annotations: { title: "Wait for the user's answer", readOnlyHint: true, openWorldHint: false },
} as const;

export const ASK_USER_QUESTION_TOOL = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  title: "Ask the user",
  description:
    "Ask the user one to four multiple-choice questions and wait for the answers. Use it whenever the user must choose between options, instead of asking in prose. The user can also type their own answer. If the user has not answered within a few minutes, the result is pending with a questionId: then call wait_for_user_answer with it.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The full question." },
            header: {
              type: "string",
              maxLength: 40,
              description: "A short label for the question, such as 'Auth method'.",
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The choice, in a few words." },
                  description: { type: "string", description: "What the choice means." },
                },
                required: ["label", "description"],
              },
            },
            multiSelect: {
              type: "boolean",
              description: "Whether the user may pick more than one option.",
            },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },
  annotations: { title: "Ask the user", readOnlyHint: true, openWorldHint: false },
} as const;

export function parseAskUserQuestionInput(
  raw: unknown,
):
  | { readonly ok: true; readonly questions: ReadonlyArray<InteractionQuestion> }
  | { readonly ok: false; readonly message: string } {
  const parsed = AskUserQuestionInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `Invalid ask_user_question input${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}.`,
    };
  }
  const questions = parsed.data.questions;
  if (new Set(questions.map((question) => question.question)).size !== questions.length)
    return { ok: false, message: "Invalid ask_user_question input: questions must be distinct." };
  return {
    ok: true,
    questions: questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options,
      multiSelect: question.multiSelect === true,
    })),
  };
}

function result(value: Record<string, unknown>, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

const CANCELLED = {
  cancelled: true,
  message: "The user did not answer. Continue without the answer, or ask in your reply.",
} as const;

/** Waits up to `waitMs` for the question's outcome; past that, or on `signal`, it is pending. */
async function awaitOutcome(
  session: InteractionSession,
  questionId: string,
  signal: AbortSignal,
  waitMs: number,
): Promise<McpToolResult> {
  const outcome = session.questionOutcome(questionId);
  if (!outcome) return result({ error: `No question with id ${questionId}.` }, true);
  let release = () => {};
  const pending = new Promise<"pending">((resolve) => {
    const timer = setTimeout(() => resolve("pending"), waitMs);
    const abort = () => resolve("pending");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    release = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
  });
  try {
    const settled = await Promise.race([outcome, pending]);
    if (settled === "pending")
      return result({
        pending: true,
        questionId,
        message: `The user has not answered yet, and the question is still open. Call ${WAIT_FOR_USER_ANSWER_TOOL_NAME} with this questionId to keep waiting. Do not ask again.`,
      });
    return "cancelled" in settled ? result(CANCELLED) : result({ answers: settled.answers });
  } finally {
    release();
  }
}

export async function callInteractionTool(
  session: InteractionSession | undefined,
  name: string,
  raw: unknown,
  signal: AbortSignal,
  options: { readonly waitMs?: number } = {},
): Promise<McpToolResult> {
  const waitMs = options.waitMs ?? INTERACTION_WAIT_MS;
  if (name === WAIT_FOR_USER_ANSWER_TOOL_NAME) {
    if (!session) return result({ error: "F5 cannot show questions for this session." }, true);
    const input = WaitForUserAnswerInput.safeParse(raw);
    if (!input.success)
      return result({ error: "Invalid wait_for_user_answer input: questionId is required." }, true);
    return awaitOutcome(session, input.data.questionId, signal, waitMs);
  }
  if (name !== ASK_USER_QUESTION_TOOL_NAME) return result({ error: `Unknown tool: ${name}` }, true);
  if (!session) return result({ error: "F5 cannot show questions for this session." }, true);
  const input = parseAskUserQuestionInput(raw);
  if (!input.ok) return result({ error: input.message }, true);
  const opened = await session.openQuestion(input.questions);
  if ("cancelled" in opened) return result(CANCELLED);
  return awaitOutcome(session, opened.questionId, signal, waitMs);
}
