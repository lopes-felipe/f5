import {
  CommandId,
  MessageId,
  type NextTurnQueueResendAuthFailedTurnInput,
  type NextTurnQueueResendAuthFailedTurnResult,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { authFailureKey } from "@t3tools/shared/usageLimit";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/**
 * The user message an expired login rejected: the one sent with the failed turn,
 * or else the last user message sent before the failure.
 */
export function failedTurnUserMessage(
  thread: Pick<OrchestrationThread, "messages">,
  failure: { readonly turnId: string | null; readonly occurredAt: string },
): OrchestrationMessage | null {
  const userMessages = thread.messages.filter((message) => message.role === "user");
  if (failure.turnId) {
    const match = userMessages.findLast((message) => message.turnId === failure.turnId);
    if (match) return match;
  }
  return userMessages.findLast((message) => message.createdAt <= failure.occurredAt) ?? null;
}

/**
 * Resend the turn an expired login rejected. The provider never saw it, so the
 * original words and attachments go again rather than a "continue". The command
 * id is derived from the failure, so repeated clicks dedupe on command receipts.
 */
export const resendAuthFailedTurn = (
  engine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">,
  input: NextTurnQueueResendAuthFailedTurnInput,
  now: () => string = () => new Date().toISOString(),
) =>
  Effect.gen(function* () {
    const ineligible = (reason: string): NextTurnQueueResendAuthFailedTurnResult => ({
      kind: "ineligible",
      reason,
    });
    const thread = (yield* engine.getReadModel()).threads.find(
      (entry) => entry.id === input.threadId,
    );
    const failure = thread?.session?.authFailure ?? null;
    const key = authFailureKey(failure);
    if (!thread || thread.deletedAt || thread.archivedAt || !failure || !key)
      return ineligible("No turn is waiting on a sign-in.");
    if (key !== input.expectedFailureKey)
      return ineligible("The failure changed. Refresh and try again.");
    if (
      thread.session?.activeTurnId ||
      thread.session?.status === "running" ||
      thread.session?.status === "starting"
    )
      return { kind: "busy", reason: "The thread is still busy." } as const;
    const message = failedTurnUserMessage(thread, failure);
    if (!message || (!message.text.trim() && !message.attachments?.length))
      return ineligible("The failed message could not be found.");
    const commandId = CommandId.makeUnsafe(`auth-resend:${thread.id}:${key}`);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId: thread.id,
      message: {
        messageId: MessageId.makeUnsafe(commandId),
        role: "user",
        text: message.text,
        ...(message.skillCall ? { skillCall: message.skillCall } : {}),
        attachments: message.attachments ?? [],
      },
      model: thread.model,
      ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: now(),
    });
    return { kind: "sent" } as const;
  });
