import { Data, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/Layers/ProjectionPipeline.ts";
import { truncateMiddleByBytes } from "../orchestration/outputTruncation.ts";

/**
 * Event compaction: shrinks the orchestration event log once projections hold
 * the state the UI reads.
 *
 * - Command output. Output streams in as many `command-execution-output-appended`
 *   events, and the command-execution projection already keeps the durable,
 *   capped copy. Once a command has completed, its output events are replaced
 *   by one event holding a head-and-tail copy of the projected output (with the
 *   total byte count), so the projection is the one full store.
 * - Streamed messages. A message streams as many `message-sent` deltas. Once
 *   the message is final, its deltas collapse into one non-streaming event
 *   with the folded text, which replays to the same message.
 * - Command receipts of removed output events. Output commands get a random
 *   ID each (`provider:cmd-output:<uuid>`), so no redelivery can reuse one.
 *   Message receipts are kept: delta command IDs derive from provider event
 *   IDs, some of them stable, and the receipt is what stops a redelivered
 *   delta from being appended twice.
 *
 * A thread is compacted once it has been idle for an hour and has no active
 * turn, and only when every projector has applied all of its events, so the
 * rewritten events are never applied again in normal operation. Replaying the
 * log from the start (a projector rebuild) still yields every message and
 * command, with command output reduced to the compacted copy.
 *
 * The SQLite connection is shared and synchronous, so the scan is paged, every
 * write transaction covers at most {@link MAX_EVENTS_PER_TRANSACTION} events
 * (a large group is split, its kept event rewritten first), and the time
 * budget is checked between pages and transactions. Work stopped by the
 * budget resumes on the next pass: compacted groups are no longer eligible. A
 * group whose payloads cannot be parsed is skipped; a thread that fails is
 * retried after {@link FAILED_THREAD_RETRY_MS}.
 *
 * Each visit scans the thread from the start, not from its watermark: a group
 * left alone earlier (a command or message still open then) can continue past
 * the watermark, and must be compacted as a whole. Events before the watermark
 * are already compacted, so the rescan reads small payloads.
 */

export const EVENT_COMPACTION_IDLE_MS = 60 * 60 * 1_000;
/** Size of the copy of a command's output kept in the event log. */
export const COMPACTED_COMMAND_OUTPUT_MAX_BYTES = 16 * 1_024;
export const MAX_EVENTS_PER_TRANSACTION = 2_000;
export const FAILED_THREAD_RETRY_MS = 24 * 60 * 60 * 1_000;
const COMPACTED_COMMAND_OUTPUT_HEAD_BYTES = 8 * 1_024;
const SCAN_PAGE_SIZE = 1_000;
const SEQUENCES_PER_STATEMENT = 500;
const OUTPUT_COMMAND_ID_PREFIX = "provider:cmd-output:";

const OUTPUT_EVENT = "thread.command-execution-output-appended";
const MESSAGE_EVENT = "thread.message-sent";

export interface EventCompactionResult {
  readonly threadsCompacted: number;
  readonly commandOutputsCompacted: number;
  readonly messagesCompacted: number;
  readonly eventsRemoved: number;
  readonly receiptsRemoved: number;
  /** Approximate payload bytes removed from the event log. */
  readonly bytesRemoved: number;
  /** Groups left alone because a payload could not be parsed. */
  readonly groupsSkipped: number;
  /** Threads that failed; each is retried after a day. */
  readonly threadsFailed: number;
  /** False when the time budget ran out before every candidate thread was finished. */
  readonly complete: boolean;
}

export function compactCommandOutputCopy(output: string): {
  readonly chunk: string;
  readonly truncated: boolean;
} {
  const totalBytes = Buffer.byteLength(output, "utf8");
  const result = truncateMiddleByBytes(output, {
    maxBytes: COMPACTED_COMMAND_OUTPUT_MAX_BYTES,
    headBytes: COMPACTED_COMMAND_OUTPUT_HEAD_BYTES,
    marker: `\n\n[... output compacted; ${totalBytes} bytes in total ...]\n\n`,
  });
  return { chunk: result.output, truncated: result.truncated };
}

interface MessagePayload {
  readonly text: string;
  readonly reasoningText?: string;
  readonly skillCall?: unknown;
  readonly attachments?: unknown;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly [key: string]: unknown;
}

/**
 * Folds a message's `message-sent` payloads, oldest first, the way the
 * projections do: a streaming delta appends, a final payload replaces unless
 * its text is empty. Returns one final payload that replays to the same message.
 */
export function foldMessagePayloads(payloads: ReadonlyArray<MessagePayload>): MessagePayload {
  const first = payloads[0]!;
  let text = first.text;
  let reasoningText = first.reasoningText;
  let skillCall = first.skillCall;
  let attachments = first.attachments;
  for (const payload of payloads.slice(1)) {
    text = payload.streaming
      ? `${text}${payload.text}`
      : payload.text.length === 0
        ? text
        : payload.text;
    if (payload.reasoningText !== undefined) {
      reasoningText = payload.streaming
        ? `${reasoningText ?? ""}${payload.reasoningText}`
        : payload.reasoningText.length === 0
          ? reasoningText
          : payload.reasoningText;
    }
    skillCall = payload.skillCall ?? skillCall;
    attachments = payload.attachments ?? attachments;
  }
  const folded: Record<string, unknown> = {
    ...payloads[payloads.length - 1]!,
    text,
    reasoningText,
    skillCall,
    attachments,
    streaming: false,
    createdAt: first.createdAt,
  };
  for (const key of ["reasoningText", "skillCall", "attachments"]) {
    if (folded[key] === undefined) delete folded[key];
  }
  return folded as MessagePayload;
}

class MalformedEventPayload extends Data.TaggedError("MalformedEventPayload")<{
  readonly sequence: number;
  readonly cause: unknown;
}> {}

const parsePayload = <T>(
  sequence: number,
  payloadJson: string,
  isValid: (value: Record<string, unknown>) => boolean,
) =>
  Effect.try({
    try: () => {
      const value: unknown = JSON.parse(payloadJson);
      if (
        typeof value !== "object" ||
        value === null ||
        !isValid(value as Record<string, unknown>)
      ) {
        throw new Error("unexpected payload shape");
      }
      return value as T;
    },
    catch: (cause) => new MalformedEventPayload({ sequence, cause }),
  });

const isOutputPayload = (value: Record<string, unknown>) => typeof value.chunk === "string";
const isMessagePayload = (value: Record<string, unknown>) =>
  typeof value.text === "string" &&
  typeof value.streaming === "boolean" &&
  typeof value.createdAt === "string" &&
  (value.reasoningText === undefined || typeof value.reasoningText === "string");

interface EventGroup {
  readonly kind: "output" | "message";
  readonly id: string;
  readonly sequences: number[];
  /** Payload bytes of every event in the group, from the scan. */
  bytes: number;
  lastStreaming: boolean;
  lastPayloadBytes: number;
}

/**
 * One write of a group's compaction. A group's rewrite always precedes its
 * deletes, so a pass stopped between transactions leaves a log that the next
 * pass finishes and that still replays every message.
 */
type WriteOp =
  | { readonly kind: "rewrite"; readonly sequence: number; readonly payloadJson: string }
  | {
      readonly kind: "delete";
      readonly sequences: ReadonlyArray<number>;
      /** Also delete the receipts of output commands among these events. */
      readonly outputReceipts: boolean;
    };

interface PreparedGroup {
  readonly ops: ReadonlyArray<WriteOp>;
  readonly bytesRemoved: number;
}

function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const deleteOps = (sequences: ReadonlyArray<number>, outputReceipts: boolean): WriteOp[] =>
  chunks(sequences, SEQUENCES_PER_STATEMENT).map((batch) => ({
    kind: "delete",
    sequences: batch,
    outputReceipts,
  }));

const opCost = (op: WriteOp) => (op.kind === "rewrite" ? 1 : op.sequences.length);

export const compactThreadEvents = (input: {
  readonly nowMs: number;
  /** Stop starting new work after this long. */
  readonly maxDurationMs: number;
  readonly maxThreads?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deadlineMs = Date.now() + input.maxDurationMs;
    const outOfTime = () => Date.now() > deadlineMs;
    const totals = {
      threadsCompacted: 0,
      commandOutputsCompacted: 0,
      messagesCompacted: 0,
      eventsRemoved: 0,
      receiptsRemoved: 0,
      bytesRemoved: 0,
      groupsSkipped: 0,
      threadsFailed: 0,
    };

    // Events above the slowest projector's cursor are still to be projected.
    const projectorNames = Object.values(ORCHESTRATION_PROJECTOR_NAMES);
    const cursors = yield* sql<{ readonly projector: string; readonly sequence: number }>`
      SELECT projector, last_applied_sequence AS "sequence" FROM projection_state
    `;
    const cursorByProjector = new Map(cursors.map((row) => [row.projector, row.sequence]));
    const projectedThrough = Math.min(
      ...projectorNames.map((name) => cursorByProjector.get(name) ?? 0),
    );

    const nowIso = new Date(input.nowMs).toISOString();
    const idleCutoff = new Date(input.nowMs - EVENT_COMPACTION_IDLE_MS).toISOString();
    const candidates = yield* sql<{ readonly threadId: string }>`
      SELECT thread.thread_id AS "threadId"
      FROM projection_threads AS thread
      LEFT JOIN orchestration_event_compaction AS compaction
        ON compaction.thread_id = thread.thread_id
      LEFT JOIN projection_thread_sessions AS session
        ON session.thread_id = thread.thread_id
      WHERE thread.deleted_at IS NULL
        AND thread.last_interaction_at < ${idleCutoff}
        AND (compaction.retry_after IS NULL OR compaction.retry_after <= ${nowIso})
        AND (
          session.thread_id IS NULL
          OR (session.active_turn_id IS NULL AND session.status NOT IN ('starting', 'running'))
        )
        AND EXISTS (
          SELECT 1 FROM orchestration_events AS event
          WHERE event.aggregate_kind = 'thread'
            AND event.stream_id = thread.thread_id
            AND event.sequence > COALESCE(compaction.compacted_through_sequence, 0)
        )
      ORDER BY thread.last_interaction_at ASC
      LIMIT ${input.maxThreads ?? 1_000}
    `;

    const applyOp = (op: WriteOp) =>
      Effect.gen(function* () {
        if (op.kind === "rewrite") {
          yield* sql`
            UPDATE orchestration_events SET payload_json = ${op.payloadJson}
            WHERE sequence = ${op.sequence}
          `;
          return;
        }
        if (op.outputReceipts) {
          const receipts = yield* sql<{ readonly commandId: string }>`
            DELETE FROM orchestration_command_receipts
            WHERE command_id IN (
              SELECT command_id FROM orchestration_events
              WHERE sequence IN ${sql.in(op.sequences)}
                AND command_id LIKE ${`${OUTPUT_COMMAND_ID_PREFIX}%`}
            )
            RETURNING command_id AS "commandId"
          `;
          totals.receiptsRemoved += receipts.length;
        }
        const removed = yield* sql<{ readonly sequence: number }>`
          DELETE FROM orchestration_events
          WHERE sequence IN ${sql.in(op.sequences)}
          RETURNING sequence
        `;
        totals.eventsRemoved += removed.length;
      });

    const prepareOutputGroup = (group: EventGroup) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly output: string;
          readonly outputTruncated: number;
          readonly completedAt: string | null;
          readonly lastUpdatedSequence: number;
        }>`
          SELECT
            output,
            output_truncated AS "outputTruncated",
            completed_at AS "completedAt",
            last_updated_sequence AS "lastUpdatedSequence"
          FROM projection_thread_command_executions
          WHERE command_execution_id = ${group.id}
        `;
        const row = rows[0];
        const lastSequence = group.sequences[group.sequences.length - 1]!;
        if (row === undefined) {
          // No projected command (reverted away, or never recorded): its output
          // events change nothing, during replay included.
          return {
            ops: deleteOps(group.sequences, true),
            bytesRemoved: group.bytes,
          } satisfies PreparedGroup;
        }
        if (row.completedAt === null || row.lastUpdatedSequence < lastSequence) return null;
        const lastRows = yield* sql<{ readonly payloadJson: string }>`
          SELECT payload_json AS "payloadJson" FROM orchestration_events
          WHERE sequence = ${lastSequence}
        `;
        const last = lastRows[0];
        if (last === undefined) return null;
        const payload = yield* parsePayload<Record<string, unknown>>(
          lastSequence,
          last.payloadJson,
          isOutputPayload,
        );
        const copy = compactCommandOutputCopy(row.output);
        payload.chunk = copy.chunk;
        delete payload.outputTruncated;
        if (row.outputTruncated !== 0 || copy.truncated) payload.outputTruncated = true;
        const payloadJson = JSON.stringify(payload);
        return {
          ops: [
            { kind: "rewrite", sequence: lastSequence, payloadJson },
            ...deleteOps(group.sequences.slice(0, -1), true),
          ],
          bytesRemoved: group.bytes - Buffer.byteLength(payloadJson, "utf8"),
        } satisfies PreparedGroup;
      });

    const prepareMessageGroup = (group: EventGroup) =>
      Effect.gen(function* () {
        const parsed: MessagePayload[] = [];
        for (const batch of chunks(group.sequences, SEQUENCES_PER_STATEMENT)) {
          const rows = yield* sql<{ readonly sequence: number; readonly payloadJson: string }>`
            SELECT sequence, payload_json AS "payloadJson" FROM orchestration_events
            WHERE sequence IN ${sql.in(batch)}
            ORDER BY sequence ASC
          `;
          for (const row of rows) {
            parsed.push(
              yield* parsePayload<MessagePayload>(row.sequence, row.payloadJson, isMessagePayload),
            );
          }
        }
        if (parsed.length !== group.sequences.length) return null;
        if (parsed[parsed.length - 1]!.streaming) return null;
        const payloadJson = JSON.stringify(foldMessagePayloads(parsed));
        return {
          ops: [
            {
              kind: "rewrite",
              sequence: group.sequences[group.sequences.length - 1]!,
              payloadJson,
            },
            ...deleteOps(group.sequences.slice(0, -1), false),
          ],
          bytesRemoved: group.bytes - Buffer.byteLength(payloadJson, "utf8"),
        } satisfies PreparedGroup;
      });

    /** Returns false when the time budget stopped the thread before it was finished. */
    const compactThread = (threadId: string) =>
      Effect.gen(function* () {
        const heads = yield* sql<{ readonly head: number | null }>`
          SELECT MAX(sequence) AS head FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        `;
        const head = heads[0]?.head ?? null;
        if (head === null || head > projectedThrough) return true;

        const groups = new Map<string, EventGroup>();
        let cursor = 0;
        while (true) {
          if (outOfTime()) return false;
          const page = yield* sql<{
            readonly sequence: number;
            readonly eventType: string;
            readonly groupId: string | null;
            readonly streaming: number | null;
            readonly payloadBytes: number;
            readonly valid: number;
          }>`
            SELECT
              sequence,
              event_type AS "eventType",
              CASE
                WHEN NOT json_valid(payload_json) THEN NULL
                WHEN event_type = ${OUTPUT_EVENT}
                  THEN json_extract(payload_json, '$.commandExecutionId')
                ELSE json_extract(payload_json, '$.messageId')
              END AS "groupId",
              CASE WHEN json_valid(payload_json)
                THEN json_extract(payload_json, '$.streaming')
              END AS streaming,
              LENGTH(CAST(payload_json AS BLOB)) AS "payloadBytes",
              json_valid(payload_json) AS valid
            FROM orchestration_events
            WHERE aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND sequence > ${cursor}
              AND sequence <= ${head}
              AND event_type IN (${OUTPUT_EVENT}, ${MESSAGE_EVENT})
            ORDER BY sequence ASC
            LIMIT ${SCAN_PAGE_SIZE}
          `;
          for (const row of page) {
            // An event that is not JSON cannot be attributed to a group, so no
            // group around it can be compacted safely: back the thread off.
            if (row.valid !== 1) {
              return yield* new MalformedEventPayload({
                sequence: row.sequence,
                cause: "payload is not valid JSON",
              });
            }
            if (row.groupId === null) continue;
            const kind = row.eventType === OUTPUT_EVENT ? "output" : "message";
            const key = `${kind}:${row.groupId}`;
            let group = groups.get(key);
            if (group === undefined) {
              group = {
                kind,
                id: row.groupId,
                sequences: [],
                bytes: 0,
                lastStreaming: false,
                lastPayloadBytes: 0,
              };
              groups.set(key, group);
            }
            group.sequences.push(row.sequence);
            group.bytes += row.payloadBytes;
            group.lastStreaming = row.streaming === 1;
            group.lastPayloadBytes = row.payloadBytes;
          }
          if (page.length < SCAN_PAGE_SIZE) break;
          cursor = page[page.length - 1]!.sequence;
          yield* Effect.yieldNow;
        }

        const eligible = [...groups.values()].filter((group) =>
          group.kind === "output"
            ? group.sequences.length > 1 ||
              group.lastPayloadBytes > COMPACTED_COMMAND_OUTPUT_MAX_BYTES + 1_024
            : group.sequences.length > 1 && !group.lastStreaming,
        );

        // Writes are packed into transactions of at most
        // MAX_EVENTS_PER_TRANSACTION events; a larger delete is split.
        let pending: WriteOp[] = [];
        let pendingCost = 0;
        const flush = Effect.gen(function* () {
          if (pending.length === 0) return;
          const batch = pending;
          pending = [];
          pendingCost = 0;
          yield* sql.withTransaction(Effect.forEach(batch, applyOp, { discard: true }));
          yield* Effect.yieldNow;
        });

        for (const group of eligible) {
          if (outOfTime()) {
            yield* flush;
            return false;
          }
          const prepared = yield* (
            group.kind === "output" ? prepareOutputGroup(group) : prepareMessageGroup(group)
          ).pipe(
            Effect.catchTag("MalformedEventPayload", (error) =>
              Effect.logWarning("event compaction skipped a group with a malformed payload", {
                threadId,
                groupId: group.id,
                sequence: error.sequence,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    totals.groupsSkipped += 1;
                  }),
                ),
                Effect.as(null),
              ),
            ),
          );
          if (prepared === null) continue;
          for (const op of prepared.ops) {
            if (pendingCost > 0 && pendingCost + opCost(op) > MAX_EVENTS_PER_TRANSACTION) {
              yield* flush;
              if (outOfTime()) return false;
            }
            pending.push(op);
            pendingCost += opCost(op);
          }
          totals.bytesRemoved += prepared.bytesRemoved;
          if (group.kind === "output") totals.commandOutputsCompacted += 1;
          else totals.messagesCompacted += 1;
        }
        yield* flush;

        yield* sql`
          INSERT INTO orchestration_event_compaction (
            thread_id, compacted_through_sequence, compacted_at, retry_after
          ) VALUES (${threadId}, ${head}, ${new Date().toISOString()}, NULL)
          ON CONFLICT (thread_id) DO UPDATE SET
            compacted_through_sequence = excluded.compacted_through_sequence,
            compacted_at = excluded.compacted_at,
            retry_after = NULL
        `;
        totals.threadsCompacted += 1;
        return true;
      });

    // Backs a failing thread off so it cannot take the budget every pass.
    const recordFailure = (threadId: string) =>
      sql`
        INSERT INTO orchestration_event_compaction (
          thread_id, compacted_through_sequence, compacted_at, retry_after
        ) VALUES (
          ${threadId}, 0, ${new Date().toISOString()},
          ${new Date(Date.now() + FAILED_THREAD_RETRY_MS).toISOString()}
        )
        ON CONFLICT (thread_id) DO UPDATE SET retry_after = excluded.retry_after
      `.pipe(Effect.ignore);

    let complete = true;
    for (const candidate of candidates) {
      if (outOfTime()) {
        complete = false;
        break;
      }
      const finished = yield* compactThread(candidate.threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event compaction failed for a thread", {
            threadId: candidate.threadId,
            cause,
          }).pipe(
            Effect.andThen(recordFailure(candidate.threadId)),
            Effect.tap(() =>
              Effect.sync(() => {
                totals.threadsFailed += 1;
              }),
            ),
            Effect.as(true),
          ),
        ),
      );
      if (!finished) {
        complete = false;
        break;
      }
    }
    return { ...totals, complete } satisfies EventCompactionResult;
  });
