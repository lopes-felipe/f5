/**
 * Antigravity asks the user through F5's `ask_user_question` MCP tool (the
 * `interaction` catalog). This module maps that tool's questions to F5's
 * question card and back, and holds the guidance F5 appends to Antigravity's
 * system prompt.
 *
 * @module provider/acp/AntigravityInteraction
 */
import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { INTERACTION_TOOL_NAMES, type InteractionQuestion } from "../../mcp/interactionMcpTools.ts";

export const ANTIGRAVITY_INTERACTION_GUIDANCE =
  "When you need the user to decide between options, call the ask_user_question tool from the F5 MCP server instead of asking in prose, and wait for the answer. If it returns pending, call wait_for_user_answer with the questionId until the answer arrives; never ask the same question again. In Plan mode, ask before finalizing the plan; then write the plan artifact as usual.";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Whether the agent honors `_meta.antigravity.systemPrompt.append` on session setup. */
export function antigravityAdvertisesSystemPromptAppend(
  init: EffectAcpSchema.InitializeResponse,
): boolean {
  const meta = record(record(init.agentCapabilities)._meta);
  return record(record(meta.antigravity).systemPrompt).append === true;
}

export function antigravityInteractionSessionMeta(
  init: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.NewSessionRequest["_meta"] {
  return antigravityAdvertisesSystemPromptAppend(init)
    ? { antigravity: { systemPrompt: { append: ANTIGRAVITY_INTERACTION_GUIDANCE } } }
    : undefined;
}

/**
 * Which of F5's question tools a call runs. Antigravity names an MCP tool
 * `mcp_<server>_<tool>` and titles its call `Run mcp_<server>_<tool>`.
 * Matched exactly, against the per-session random server name, never by prefix.
 */
export function antigravityInteractionTool(
  toolCall: { readonly title?: string | null | undefined },
  serverName: string | undefined,
): (typeof INTERACTION_TOOL_NAMES)[number] | undefined {
  if (!serverName) return undefined;
  const call = record(toolCall);
  return INTERACTION_TOOL_NAMES.find((tool) => {
    const name = `mcp_${serverName}_${tool}`;
    return call.name === name || toolCall.title === name || toolCall.title === `Run ${name}`;
  });
}

export function isAntigravityInteractionToolCall(
  toolCall: { readonly title?: string | null | undefined },
  serverName: string | undefined,
): boolean {
  return antigravityInteractionTool(toolCall, serverName) !== undefined;
}

export function antigravityInteractionQuestions(
  questions: ReadonlyArray<InteractionQuestion>,
): ReadonlyArray<UserInputQuestion> {
  return questions.map((question) => ({
    id: question.question,
    header: question.header,
    question: question.question,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
  }));
}

/**
 * The user's answers keyed by question text, as the tool returns them. A
 * null-prototype object, so a question named `__proto__` keeps its answer.
 */
export function antigravityInteractionAnswers(
  questions: ReadonlyArray<InteractionQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string | ReadonlyArray<string>> {
  const result: Record<string, string | ReadonlyArray<string>> = Object.create(null);
  for (const question of questions) {
    const value: unknown = Object.hasOwn(answers, question.question)
      ? answers[question.question]
      : undefined;
    if (Array.isArray(value)) {
      const values = value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      if (values.length > 0) result[question.question] = values;
    } else if (typeof value === "string" && value.trim()) result[question.question] = value;
  }
  return result;
}
