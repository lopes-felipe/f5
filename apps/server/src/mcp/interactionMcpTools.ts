/**
 * The `interaction` MCP catalog: one tool, `ask_user_question`, that shows the
 * agent's questions as F5's question card and returns the user's answers.
 *
 * Offered to agents with no native question channel F5 can show (Antigravity).
 *
 * @module mcp/interactionMcpTools
 */
import { z } from "zod";

import type { McpToolResult } from "./previewMcpTools.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

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
  /** Resolves when the user answers, or as cancelled when `signal` aborts or the turn ends. */
  readonly askUserQuestion: (
    questions: ReadonlyArray<InteractionQuestion>,
    signal: AbortSignal,
  ) => Promise<InteractionOutcome>;
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

export const ASK_USER_QUESTION_TOOL = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  title: "Ask the user",
  description:
    "Ask the user one to four multiple-choice questions and wait for the answers. Use it whenever the user must choose between options, instead of asking in prose. The user can also type their own answer.",
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

export async function callInteractionTool(
  session: InteractionSession | undefined,
  name: string,
  raw: unknown,
  signal: AbortSignal,
): Promise<McpToolResult> {
  if (name !== ASK_USER_QUESTION_TOOL_NAME) return result({ error: `Unknown tool: ${name}` }, true);
  if (!session) return result({ error: "F5 cannot show questions for this session." }, true);
  const input = parseAskUserQuestionInput(raw);
  if (!input.ok) return result({ error: input.message }, true);
  const outcome = await session.askUserQuestion(input.questions, signal);
  return "cancelled" in outcome
    ? result({
        cancelled: true,
        message: "The user did not answer. Continue without the answer, or ask in your reply.",
      })
    : result({ answers: outcome.answers });
}
