import type {
  CommandId,
  MessageId,
  OrchestrationCommand,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { Cause, Effect } from "effect";

// Each enabled driver must pass exact-completion and killed-server history-recovery tests.
// Runtime-local histories cannot repair a lost buffer; Claude currently fails that gate.
export const COALESCE_STREAMING_DELTAS_DRIVERS: ReadonlySet<ProviderKind> = new Set(["codex"]);
export type AssistantDeltaCommand = Extract<
  OrchestrationCommand,
  { type: "thread.message.assistant.delta" }
>;
const FLUSH_BYTES = 2 * 1024;
const FLUSH_MS = 40;

export function makeStreamingAssistantDeltas<E>(
  dispatch: (command: AssistantDeltaCommand) => Effect.Effect<unknown, E>,
  enqueueFlush: (threadId: ThreadId, messageId: MessageId, commandId: CommandId) => void,
  isPermanentRejection: (cause: Cause.Cause<E>) => boolean = () => false,
) {
  interface Batch {
    command: AssistantDeltaCommand;
    bytes: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    frozen: boolean;
  }
  const threads = new Map<ThreadId, Map<MessageId, Batch>>();
  // Once a prefix was dropped, later text must wait for the authoritative
  // completion. Persisting a suffix alone would prevent prefix-based recovery.
  const awaitingCompletion = new Map<ThreadId, Set<MessageId>>();
  const forgetMessage = (threadId: ThreadId, messageId: MessageId) => {
    const messages = awaitingCompletion.get(threadId);
    messages?.delete(messageId);
    if (messages?.size === 0) awaitingCompletion.delete(threadId);
  };
  const forgetThread = (threadId: ThreadId) => {
    awaitingCompletion.delete(threadId);
  };
  const clearTimer = (batch: Batch) => {
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    batch.timer = undefined;
  };
  const flush = (
    threadId: ThreadId,
    messageId: MessageId,
    expectedId?: CommandId,
  ): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      const messages = threads.get(threadId);
      const batch = messages?.get(messageId);
      if (!batch || (expectedId !== undefined && batch.command.commandId !== expectedId)) return;
      clearTimer(batch);
      // Freeze once. Neither retries nor newer deltas can modify this payload/id.
      batch.frozen = true;
      const command = Object.freeze({ ...batch.command });
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* dispatch(command).pipe(Effect.exit);
        if (result._tag === "Success") {
          messages!.delete(messageId);
          if (messages!.size === 0) threads.delete(threadId);
          return;
        }
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
        if (attempt === 2 || isPermanentRejection(result.cause)) {
          messages!.delete(messageId);
          if (messages!.size === 0) threads.delete(threadId);
          const waiting = awaitingCompletion.get(threadId) ?? new Set<MessageId>();
          waiting.add(messageId);
          awaitingCompletion.set(threadId, waiting);
          yield* Effect.logWarning(
            "dropping rejected streaming batch; native completion can recover assistant text",
            {
              threadId,
              messageId,
              commandId: command.commandId,
              cause: Cause.pretty(result.cause),
            },
          );
          return;
        }
        yield* Effect.sleep(10 * 2 ** attempt);
      }
    });
  const append = (command: AssistantDeltaCommand): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      if (awaitingCompletion.get(command.threadId)?.has(command.messageId)) return;
      let messages = threads.get(command.threadId);
      let batch = messages?.get(command.messageId);
      if (batch?.frozen) {
        yield* flush(command.threadId, command.messageId);
        if (awaitingCompletion.get(command.threadId)?.has(command.messageId)) return;
        batch = undefined;
        messages = threads.get(command.threadId);
      }
      if (!messages) {
        messages = new Map();
        threads.set(command.threadId, messages);
      }
      if (!batch) {
        batch = { command: { ...command }, bytes: 0, timer: undefined, frozen: false };
        messages.set(command.messageId, batch);
        batch.timer = setTimeout(
          () => enqueueFlush(command.threadId, command.messageId, command.commandId),
          FLUSH_MS,
        );
        batch.timer.unref?.();
      } else {
        batch.command = {
          ...batch.command,
          delta: batch.command.delta + command.delta,
          reasoningDelta: (batch.command.reasoningDelta ?? "") + (command.reasoningDelta ?? ""),
        };
      }
      batch.bytes +=
        Buffer.byteLength(command.delta) + Buffer.byteLength(command.reasoningDelta ?? "");
      if (batch.bytes >= FLUSH_BYTES) yield* flush(command.threadId, command.messageId);
    });
  const flushThread = (threadId: ThreadId) =>
    Effect.forEach([...(threads.get(threadId)?.keys() ?? [])], (id) => flush(threadId, id), {
      discard: true,
    });
  const flushAll = () =>
    Effect.forEach(
      [...threads.keys()],
      (threadId) =>
        flushThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("streaming flush failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { discard: true },
    );
  const cancelTimers = () => {
    for (const messages of threads.values())
      for (const batch of messages.values()) clearTimer(batch);
  };
  return { append, flush, flushThread, flushAll, cancelTimers, forgetMessage, forgetThread };
}
