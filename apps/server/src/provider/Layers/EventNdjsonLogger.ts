/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { Cause, Effect } from "effect";
import { appendProviderLog, closeProviderLogs } from "../logWriterRegistry.ts";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 200;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

/** Replaces inline base64 image blocks (Claude and MCP shapes) so logs never hold screenshots. */
export function scrubInlineImagesReplacer(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.type !== "image") return value;
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;
  const data = typeof record.data === "string" ? record.data : source?.data;
  if (typeof data !== "string") return value;
  return {
    type: "image",
    mimeType: record.mimeType ?? source?.media_type,
    omitted: true,
    base64Chars: data.length,
  };
}

function toLogMessage(event: unknown): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const serialized = yield* Effect.sync(() => {
      try {
        return { ok: true as const, value: JSON.stringify(event, scrubInlineImagesReplacer) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });

    if (!serialized.ok) {
      yield* logWarning("failed to serialize provider event log record", {
        error: serialized.error,
      });
      return undefined;
    }

    if (typeof serialized.value !== "string") {
      return undefined;
    }

    return serialized.value;
  });
}

function isCritical(event: unknown): boolean {
  if (!event || typeof event !== "object") return true;
  const record = event as Record<string, unknown>;
  const nested =
    record.event && typeof record.event === "object"
      ? (record.event as Record<string, unknown>)
      : undefined;
  const type = String(nested?.type ?? nested?.method ?? record.type ?? record.method ?? "");
  if (type === "session/update") {
    const frame = nested ?? record;
    const body = frame.params ?? frame.payload;
    const params = body && typeof body === "object" ? (body as Record<string, unknown>) : frame;
    const update =
      params.update && typeof params.update === "object"
        ? (params.update as Record<string, unknown>)
        : params;
    // ACP content chunks are deltas even though the envelope method is shared
    // with plans, tool calls and other boundaries which must await persistence.
    if (
      ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(
        String(update.sessionUpdate),
      )
    )
      return false;
  }
  // Deltas remain lossless but can batch. Envelopes, block boundaries, errors,
  // session/turn transitions and every unrecognized shape wait for append.
  return (
    type !== "content.delta" &&
    type !== "thread.message-sent" &&
    type !== "content_block_delta" &&
    !/[/_.]delta$/i.test(type) &&
    !/Delta$/.test(type)
  );
}

export function makeEventNdjsonLogger(
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.Effect<EventNdjsonLogger | undefined> {
  return Effect.gen(function* () {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    if (maxBytes < 1 || maxFiles < 1) throw new Error("Invalid provider log rotation limits");
    const directoryReady = yield* Effect.tryPromise(() =>
      fs.mkdir(path.dirname(filePath), { recursive: true }),
    ).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        logWarning("failed to create provider event log directory", { filePath, error }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!directoryReady) return undefined;
    const directory = yield* Effect.promise(() => fs.realpath(path.dirname(filePath)));
    const owner = Symbol(filePath);
    let closed = false;
    const admitted = new Set<Promise<void>>();
    const streamLabel = resolveStreamLabel(options.stream);
    return {
      filePath,
      write(event, threadId) {
        return Effect.suspend(() => {
          if (closed) return Effect.void;
          // Own admission before serialization can yield. Closing must also wait
          // for accepted records which have not reached the file registry yet.
          const ticket = Promise.withResolvers<void>();
          admitted.add(ticket.promise);
          return Effect.gen(function* () {
            const message = yield* toLogMessage(event);
            if (!message) return;
            yield* Effect.promise(() => {
              const work = appendProviderLog({
                filePath: path.join(directory, `${resolveThreadSegment(threadId)}.log`),
                owner,
                text: `[${new Date().toISOString()}] ${streamLabel}: ${message}\n`,
                maxBytes,
                maxFiles,
                batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
                critical: isCritical(event),
              });
              return work;
            }).pipe(
              Effect.tapCause((cause) =>
                logWarning("provider event log append failed after retries", { filePath, cause }),
              ),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                admitted.delete(ticket.promise);
                ticket.resolve();
              }),
            ),
          );
        });
      },
      close: () =>
        Effect.promise(async () => {
          closed = true;
          const settled = await Promise.allSettled([...admitted]);
          await closeProviderLogs(owner);
          const failed = settled.filter((result) => result.status === "rejected");
          if (failed.length)
            throw new AggregateError(
              failed.map((result) => result.reason),
              "Provider log shutdown incomplete",
            );
        }),
    } satisfies EventNdjsonLogger;
  });
}

/** Log failures are observable, but durable terminal receipts still have to publish. */
export const writeProviderEventLog = (
  logger: EventNdjsonLogger,
  event: unknown,
  threadId: ThreadId | null,
): Effect.Effect<void> =>
  logger.write(event, threadId).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : logWarning("provider log write incomplete; continuing authoritative event delivery", {
            filePath: logger.filePath,
            cause,
          }),
    ),
  );
