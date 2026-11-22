import {
  CommandId,
  MessageId,
  ThreadTurnStartRequestedPayload,
  type NextTurnQueueResendAuthFailedTurnInput,
  type NextTurnQueueResendAuthFailedTurnResult,
  type OrchestrationThread,
  type ThreadTurnStartCommand,
  type TurnId,
} from "@t3tools/contracts";
import { holdsAutomaticResume } from "@t3tools/shared/pendingUserInputs";
import { authFailureKey } from "@t3tools/shared/usageLimit";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "./Services/NextTurnQueueStore.ts";
import { canonicalRequestHash } from "./canonicalRequestHash.ts";
import { threadHasBlockedWork } from "./restartTurns.ts";

/** Activity kinds that mean the turn already did work the provider would repeat. */
const EXECUTION_ACTIVITY_PREFIXES = [
  "tool.",
  "task.",
  "subagent.",
  "approval.",
  "approval-review.",
  "user-input.",
  "turn.plan.",
] as const;

/**
 * Whether the failed turn did anything before the login was rejected: ran a
 * tool, asked for approval or input, or streamed assistant text. Only a turn
 * that did none of these is safe to send again unattended.
 */
export function turnStartedWork(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
  turnId: TurnId,
): boolean {
  if (
    thread.messages.some(
      (message) =>
        message.role === "assistant" && message.turnId === turnId && message.text.trim() !== "",
    )
  )
    return true;
  return thread.activities.some(
    (activity) =>
      activity.turnId === turnId &&
      EXECUTION_ACTIVITY_PREFIXES.some((prefix) => activity.kind.startsWith(prefix)),
  );
}

const decodeTurnStartRequested = Schema.decodeUnknownOption(ThreadTurnStartRequestedPayload);

const ineligible = (reason: string): NextTurnQueueResendAuthFailedTurnResult => ({
  kind: "ineligible",
  reason,
});
const busy: NextTurnQueueResendAuthFailedTurnResult = {
  kind: "busy",
  reason: "The thread is busy. Resend once it settles.",
};

function threadIsBusy(thread: OrchestrationThread): boolean {
  return (
    Boolean(thread.session?.activeTurnId) ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    Boolean(thread.pendingUserInputs?.some(holdsAutomaticResume))
  );
}

/**
 * Resend the turn an expired login rejected, as it was first sent: the same
 * message, attachments, model selection, modes and workflow execution profile,
 * all read from the failed turn's own delivery. It refuses when the turn cannot
 * be identified exactly or had already started working, since sending it again
 * would repeat that work. Admission goes through the next-turn queue inside one
 * transaction that rechecks the failure and any blocked work, so a send that
 * lands between the click and the insert wins instead of racing.
 */
export const resendAuthFailedTurn = (
  input: NextTurnQueueResendAuthFailedTurnInput,
  now: () => string = () => new Date().toISOString(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestrationEngineService;
    const store = yield* NextTurnQueueStore;
    const readThread = engine
      .getReadModel()
      .pipe(
        Effect.map((model) => model.threads.find((entry) => entry.id === input.threadId) ?? null),
      );

    const thread = yield* readThread;
    const failure = thread?.session?.authFailure ?? null;
    const key = authFailureKey(failure);
    if (!thread || thread.deletedAt || thread.archivedAt || !failure || !key)
      return ineligible("No turn is waiting on a sign-in.");
    if (key !== input.expectedFailureKey)
      return ineligible("The failure changed. Refresh and try again.");
    if (!failure.turnId)
      return ineligible("The failed turn could not be identified, so it was not resent.");
    if (turnStartedWork(thread, failure.turnId))
      return ineligible(
        "The turn had already started working before the login expired, so it was not resent. Check its state and continue from there.",
      );
    if (threadIsBusy(thread)) return busy;

    const delivery = (yield* sql<{
      readonly event: string;
    }>`SELECT event_json AS event FROM provider_turn_deliveries WHERE thread_id = ${thread.id} AND provider_turn_id = ${failure.turnId} AND json_extract(event_json, '$.type') = 'thread.turn-start-requested' ORDER BY created_at DESC LIMIT 1`)[0];
    const payload = delivery
      ? decodeTurnStartRequested(
          (() => {
            try {
              return (JSON.parse(delivery.event) as { payload?: unknown }).payload;
            } catch {
              return undefined;
            }
          })(),
        )
      : Option.none();
    if (Option.isNone(payload) || payload.value.presentation === "continuation")
      return ineligible("The failed message could not be recovered, so it was not resent.");
    const original = payload.value;
    const message = thread.messages.find(
      (entry) => entry.id === original.messageId && entry.role === "user",
    );
    if (!message || (!message.text.trim() && !message.attachments?.length))
      return ineligible("The failed message could not be recovered, so it was not resent.");

    const commandId = CommandId.makeUnsafe(`auth-resend:${thread.id}:${key}`);
    const command: ThreadTurnStartCommand = {
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
      ...(original.provider !== undefined ? { provider: original.provider } : {}),
      ...(original.model !== undefined ? { model: original.model } : {}),
      ...(original.modelSelection !== undefined ? { modelSelection: original.modelSelection } : {}),
      ...(original.modelOptions !== undefined ? { modelOptions: original.modelOptions } : {}),
      ...(original.providerOptions !== undefined
        ? { providerOptions: original.providerOptions }
        : {}),
      ...(original.assistantDeliveryMode !== undefined
        ? { assistantDeliveryMode: original.assistantDeliveryMode }
        : {}),
      runtimeMode: original.runtimeMode,
      interactionMode: original.interactionMode,
      ...(original.workflowExecutionProfile !== undefined
        ? { workflowExecutionProfile: original.workflowExecutionProfile }
        : {}),
      ...(original.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: original.sourceProposedPlan }
        : {}),
      createdAt: now(),
    };

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (yield* store.getBySubmissionId(commandId))
          return ineligible("This turn was already resent.");
        const current = yield* readThread;
        if (!current || authFailureKey(current.session?.authFailure ?? null) !== key)
          return ineligible("The failure changed. Refresh and try again.");
        if (threadIsBusy(current) || (yield* threadHasBlockedWork(current.id))) return busy;
        const result = yield* store.insertSubmission({
          submissionId: commandId,
          itemId: commandId,
          requestHash: canonicalRequestHash(command),
          command,
          atHead: false,
        });
        return result.kind === "created"
          ? ({ kind: "sent" } as const)
          : ineligible("This turn was already resent.");
      }),
    );
  });
