import type {
  AssistantDeliveryMode,
  ClientThreadTurnStartCommand,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
} from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import type { Thread } from "../types";
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

/**
 * Sends a message to an existing thread without opening it, through the same durable
 * admission as the composer. Rejects when the server did not take the message; nothing is
 * left behind then, so the caller keeps the text.
 */
export async function sendThreadReply(input: ThreadReplyInput): Promise<ThreadReplyOutcome> {
  const api = readNativeApi();
  if (!api) throw new Error("F5 is not connected.");
  const command = buildThreadReplyCommand(input);
  const submission = await api.nextTurnQueue.submit({
    submissionId: command.commandId,
    command,
    intent: input.intent ?? "auto",
  });
  if (
    submission.disposition === "canceled" ||
    submission.disposition === "cleared" ||
    submission.disposition === "rejected"
  ) {
    throw new Error(submission.detail ?? "The message was not accepted.");
  }
  if (submission.disposition === "queued") {
    useNextTurnQueueStore.getState().applySnapshot(submission.snapshot);
  }
  // A mode picked in the thread's composer would otherwise outlive the turn that changed it.
  const drafts = useComposerDraftStore.getState();
  const draftMode = drafts.draftsByThreadId[input.thread.id]?.interactionMode;
  if (draftMode != null && draftMode !== command.interactionMode) {
    drafts.setInteractionMode(input.thread.id, command.interactionMode);
  }
  return submission.disposition;
}
