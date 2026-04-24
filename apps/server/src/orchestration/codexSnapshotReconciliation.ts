import { CommandId, MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProviderThreadTurnSnapshot } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmedNonEmptyString(value: unknown): string | undefined {
  const candidate = asString(value)?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeProviderSnapshotItemType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function isAssistantProviderSnapshotItem(item: Record<string, unknown>): boolean {
  const normalizedType = normalizeProviderSnapshotItemType(item.type ?? item.itemType ?? item.kind);
  // Exclude reasoning/thought items explicitly, mirroring the classifier in
  // provider/Layers/CodexAdapter.ts#toCanonicalItemType. This prevents reasoning-summary
  // content from being backfilled into the assistant message `text` column.
  //
  // Reasoning content is *not* lost by this exclusion — it's streamed through a dedicated
  // `reasoningText` column on the assistant message, and the reviewer→author handoff in
  // `workflowSharedUtils.ts#latestAssistantFeedback` is the single place that re-joins
  // `text` and `reasoningText` for downstream consumption. Keeping `text` free of reasoning
  // here ensures the rest of the system (UI surfaces, `latestAssistantText`, plan-synthesis,
  // etc.) sees only the model's public output.
  if (normalizedType.includes("reasoning") || normalizedType.includes("thought")) {
    return false;
  }
  return normalizedType.includes("assistant") || normalizedType.includes("agent message");
}

function extractTextFromProviderSnapshotContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractTextFromProviderSnapshotContent(entry)).join("");
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  const normalizedType = normalizeProviderSnapshotItemType(record.type);
  if (
    (normalizedType.length === 0 || normalizedType.includes("text")) &&
    typeof record.text === "string"
  ) {
    return record.text;
  }

  return [
    extractTextFromProviderSnapshotContent(record.content),
    extractTextFromProviderSnapshotContent(record.output),
    extractTextFromProviderSnapshotContent(record.parts),
    extractTextFromProviderSnapshotContent(record.items),
    extractTextFromProviderSnapshotContent(record.result),
    typeof record.text === "string" ? record.text : "",
    typeof record.message === "string" ? record.message : "",
    typeof record.detail === "string" ? record.detail : "",
  ].join("");
}

function extractAssistantTextFromProviderSnapshotItem(
  item: Record<string, unknown>,
): string | undefined {
  // Only pull from fields that carry the assistant's actual message text. `item.detail` and
  // `item.summary` are avoided here because on Codex reasoning items those fields hold the
  // reasoning summary — we must not leak that content into the assistant message text even
  // if item classification ever slips.
  const text = [
    extractTextFromProviderSnapshotContent(item.content),
    extractTextFromProviderSnapshotContent(item.output),
    extractTextFromProviderSnapshotContent(item.result),
    extractTextFromProviderSnapshotContent(item.message),
    typeof item.text === "string" ? item.text : "",
  ]
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

interface ProviderSnapshotAssistantMessage {
  readonly messageId: MessageId;
  readonly text: string;
}

function assistantMessagesFromProviderSnapshotTurn(
  turn: ProviderThreadTurnSnapshot,
): ReadonlyArray<ProviderSnapshotAssistantMessage> {
  const messages: ProviderSnapshotAssistantMessage[] = [];

  turn.items.forEach((rawItem, index) => {
    const item = asRecord(rawItem);
    if (!item || !isAssistantProviderSnapshotItem(item)) {
      return;
    }

    const text = extractAssistantTextFromProviderSnapshotItem(item);
    if (!text) {
      return;
    }

    const providerItemId = asTrimmedNonEmptyString(item.id) ?? asTrimmedNonEmptyString(item.itemId);
    const messageId =
      providerItemId !== undefined
        ? MessageId.makeUnsafe(`assistant:${providerItemId}`)
        : index === 0
          ? MessageId.makeUnsafe(`assistant:${turn.id}`)
          : MessageId.makeUnsafe(`assistant:${turn.id}:snapshot:${index}`);
    messages.push({
      messageId,
      text,
    });
  });

  return messages;
}

function buildSnapshotCommandId(
  source: string,
  threadId: ThreadId,
  turnId: TurnId,
  tag: string,
): CommandId {
  return CommandId.makeUnsafe(
    `provider:snapshot:${source}:${threadId}:${turnId}:${tag}:${crypto.randomUUID()}`,
  );
}

export interface CodexSnapshotReconciliationResult {
  readonly candidateThreadCount: number;
  readonly providerReadCount: number;
  readonly backfilledMessageCount: number;
}

type CodexSnapshotReconciliationMode = "complete-or-extend" | "missing-only";

export interface ReconcileCodexThreadSnapshotsInput {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly reason: string;
  readonly mode: CodexSnapshotReconciliationMode;
  readonly createdAt: string;
  readonly turnId?: TurnId;
  /**
   * When true, threads whose provider session binding is currently `stopped`
   * are not reconciled. This guards passive read paths (e.g. opening a chat)
   * from silently resurrecting a session the user explicitly stopped, because
   * `ProviderService.readThread` runs with `allowRecovery: true`. Event-driven
   * callers (`thread.started`, `turn.completed`) leave this false so a legit
   * restart can still backfill missing assistant messages.
   */
  readonly skipStoppedBindings?: boolean;
}

export interface CodexSnapshotReconciliationDependencies {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
}

export const reconcileCodexThreadSnapshots = (
  dependencies: CodexSnapshotReconciliationDependencies,
  input: ReconcileCodexThreadSnapshotsInput,
) =>
  Effect.gen(function* () {
    let candidateThreadCount = 0;
    let providerReadCount = 0;
    let backfilledMessageCount = 0;

    const uniqueThreadIds = [...new Set(input.threadIds)];

    const getCurrentThread = (threadId: ThreadId) =>
      dependencies.orchestrationEngine
        .getReadModel()
        .pipe(Effect.map((readModel) => readModel.threads.find((entry) => entry.id === threadId)));

    yield* Effect.forEach(
      uniqueThreadIds,
      (threadId) =>
        Effect.gen(function* () {
          const bindingOption = yield* dependencies.providerSessionDirectory.getBinding(threadId);
          const binding = Option.getOrUndefined(bindingOption);
          if (!binding || binding.provider !== "codex") {
            return;
          }
          if (input.skipStoppedBindings && binding.status === "stopped") {
            return;
          }

          const currentThread = yield* getCurrentThread(threadId);
          if (!currentThread || currentThread.deletedAt !== null) {
            return;
          }

          const latestTurnLooksStale =
            currentThread.latestTurn?.state === "running" &&
            currentThread.session?.activeTurnId === null &&
            currentThread.session?.status !== "running";
          const targetTurnId =
            input.turnId ??
            (currentThread.latestTurn &&
            (currentThread.latestTurn.state !== "running" || latestTurnLooksStale)
              ? currentThread.latestTurn.turnId
              : undefined);
          if (!targetTurnId) {
            return;
          }

          const assistantMessagesForTurn = currentThread.messages.filter(
            (message) => message.role === "assistant" && sameId(message.turnId, targetTurnId),
          );
          const shouldReadProviderSnapshot =
            input.mode === "complete-or-extend"
              ? assistantMessagesForTurn.length === 0 ||
                assistantMessagesForTurn.some(
                  (message) => message.streaming || message.text.length === 0,
                )
              : assistantMessagesForTurn.length === 0;
          if (!shouldReadProviderSnapshot) {
            return;
          }

          candidateThreadCount += 1;
          const providerThread = yield* dependencies.providerService.readThread(threadId);
          providerReadCount += 1;
          const providerTurn = providerThread.turns.find((turn) => sameId(turn.id, targetTurnId));
          if (!providerTurn) {
            yield* Effect.logDebug("codex snapshot reconciliation skipped missing provider turn", {
              reason: input.reason,
              threadId,
              turnId: targetTurnId,
            });
            return;
          }

          const assistantMessages = assistantMessagesFromProviderSnapshotTurn(providerTurn);
          yield* Effect.forEach(
            assistantMessages,
            (assistantMessage) =>
              Effect.gen(function* () {
                const freshThread = yield* getCurrentThread(threadId);
                const existingMessage = freshThread?.messages.find(
                  (message) => message.id === assistantMessage.messageId,
                );

                if (input.mode === "missing-only") {
                  if (existingMessage || assistantMessage.text.length === 0) {
                    return;
                  }

                  yield* dependencies.orchestrationEngine.dispatch({
                    type: "thread.message.assistant.delta",
                    commandId: buildSnapshotCommandId(
                      input.reason,
                      threadId,
                      targetTurnId,
                      "assistant-delta-backfill",
                    ),
                    threadId,
                    messageId: assistantMessage.messageId,
                    delta: assistantMessage.text,
                    turnId: targetTurnId,
                    createdAt: input.createdAt,
                  });
                  yield* dependencies.orchestrationEngine.dispatch({
                    type: "thread.message.assistant.complete",
                    commandId: buildSnapshotCommandId(
                      input.reason,
                      threadId,
                      targetTurnId,
                      "assistant-complete-backfill",
                    ),
                    threadId,
                    messageId: assistantMessage.messageId,
                    turnId: targetTurnId,
                    createdAt: input.createdAt,
                  });
                  backfilledMessageCount += 1;
                  return;
                }

                const existingText = existingMessage?.text ?? "";
                const canAppendSuffix =
                  assistantMessage.text.length === 0 ||
                  existingText.length === 0 ||
                  assistantMessage.text.startsWith(existingText);

                if (!canAppendSuffix) {
                  yield* Effect.logWarning(
                    "codex snapshot reconciliation skipped divergent assistant snapshot",
                    {
                      reason: input.reason,
                      threadId,
                      turnId: targetTurnId,
                      messageId: assistantMessage.messageId,
                    },
                  );
                  return;
                }

                const missingText = assistantMessage.text.slice(existingText.length);
                if (missingText.length > 0) {
                  yield* dependencies.orchestrationEngine.dispatch({
                    type: "thread.message.assistant.delta",
                    commandId: buildSnapshotCommandId(
                      input.reason,
                      threadId,
                      targetTurnId,
                      "assistant-delta-backfill",
                    ),
                    threadId,
                    messageId: assistantMessage.messageId,
                    delta: missingText,
                    turnId: targetTurnId,
                    createdAt: input.createdAt,
                  });
                }

                const shouldComplete =
                  missingText.length > 0 ||
                  existingMessage === undefined ||
                  existingMessage.streaming ||
                  existingMessage.text.length === 0;
                if (!shouldComplete) {
                  return;
                }

                yield* dependencies.orchestrationEngine.dispatch({
                  type: "thread.message.assistant.complete",
                  commandId: buildSnapshotCommandId(
                    input.reason,
                    threadId,
                    targetTurnId,
                    "assistant-complete-backfill",
                  ),
                  threadId,
                  messageId: assistantMessage.messageId,
                  turnId: targetTurnId,
                  createdAt: input.createdAt,
                });
                backfilledMessageCount += 1;
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
        }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

    return {
      candidateThreadCount,
      providerReadCount,
      backfilledMessageCount,
    } satisfies CodexSnapshotReconciliationResult;
  });
