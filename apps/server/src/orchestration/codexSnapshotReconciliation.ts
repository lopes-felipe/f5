import { readIncompleteHistory } from "../provider/runtimePayload.ts";
import { readPersistedSessionGeneration } from "../provider/sessionCapabilities.ts";
import {
  CommandId,
  MessageId,
  type OrchestrationCommandExecution,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { Effect, Option } from "effect";

import type { ProviderThreadTurnSnapshot } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import { commandExecutionIdForRuntimeItem } from "./commandExecutionIds.ts";
import { truncateCommandTranscriptOutput } from "./outputTruncation.ts";
import { makeHistoryRecoveredSessionSet } from "./providerTerminalLifecycle.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ThreadCommandExecutionQueryShape } from "./Services/ThreadCommandExecutionQuery.ts";

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
  ].join("");
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

/** Codex keeps only a head and a tail of large command output in its saved history. */
export const CODEX_PERSISTENCE_TRUNCATION_MARKER =
  "\n... command output truncated for persistence ...\n";

const TERMINAL_COMMAND_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "declined",
  "interrupted",
]);
const ASSISTANT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "agent message",
  "assistant message",
  "assistant",
]);

function isPlainTextContent(value: unknown): boolean {
  if (value == null || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isPlainTextContent);
  const record = asRecord(value);
  if (!record) return false;
  const type = normalizeProviderSnapshotItemType(record.type);
  return ["text", "input text", "output text"].includes(type) && typeof record.text === "string";
}

interface SnapshotCommandItem {
  readonly itemId: string;
  readonly output: string;
}

type IncompleteTurnClassification =
  | {
      readonly kind: "verifiable";
      /** Agent message, command and MCP items: what recovery actually confirms. */
      readonly recoverableItems: number;
      readonly commands: ReadonlyArray<SnapshotCommandItem>;
    }
  | { readonly kind: "unsupported"; readonly itemType: string; readonly itemId?: string };

/**
 * Decides, without writing, whether every item of an interrupted turn can be
 * verified against what F5 already holds. Tool results F5 cannot compare stay
 * unsupported, and so keep the incomplete-history marker.
 */
function classifyIncompleteTurnItems(
  turn: ProviderThreadTurnSnapshot,
  thread: Pick<OrchestrationThread, "activities">,
  turnId: string,
): IncompleteTurnClassification {
  let recoverableItems = 0;
  const commands: SnapshotCommandItem[] = [];
  for (const raw of turn.items) {
    const item = asRecord(raw);
    if (!item) return { kind: "unsupported", itemType: typeof raw };
    const itemType = normalizeProviderSnapshotItemType(item.type ?? item.itemType ?? item.kind);
    const itemId = asTrimmedNonEmptyString(item.id ?? item.itemId);
    const unsupported = {
      kind: "unsupported",
      itemType,
      ...(itemId ? { itemId } : {}),
    } as const;
    if (itemType === "user message" || itemType === "user") continue;
    if (ASSISTANT_ITEM_TYPES.has(itemType)) {
      if (
        !itemId ||
        !isPlainTextContent(item.content) ||
        item.attachments !== undefined ||
        item.reasoningText !== undefined
      )
        return unsupported;
      recoverableItems++;
      continue;
    }
    if (itemType === "reasoning") {
      // Empty reasoning carries nothing to recover.
      if (
        extractTextFromProviderSnapshotContent(item.summary) !== "" ||
        extractTextFromProviderSnapshotContent(item.content) !== ""
      )
        return unsupported;
      continue;
    }
    if (itemType === "command execution") {
      const status = asString(item.status)?.toLowerCase();
      if (
        !itemId ||
        typeof item.aggregatedOutput !== "string" ||
        status === undefined ||
        !TERMINAL_COMMAND_STATUSES.has(status)
      )
        return unsupported;
      commands.push({ itemId, output: item.aggregatedOutput });
      recoverableItems++;
      continue;
    }
    if (itemType === "mcp tool call") {
      // Only verified when F5 already recorded the call's completion.
      if (
        !itemId ||
        !thread.activities.some(
          (activity) =>
            activity.kind === "tool.completed" &&
            activity.turnId === turnId &&
            readToolActivityPayload(activity.payload)?.providerItemId === itemId,
        )
      )
        return unsupported;
      recoverableItems++;
      continue;
    }
    return unsupported;
  }
  return { kind: "verifiable", recoverableItems, commands };
}

interface CommandOutputRepair {
  readonly commandExecutionId: OrchestrationCommandExecution["id"];
  readonly expectedLastUpdatedSequence: number;
  /**
   * The output the row holds once repaired, already capped like the projection caps it, so
   * the event log and every client receive at most the projected size.
   */
  readonly expected: { readonly output: string; readonly outputTruncated: boolean };
}

/**
 * The repair of a command's projected output from provider history, `"current"`
 * when the row already holds it, or undefined when the history cannot be shown
 * to extend what F5 streamed for this exact command.
 *
 * Codex saves large output as a head, a marker and a tail. When F5 streamed less than that
 * head, the repair stores Codex's copy. When F5 streamed more, it keeps everything F5 has and
 * appends the marker and Codex's tail, so no streamed text is replaced: the marker stands for
 * output neither copy holds, whose size is unknown.
 *
 * A row F5 itself already capped (streamed past the projection's 256 KiB limit) lost its
 * middle, so it cannot be compared and is never repaired automatically.
 */
export function planCommandOutputRepair(
  row: OrchestrationCommandExecution | null,
  item: SnapshotCommandItem,
  turnId: string,
): CommandOutputRepair | "current" | undefined {
  if (
    !row ||
    row.turnId !== turnId ||
    row.providerItemId !== item.itemId ||
    row.status === "running"
  )
    return undefined;
  const markerIndex = item.output.indexOf(CODEX_PERSISTENCE_TRUNCATION_MARKER);
  const codexTruncated = markerIndex >= 0;
  const head = codexTruncated ? item.output.slice(0, markerIndex) : item.output;
  const savedTail = codexTruncated ? item.output.slice(markerIndex) : "";
  const capped = (output: string) => {
    const projected = truncateCommandTranscriptOutput(output);
    return {
      output: projected.output,
      outputTruncated: projected.outputTruncated || codexTruncated,
    };
  };
  const matches = (expected: CommandOutputRepair["expected"]) =>
    row.output === expected.output && row.outputTruncated === expected.outputTruncated;
  if (matches(capped(item.output))) return "current";
  // A spliced repair already applied: F5's prefix, then Codex's marker and tail.
  if (
    codexTruncated &&
    row.outputTruncated &&
    row.output.startsWith(head) &&
    row.output.endsWith(savedTail)
  )
    return "current";
  if (row.outputTruncated) return undefined;
  let target: string;
  if (!codexTruncated) {
    if (!item.output.startsWith(row.output)) return undefined;
    target = item.output;
  } else if (head.startsWith(row.output)) {
    target = item.output;
  } else if (row.output.startsWith(head)) {
    target = `${row.output}${savedTail}`;
  } else return undefined;
  return {
    commandExecutionId: row.id,
    expectedLastUpdatedSequence: row.lastUpdatedSequence,
    expected: capped(target),
  };
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
  readonly providerService: Pick<
    ProviderServiceShape,
    "readThread" | "acknowledgeHistoryReconciliation"
  >;
  readonly providerSessionDirectory: Pick<ProviderSessionDirectoryShape, "getBinding">;
  /** Reads the projected command output that recovery verifies against provider history. */
  readonly threadCommandExecutionQuery: Pick<
    ThreadCommandExecutionQueryShape,
    "getThreadCommandExecution"
  >;
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
          // Codex-only by design. This gate is also what makes Claude turn-item
          // eviction (claudeTurnRetention.ts) safe: Claude `readThread` bodies
          // are never consumed here, so evicted (empty) turns cannot backfill
          // empty history. Do not relax this to other providers without first
          // making those providers' readThread sources retention-independent.
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

          const incomplete = readIncompleteHistory(binding.runtimePayload);
          if (incomplete) {
            candidateThreadCount++;
            // A text-only persisted turn can be verified completely. Unknown,
            // reasoning, image or tool shapes retain the marker: partial repair
            // is never proof that the whole stream was recovered.
            if (
              !incomplete.turnId ||
              currentThread.latestTurn?.turnId !== incomplete.turnId ||
              currentThread.session?.activeTurnId != null ||
              !incomplete.historyIdentity
            )
              return;
            const snapshot = yield* dependencies.providerService.readThread(threadId);
            providerReadCount++;
            const history = snapshot.history;
            if (
              !history?.origin ||
              history.provenance !== "provider-persisted" ||
              history.coverage !== "complete" ||
              history.identity !== incomplete.historyIdentity
            )
              return;
            const turn = snapshot.turns.find((entry) => entry.id === incomplete.turnId);
            if (!turn) return;
            // Tool items are verified against recorded activities, which a thread
            // archived before startup has not loaded yet.
            yield* (
              dependencies.orchestrationEngine.ensureThreadActivities?.([threadId]) ?? Effect.void
            );
            const verifiedThread = (yield* getCurrentThread(threadId)) ?? currentThread;
            // Every item must be verifiable before anything is written: partial
            // repair is never proof that the whole stream was recovered.
            const classification = classifyIncompleteTurnItems(
              turn,
              verifiedThread,
              incomplete.turnId,
            );
            if (classification.kind === "unsupported") {
              yield* Effect.logWarning(
                "incomplete Codex history contains an item that cannot be verified",
                {
                  threadId,
                  markerId: incomplete.eventId,
                  itemType: classification.itemType,
                  itemId: classification.itemId,
                },
              );
              return;
            }
            if (classification.recoverableItems === 0) return;
            const commandRepairs: CommandOutputRepair[] = [];
            for (const command of classification.commands) {
              const commandExecutionId = commandExecutionIdForRuntimeItem(threadId, command.itemId);
              const row =
                (yield* dependencies.threadCommandExecutionQuery.getThreadCommandExecution({
                  threadId,
                  commandExecutionId,
                })).commandExecution;
              const repair = planCommandOutputRepair(row, command, incomplete.turnId);
              if (repair === undefined) {
                yield* Effect.logWarning(
                  "incomplete Codex history contains an item that cannot be verified",
                  {
                    threadId,
                    markerId: incomplete.eventId,
                    itemType: "command execution",
                    itemId: command.itemId,
                  },
                );
                return;
              }
              if (repair !== "current") commandRepairs.push(repair);
            }
            const messages = assistantMessagesFromProviderSnapshotTurn(turn);
            const ids = new Set(messages.map((message) => message.messageId));
            const currentMessages = currentThread.messages.filter(
              (message) => message.role === "assistant" && message.turnId === incomplete.turnId,
            );
            if (
              currentMessages.some(
                (message) => !ids.has(message.id) || (message.reasoningText?.length ?? 0) > 0,
              )
            )
              return;
            const stillCurrent = Effect.gen(function* () {
              const latest = Option.getOrUndefined(
                yield* dependencies.providerSessionDirectory.getBinding(threadId),
              );
              const marker = readIncompleteHistory(latest?.runtimePayload);
              const thread = yield* getCurrentThread(threadId);
              return (
                latest?.providerInstanceId === history.origin!.instanceId &&
                readPersistedSessionGeneration(latest?.runtimePayload) ===
                  history.origin!.generation &&
                marker?.eventId === incomplete.eventId &&
                thread?.deletedAt === null &&
                thread.latestTurn?.turnId === incomplete.turnId &&
                thread.session?.activeTurnId == null
              );
            });
            for (const message of messages) {
              if (!(yield* stillCurrent)) return;
              const thread = yield* getCurrentThread(threadId);
              const existing = thread?.messages.find((entry) => entry.id === message.messageId);
              if (existing && !message.text.startsWith(existing.text)) return;
              if (!existing || existing.streaming || existing.text !== message.text)
                yield* dependencies.orchestrationEngine.dispatch({
                  type: "thread.message.assistant.reconcile",
                  commandId: buildSnapshotCommandId(
                    input.reason,
                    threadId,
                    turn.id,
                    "verified-history",
                  ),
                  threadId,
                  messageId: message.messageId,
                  turnId: turn.id,
                  expectedText: existing?.text ?? null,
                  expectedReasoningText: existing?.reasoningText ?? "",
                  text: message.text,
                  reasoningText: "",
                  createdAt: input.createdAt,
                });
              const repaired = (yield* getCurrentThread(threadId))?.messages.find(
                (entry) => entry.id === message.messageId,
              );
              if (!repaired || repaired.text !== message.text || repaired.streaming) return;
              backfilledMessageCount++;
            }
            for (const repair of commandRepairs) {
              if (!(yield* stillCurrent)) return;
              yield* dependencies.orchestrationEngine.dispatch({
                type: "thread.command-execution.output.reconcile",
                commandId: buildSnapshotCommandId(
                  input.reason,
                  threadId,
                  turn.id,
                  "verified-command-output",
                ),
                threadId,
                commandExecutionId: repair.commandExecutionId,
                expectedLastUpdatedSequence: repair.expectedLastUpdatedSequence,
                output: repair.expected.output,
                outputTruncated: repair.expected.outputTruncated,
                updatedAt: input.createdAt,
                createdAt: input.createdAt,
              });
              // The projection ignores a reconcile whose row moved on since the
              // preflight; that output is then not verified.
              const repaired =
                (yield* dependencies.threadCommandExecutionQuery.getThreadCommandExecution({
                  threadId,
                  commandExecutionId: repair.commandExecutionId,
                })).commandExecution;
              if (
                repaired?.output !== repair.expected.output ||
                repaired.outputTruncated !== repair.expected.outputTruncated
              )
                return;
            }
            if (!(yield* stillCurrent)) return;
            if (!dependencies.providerService.acknowledgeHistoryReconciliation) return;
            const acknowledged =
              yield* dependencies.providerService.acknowledgeHistoryReconciliation({
                threadId,
                markerId: incomplete.eventId,
                historyIdentity: incomplete.historyIdentity,
                instanceId: history.origin.instanceId,
                generation: history.origin.generation,
              });
            if (!acknowledged) return;
            // The recovery warning was kept visible only for this marker.
            const recovered = makeHistoryRecoveredSessionSet({
              thread: yield* getCurrentThread(threadId),
              markerId: incomplete.eventId,
              commandId: buildSnapshotCommandId(
                input.reason,
                threadId,
                turn.id,
                "history-recovered",
              ),
              createdAt: input.createdAt,
            });
            if (recovered) yield* dependencies.orchestrationEngine.dispatch(recovered);
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
