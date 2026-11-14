import type {
  AssistantDeliveryMode,
  ClientThreadTurnStartCommand,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import {
  getMessageTextLengthIssue,
  getThreadReferenceLimitIssue,
} from "@t3tools/shared/providerInput";

import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import { getServerSendLimits } from "../protocolState";
import type { Thread } from "../types";
import {
  createUnconfirmedSubmissions,
  UNCONFIRMED_SUBMISSION_TTL_MS,
} from "./unconfirmedSubmission";
import { newCommandId, newMessageId } from "./utils";

/** The thread settings a reply is sent with: the thread's own, not a composer draft's. */
export type ThreadReplyTarget = Pick<
  Thread,
  "id" | "model" | "modelSelection" | "runtimeMode" | "interactionMode"
>;

export interface ThreadReplyInput {
  readonly thread: ThreadReplyTarget;
  readonly text: string;
  /** Defaults to the thread's mode. */
  readonly interactionMode?: ProviderInteractionMode | undefined;
  /** The plan this message implements; only sent in default mode, as the thread does. */
  readonly sourceProposedPlanId?: OrchestrationProposedPlanId | undefined;
  /** `queue-tail` waits behind the running turn instead of following the steer setting. */
  readonly intent?: "auto" | "queue-tail" | undefined;
  readonly assistantDeliveryMode?: AssistantDeliveryMode | undefined;
}

/** What the server did with the reply. */
export type ThreadReplyOutcome = "started" | "steered" | "queued";

export function buildThreadReplyCommand(input: ThreadReplyInput): ClientThreadTurnStartCommand {
  const { thread } = input;
  const interactionMode = input.interactionMode ?? thread.interactionMode;
  const commandId = newCommandId();
  return {
    type: "thread.turn.start",
    commandId,
    threadId: thread.id,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: input.text,
      attachments: [],
    },
    model: thread.model,
    ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
    ...(input.assistantDeliveryMode ? { assistantDeliveryMode: input.assistantDeliveryMode } : {}),
    runtimeMode: thread.runtimeMode,
    interactionMode,
    ...(interactionMode === "default" && input.sourceProposedPlanId
      ? { sourceProposedPlan: { threadId: thread.id, planId: input.sourceProposedPlanId } }
      : {}),
    createdAt: new Date().toISOString(),
  };
}

/** A leading `/command` or `$skill`. */
const LEADING_COMMAND_PATTERN = /^[/$][^\s/$]+(?=\s|$)/;

/**
 * Whether the text has to go through a thread's composer. The composer resolves a leading
 * command or skill against the provider's commands and the project's skills before it
 * sends; a reply sent from here goes out as the plain text it is.
 */
export function replyNeedsComposer(text: string): boolean {
  return LEADING_COMMAND_PATTERN.test(text.trim());
}

/** The composer's own limits, so an over-long reply fails here with its message. */
function replyTextIssue(text: string): string | null {
  let maxInputChars: number | undefined;
  try {
    maxInputChars = getServerSendLimits().maxInputChars;
  } catch {
    // Not known before the server's first handshake; the shared default applies.
    maxInputChars = undefined;
  }
  return (
    (getMessageTextLengthIssue(text, maxInputChars) ?? getThreadReferenceLimitIssue(text))
      ?.message ?? null
  );
}

/** What makes two replies the same message: everything but the ids and the clock. */
function replySignature(command: ClientThreadTurnStartCommand, intent: string): string {
  const { commandId: _commandId, createdAt: _createdAt, message, ...rest } = command;
  const { messageId: _messageId, ...messageRest } = message;
  return JSON.stringify([intent, rest, messageRest]);
}

/** One per thread: the reply whose response has not come back. */
const unconfirmedReplies = createUnconfirmedSubmissions<ClientThreadTurnStartCommand>({
  ttlMs: UNCONFIRMED_SUBMISSION_TTL_MS,
});

export function resetThreadRepliesForTests(): void {
  unconfirmedReplies.clear();
}

/**
 * Sends a message to an existing thread without opening it, through the same durable
 * admission as the composer. Rejects when the server did not take the message, so the
 * caller keeps the text.
 *
 * A send whose response was lost may have been accepted. Sending the same message to the
 * thread again resends that command with its ids, which the server replays instead of
 * delivering the message a second time.
 */
export async function sendThreadReply(input: ThreadReplyInput): Promise<ThreadReplyOutcome> {
  const api = readNativeApi();
  if (!api) throw new Error("F5 is not connected.");
  const textIssue = replyTextIssue(input.text);
  if (textIssue) throw new Error(textIssue);
  const intent = input.intent ?? "auto";
  const fresh = buildThreadReplyCommand(input);
  const { command, result: submission } = await unconfirmedReplies.submit({
    slot: input.thread.id,
    signature: replySignature(fresh, intent),
    build: () => fresh,
    send: (toSend) =>
      api.nextTurnQueue.submit({ submissionId: toSend.commandId, command: toSend, intent }),
  });
  if (
    submission.disposition === "canceled" ||
    submission.disposition === "cleared" ||
    submission.disposition === "rejected"
  ) {
    throw new Error(submission.detail ?? "The message was not accepted.");
  }
  if (submission.disposition === "queued") {
    // The turn has not started: the thread's composer keeps its mode until it does.
    useNextTurnQueueStore.getState().applySnapshot(submission.snapshot);
    return "queued";
  }
  // A mode picked in the thread's composer would otherwise outlive the turn that changed it.
  const drafts = useComposerDraftStore.getState();
  const draftMode = drafts.draftsByThreadId[input.thread.id]?.interactionMode;
  if (draftMode != null && draftMode !== command.interactionMode) {
    drafts.setInteractionMode(input.thread.id, command.interactionMode);
  }
  return submission.disposition;
}
