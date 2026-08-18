import { createReadStream, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  CommandId,
  type ProviderRuntimeEvent,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
} from "@t3tools/contracts";
import { Cause, Effect, Schema } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  makeCompletedTurnUsageFact,
  makeTurnCompletedSessionSetCommand,
  providerCommandId,
  type TurnCompletedRuntimeEvent,
} from "../orchestration/providerTerminalLifecycle.ts";

interface StuckTurnCandidateRow {
  readonly threadId: string;
  readonly title: string;
  readonly activeTurnId: string;
  readonly sessionStatus: string;
  readonly turnState: string;
  readonly processingQuiescedAt: string | null;
  readonly hasFinalAssistant: number;
  readonly queuedCount: number;
}

interface ReadonlyDatabase {
  readonly prepare: (sql: string) => { readonly all: () => ReadonlyArray<unknown> };
  readonly close: () => void;
}

async function openReadonlyDatabase(dbPath: string): Promise<ReadonlyDatabase> {
  if (process.versions.bun !== undefined) {
    const moduleName = "bun:sqlite";
    const sqlite = (await import(moduleName)) as {
      readonly Database: new (
        path: string,
        options: { readonly readonly: boolean },
      ) => ReadonlyDatabase;
    };
    return new sqlite.Database(dbPath, { readonly: true });
  }
  const moduleName = "node:sqlite";
  const sqlite = (await import(moduleName)) as {
    readonly DatabaseSync: new (
      path: string,
      options: { readonly readOnly: boolean },
    ) => ReadonlyDatabase;
  };
  return new sqlite.DatabaseSync(dbPath, { readOnly: true });
}

export type StuckTurnRepairReason =
  | "eligible"
  | "eligible_stale_terminal_pointer"
  | "missing_terminal_event"
  | "ambiguous_terminal_events"
  | "missing_final_assistant";

export interface StuckTurnRepairInspection {
  readonly threadId: string;
  readonly title: string;
  readonly activeTurnId: string;
  readonly queuedCount: number;
  readonly reason: StuckTurnRepairReason;
  readonly event: TurnCompletedRuntimeEvent | null;
}

export interface RepairConfirmedCompletedTurnResult {
  readonly status: "repaired" | "skipped";
  readonly reason:
    | "repaired"
    | "thread_not_found"
    | "already_terminal"
    | "active_turn_mismatch"
    | "latest_turn_mismatch"
    | "missing_final_assistant";
}

const CANONICAL_PREFIX = "CANON: ";
const NATIVE_PREFIX = "NTIVE: ";

function decodeTurnCompletedEvent(value: unknown): TurnCompletedRuntimeEvent | null {
  try {
    const decoded = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)(value);
    return decoded.type === "turn.completed" ? decoded : null;
  } catch {
    return null;
  }
}

export function parseCanonicalTurnCompletedLine(line: string): TurnCompletedRuntimeEvent | null {
  if (!line.includes(CANONICAL_PREFIX) || !line.includes('"type":"turn.completed"')) {
    return null;
  }
  const prefixIndex = line.indexOf(CANONICAL_PREFIX);
  if (prefixIndex < 0) return null;
  try {
    return decodeTurnCompletedEvent(JSON.parse(line.slice(prefixIndex + CANONICAL_PREFIX.length)));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Canonical logs are intentionally preferred, but they rotate much faster than
 * per-thread native logs. This fallback recognizes only provider-native records
 * that are themselves terminal and still requires the database-side exact turn
 * and final-assistant checks before a repair can run.
 */
export function parseNativeTurnCompletedLine(
  line: string,
  expectedThreadId: string,
): TurnCompletedRuntimeEvent | null {
  if (!line.includes(NATIVE_PREFIX)) return null;
  const prefixIndex = line.indexOf(NATIVE_PREFIX);
  if (prefixIndex < 0) return null;

  try {
    const outer = record(JSON.parse(line.slice(prefixIndex + NATIVE_PREFIX.length)));
    const native = record(outer?.event) ?? outer;
    const eventId = nonEmptyString(native?.id);
    const createdAt = nonEmptyString(native?.createdAt);
    const turnId = nonEmptyString(native?.turnId);
    const method = nonEmptyString(native?.method);
    const provider = nonEmptyString(native?.provider);
    const nativeThreadId = nonEmptyString(native?.threadId);
    const payload = record(native?.payload);
    if (
      !eventId ||
      !createdAt ||
      !turnId ||
      !method ||
      !provider ||
      (nativeThreadId !== undefined && nativeThreadId !== expectedThreadId)
    ) {
      return null;
    }

    if (provider === "codex" && method === "turn/completed") {
      const turn = record(payload?.turn);
      const state = nonEmptyString(turn?.status) ?? "completed";
      const errorMessage = nonEmptyString(turn?.error);
      return decodeTurnCompletedEvent({
        type: "turn.completed",
        eventId,
        provider,
        threadId: expectedThreadId,
        turnId,
        createdAt,
        payload: {
          state,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
        },
      });
    }

    if (
      provider === "claudeAgent" &&
      method === "claude/result/success" &&
      payload?.is_error === false &&
      payload.terminal_reason === "completed" &&
      payload.subtype === "success"
    ) {
      return decodeTurnCompletedEvent({
        type: "turn.completed",
        eventId,
        provider,
        threadId: expectedThreadId,
        turnId,
        createdAt,
        payload: {
          state: "completed",
          ...(nonEmptyString(payload.stop_reason)
            ? { stopReason: nonEmptyString(payload.stop_reason) }
            : {}),
          ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
          ...(payload.modelUsage !== undefined ? { modelUsage: payload.modelUsage } : {}),
          ...(typeof payload.total_cost_usd === "number"
            ? { totalCostUsd: payload.total_cost_usd }
            : {}),
        },
      });
    }
  } catch {
    return null;
  }

  return null;
}

async function readLoggedTurnCompletions(
  providerLogsDir: string,
  activeTurnKeys: ReadonlySet<string>,
): Promise<ReadonlyMap<string, ReadonlyArray<TurnCompletedRuntimeEvent>>> {
  const completions = new Map<string, Map<string, TurnCompletedRuntimeEvent>>();
  if (!existsSync(providerLogsDir)) return new Map();
  const files = readdirSync(providerLogsDir)
    .filter((name) => name === "_global.log" || name.startsWith("_global.log."))
    .map((name) => path.join(providerLogsDir, name));

  for (const filePath of files) {
    const lines = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const event = parseCanonicalTurnCompletedLine(line);
      if (event?.turnId === undefined) continue;
      const key = `${event.threadId}:${event.turnId}`;
      if (!activeTurnKeys.has(key)) continue;
      const byEventId = completions.get(key) ?? new Map<string, TurnCompletedRuntimeEvent>();
      byEventId.set(event.eventId, event);
      completions.set(key, byEventId);
    }
  }

  for (const key of activeTurnKeys) {
    if ((completions.get(key)?.size ?? 0) > 0) continue;
    const separator = key.indexOf(":");
    const threadId = key.slice(0, separator);
    const turnId = key.slice(separator + 1);
    const threadFiles = readdirSync(providerLogsDir)
      .filter((name) => name === `${threadId}.log` || name.startsWith(`${threadId}.log.`))
      .map((name) => path.join(providerLogsDir, name));
    for (const filePath of threadFiles) {
      const lines = readline.createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const event = parseNativeTurnCompletedLine(line, threadId);
        if (event?.turnId !== turnId) continue;
        const byEventId = completions.get(key) ?? new Map<string, TurnCompletedRuntimeEvent>();
        byEventId.set(event.eventId, event);
        completions.set(key, byEventId);
      }
    }
  }

  return new Map(
    Array.from(completions, ([key, events]) => [key, Array.from(events.values())] as const),
  );
}

export async function inspectStuckTurns(input: {
  readonly dbPath: string;
  readonly providerLogsDir: string;
}): Promise<ReadonlyArray<StuckTurnRepairInspection>> {
  const database = await openReadonlyDatabase(input.dbPath);
  let rows: ReadonlyArray<StuckTurnCandidateRow>;
  try {
    rows = database
      .prepare(
        `SELECT
           session.thread_id AS threadId,
           thread.title AS title,
           session.active_turn_id AS activeTurnId,
           session.status AS sessionStatus,
           turn.state AS turnState,
           turn.processing_quiesced_at AS processingQuiescedAt,
           EXISTS (
             SELECT 1
             FROM projection_thread_messages AS message
             WHERE message.thread_id = session.thread_id
               AND message.turn_id = session.active_turn_id
               AND message.role = 'assistant'
               AND message.is_streaming = 0
               AND length(trim(message.text)) > 0
           ) AS hasFinalAssistant,
           (
             SELECT count(*)
             FROM next_turn_queue AS queued
             WHERE queued.thread_id = session.thread_id
               AND queued.status = 'queued'
               AND queued.deleted_at IS NULL
           ) AS queuedCount
         FROM projection_thread_sessions AS session
         JOIN projection_threads AS thread ON thread.thread_id = session.thread_id
         JOIN projection_turns AS turn
           ON turn.thread_id = session.thread_id
          AND turn.turn_id = session.active_turn_id
         WHERE session.active_turn_id IS NOT NULL
           AND (
             (session.status = 'running' AND turn.state = 'running')
             OR (
               session.status = 'ready'
               AND turn.state = 'completed'
               AND turn.processing_quiesced_at IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM next_turn_queue AS blocked
                 WHERE blocked.thread_id = session.thread_id
                   AND blocked.status = 'queued'
                   AND blocked.deleted_at IS NULL
               )
             )
           )
         ORDER BY session.updated_at ASC, session.thread_id ASC`,
      )
      .all() as unknown as ReadonlyArray<StuckTurnCandidateRow>;
  } finally {
    database.close();
  }

  const activeTurnKeys = new Set(
    rows
      .filter((row) => row.sessionStatus === "running" && row.turnState === "running")
      .map((row) => `${row.threadId}:${row.activeTurnId}`),
  );
  const loggedCompletions = await readLoggedTurnCompletions(input.providerLogsDir, activeTurnKeys);

  return rows.map((row) => {
    if (
      row.sessionStatus === "ready" &&
      row.turnState === "completed" &&
      row.processingQuiescedAt !== null
    ) {
      return {
        threadId: row.threadId,
        title: row.title,
        activeTurnId: row.activeTurnId,
        queuedCount: row.queuedCount,
        reason:
          row.hasFinalAssistant === 1
            ? ("eligible_stale_terminal_pointer" as const)
            : ("missing_final_assistant" as const),
        event: null,
      };
    }
    const events = loggedCompletions.get(`${row.threadId}:${row.activeTurnId}`) ?? [];
    const event = events.length === 1 ? events[0]! : null;
    const reason: StuckTurnRepairReason =
      row.hasFinalAssistant !== 1
        ? "missing_final_assistant"
        : events.length === 0
          ? "missing_terminal_event"
          : events.length > 1
            ? "ambiguous_terminal_events"
            : "eligible";
    return {
      threadId: row.threadId,
      title: row.title,
      activeTurnId: row.activeTurnId,
      queuedCount: row.queuedCount,
      reason,
      event,
    };
  });
}

export const repairConfirmedCompletedTurn = Effect.fn(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly event: TurnCompletedRuntimeEvent;
}) {
  const readModel = yield* input.engine.getReadModel();
  const thread = readModel.threads.find((candidate) => candidate.id === input.event.threadId);
  if (!thread) {
    return {
      status: "skipped",
      reason: "thread_not_found",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  if (thread.session?.status !== "running" || thread.session.activeTurnId === null) {
    return {
      status: "skipped",
      reason: "already_terminal",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  if (input.event.turnId === undefined || thread.session.activeTurnId !== input.event.turnId) {
    return {
      status: "skipped",
      reason: "active_turn_mismatch",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  if (thread.latestTurn?.turnId !== input.event.turnId || thread.latestTurn.state !== "running") {
    return {
      status: "skipped",
      reason: "latest_turn_mismatch",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  const hasFinalAssistant = thread.messages.some(
    (message) =>
      message.turnId === input.event.turnId &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  if (!hasFinalAssistant) {
    return {
      status: "skipped",
      reason: "missing_final_assistant",
    } satisfies RepairConfirmedCompletedTurnResult;
  }

  yield* input.engine.dispatch(makeTurnCompletedSessionSetCommand({ event: input.event, thread }));

  const usageFact = makeCompletedTurnUsageFact({ event: input.event, thread });
  if (usageFact !== undefined) {
    yield* input.engine
      .dispatch({
        type: "thread.usage.record",
        commandId: providerCommandId(input.event, "thread-usage-record"),
        threadId: thread.id,
        usageFact,
        createdAt: input.event.createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("stuck-turn repair could not record usage", {
            eventId: input.event.eventId,
            threadId: thread.id,
            turnId: input.event.turnId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  }

  return {
    status: "repaired",
    reason: "repaired",
  } satisfies RepairConfirmedCompletedTurnResult;
});

export const repairStaleTerminalPointer = Effect.fn(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly threadId: string;
  readonly activeTurnId: string;
  readonly createdAt: string;
}) {
  const readModel = yield* input.engine.getReadModel();
  const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
  if (!thread) {
    return {
      status: "skipped",
      reason: "thread_not_found",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  if (thread.session?.activeTurnId === null) {
    return {
      status: "skipped",
      reason: "already_terminal",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  if (thread.session?.activeTurnId !== input.activeTurnId) {
    return {
      status: "skipped",
      reason: "active_turn_mismatch",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  // The offline inspection already proved that this exact active turn is
  // terminal and quiesced in the projection tables. `latestTurn` is a
  // presentation field and may already describe queued work, so it cannot be
  // used to validate the stale session pointer here. Re-check the durable
  // session identity and state after bootstrapping the engine instead.
  if (thread.session.status !== "ready") {
    return {
      status: "skipped",
      reason: "latest_turn_mismatch",
    } satisfies RepairConfirmedCompletedTurnResult;
  }
  const hasFinalAssistant = thread.messages.some(
    (message) =>
      message.turnId === input.activeTurnId &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  if (!hasFinalAssistant) {
    return {
      status: "skipped",
      reason: "missing_final_assistant",
    } satisfies RepairConfirmedCompletedTurnResult;
  }

  yield* input.engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.makeUnsafe(
      `repair:stale-terminal-pointer:${thread.id}:${input.activeTurnId}`,
    ),
    threadId: thread.id,
    session: {
      ...thread.session,
      activeTurnId: null,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });

  return {
    status: "repaired",
    reason: "repaired",
  } satisfies RepairConfirmedCompletedTurnResult;
});

export type { ProviderRuntimeEvent };
