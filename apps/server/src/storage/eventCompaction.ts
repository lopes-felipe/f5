import { Effect } from "effect";
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
 * - Command receipts of the removed events, which only guard against a command
 *   being dispatched twice.
 *
 * A thread is compacted once it has been idle for an hour and has no active
 * turn, and only when every projector has applied all of its events, so the
 * rewritten events are never applied again in normal operation. Replaying the
 * log from the start (a projector rebuild) still yields every message and
 * command, with command output reduced to the compacted copy.
 *
 * The SQLite connection is shared and synchronous, so the scan is paged and
 * every write transaction covers a bounded number of events.
 */

export const EVENT_COMPACTION_IDLE_MS = 60 * 60 * 1_000;
/** Size of the copy of a command's output kept in the event log. */
export const COMPACTED_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024;
const COMPACTED_COMMAND_OUTPUT_HEAD_BYTES = 8 * 1024;
const SCAN_PAGE_SIZE = 1_000;
const GROUPS_PER_TRANSACTION = 100;
const SEQUENCES_PER_STATEMENT = 500;

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
  /** False when the time budget ran out before every candidate thread was visited. */
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

interface EventGroup {
  readonly kind: "output" | "message";
  readonly id: string;
  readonly sequences: number[];
  lastStreaming: boolean;
  lastPayloadBytes: number;
}

function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export const compactThreadEvents = (input: {
  readonly nowMs: number;
  /** Stop visiting new threads after this long. */
  readonly maxDurationMs: number;
  readonly maxThreads?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const startedAtMs = Date.now();
    const totals = {
      threadsCompacted: 0,
      commandOutputsCompacted: 0,
      messagesCompacted: 0,
      eventsRemoved: 0,
      receiptsRemoved: 0,
      bytesRemoved: 0,
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

    const removeEvents = (sequences: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const commandIds: string[] = [];
        for (const batch of chunks(sequences, SEQUENCES_PER_STATEMENT)) {
          const removed = yield* sql<{
            readonly commandId: string | null;
            readonly bytes: number;
          }>`
            DELETE FROM orchestration_events
            WHERE sequence IN ${sql.in(batch)}
            RETURNING command_id AS "commandId", LENGTH(payload_json) AS "bytes"
          `;
          totals.eventsRemoved += removed.length;
          for (const row of removed) {
            totals.bytesRemoved += row.bytes;
            if (row.commandId !== null) commandIds.push(row.commandId);
          }
        }
        for (const batch of chunks(commandIds, SEQUENCES_PER_STATEMENT)) {
          const receipts = yield* sql<{ readonly commandId: string }>`
            DELETE FROM orchestration_command_receipts
            WHERE command_id IN ${sql.in(batch)}
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_events AS event
                WHERE event.command_id = orchestration_command_receipts.command_id
              )
            RETURNING command_id AS "commandId"
          `;
          totals.receiptsRemoved += receipts.length;
        }
      });

    const rewritePayload = (sequence: number, payloadJson: string, previousBytes: number) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE orchestration_events SET payload_json = ${payloadJson}
          WHERE sequence = ${sequence}
        `;
        totals.bytesRemoved += previousBytes - payloadJson.length;
      });

    const compactOutputGroup = (group: EventGroup) =>
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
          yield* removeEvents(group.sequences);
          totals.commandOutputsCompacted += 1;
          return;
        }
        if (row.completedAt === null || row.lastUpdatedSequence < lastSequence) return;
        const lastRows = yield* sql<{ readonly payloadJson: string }>`
          SELECT payload_json AS "payloadJson" FROM orchestration_events
          WHERE sequence = ${lastSequence}
        `;
        const last = lastRows[0];
        if (last === undefined) return;
        const copy = compactCommandOutputCopy(row.output);
        const payload = JSON.parse(last.payloadJson) as Record<string, unknown>;
        payload.chunk = copy.chunk;
        delete payload.outputTruncated;
        if (row.outputTruncated !== 0 || copy.truncated) payload.outputTruncated = true;
        yield* rewritePayload(lastSequence, JSON.stringify(payload), last.payloadJson.length);
        yield* removeEvents(group.sequences.slice(0, -1));
        totals.commandOutputsCompacted += 1;
      });

    const compactMessageGroup = (group: EventGroup) =>
      Effect.gen(function* () {
        const payloads: Array<{ readonly sequence: number; readonly payloadJson: string }> = [];
        for (const batch of chunks(group.sequences, SEQUENCES_PER_STATEMENT)) {
          const rows = yield* sql<{ readonly sequence: number; readonly payloadJson: string }>`
            SELECT sequence, payload_json AS "payloadJson" FROM orchestration_events
            WHERE sequence IN ${sql.in(batch)}
            ORDER BY sequence ASC
          `;
          payloads.push(...rows);
        }
        if (payloads.length !== group.sequences.length) return;
        const parsed = payloads.map((row) => JSON.parse(row.payloadJson) as MessagePayload);
        if (parsed[parsed.length - 1]!.streaming) return;
        const last = payloads[payloads.length - 1]!;
        yield* rewritePayload(
          last.sequence,
          JSON.stringify(foldMessagePayloads(parsed)),
          last.payloadJson.length,
        );
        yield* removeEvents(group.sequences.slice(0, -1));
        totals.messagesCompacted += 1;
      });

    const compactThread = (threadId: string) =>
      Effect.gen(function* () {
        const heads = yield* sql<{ readonly head: number | null }>`
          SELECT MAX(sequence) AS head FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        `;
        const head = heads[0]?.head ?? null;
        if (head === null || head > projectedThrough) return;

        const groups = new Map<string, EventGroup>();
        let cursor = 0;
        while (true) {
          const page = yield* sql<{
            readonly sequence: number;
            readonly eventType: string;
            readonly groupId: string | null;
            readonly streaming: number | null;
            readonly payloadBytes: number;
          }>`
            SELECT
              sequence,
              event_type AS "eventType",
              CASE event_type
                WHEN ${OUTPUT_EVENT} THEN json_extract(payload_json, '$.commandExecutionId')
                ELSE json_extract(payload_json, '$.messageId')
              END AS "groupId",
              json_extract(payload_json, '$.streaming') AS streaming,
              LENGTH(CAST(payload_json AS BLOB)) AS "payloadBytes"
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
            if (row.groupId === null) continue;
            const kind = row.eventType === OUTPUT_EVENT ? "output" : "message";
            const key = `${kind}:${row.groupId}`;
            let group = groups.get(key);
            if (group === undefined) {
              group = {
                kind,
                id: row.groupId,
                sequences: [],
                lastStreaming: false,
                lastPayloadBytes: 0,
              };
              groups.set(key, group);
            }
            group.sequences.push(row.sequence);
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
        for (const batch of chunks(eligible, GROUPS_PER_TRANSACTION)) {
          yield* sql.withTransaction(
            Effect.forEach(
              batch,
              (group) =>
                group.kind === "output" ? compactOutputGroup(group) : compactMessageGroup(group),
              { discard: true },
            ),
          );
          yield* Effect.yieldNow;
        }

        yield* sql`
          INSERT INTO orchestration_event_compaction (
            thread_id, compacted_through_sequence, compacted_at
          ) VALUES (${threadId}, ${head}, ${new Date().toISOString()})
          ON CONFLICT (thread_id) DO UPDATE SET
            compacted_through_sequence = excluded.compacted_through_sequence,
            compacted_at = excluded.compacted_at
        `;
        totals.threadsCompacted += 1;
      });

    let complete = true;
    for (const candidate of candidates) {
      if (Date.now() - startedAtMs > input.maxDurationMs) {
        complete = false;
        break;
      }
      yield* compactThread(candidate.threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event compaction failed for a thread", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
    }
    return { ...totals, complete } satisfies EventCompactionResult;
  });
