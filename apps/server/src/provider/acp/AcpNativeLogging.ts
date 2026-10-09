import type { ProviderKind, ThreadId } from "@t3tools/contracts";
import { Cause, Effect } from "effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { AcpSessionRequestLogEvent, AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

function writeNativeAcpLog(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly kind: "request" | "protocol";
  readonly payload: unknown;
}): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!input.nativeEventLogger) return;
    const observedAt = new Date().toISOString();
    yield* input.nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: crypto.randomUUID(),
          kind: input.kind,
          provider: input.provider,
          createdAt: observedAt,
          threadId: input.threadId,
          payload: input.payload,
        },
      },
      input.threadId,
    );
  });
}

const REDACTED = "[redacted elicitation answer]";

/**
 * Elicitation answers (`{ action: "accept", content }`, nested under the ACP
 * response's `action`) must never reach native logs; everything else is kept.
 */
export function redactElicitationAnswers(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactElicitationAnswers(entry, depth + 1));
  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record))
    redacted[key] =
      key === "content" && record.action === "accept"
        ? REDACTED
        : redactElicitationAnswers(entry, depth + 1);
  return redacted;
}

function redactProtocolEvent(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): EffectAcpProtocol.AcpProtocolLogEvent {
  if (event.direction !== "outgoing") return event;
  if (typeof event.payload === "string") {
    if (!event.payload.includes('"content"')) return event;
    try {
      return {
        ...event,
        payload: JSON.stringify(redactElicitationAnswers(JSON.parse(event.payload))),
      };
    } catch {
      return { ...event, payload: REDACTED };
    }
  }
  return { ...event, payload: redactElicitationAnswers(event.payload) };
}

function formatRequestLogPayload(event: AcpSessionRequestLogEvent) {
  return {
    method: event.method,
    status: event.status,
    request: event.payload,
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.cause !== undefined ? { cause: Cause.pretty(event.cause) } : {}),
  };
}

export function makeAcpNativeLoggers(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  return {
    requestLogger: (event) =>
      writeNativeAcpLog({
        nativeEventLogger: input.nativeEventLogger,
        provider: input.provider,
        threadId: input.threadId,
        kind: "request",
        payload: formatRequestLogPayload(event),
      }),
    ...(input.nativeEventLogger
      ? {
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
              writeNativeAcpLog({
                nativeEventLogger: input.nativeEventLogger,
                provider: input.provider,
                threadId: input.threadId,
                kind: "protocol",
                payload: redactProtocolEvent(event),
              }),
          } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
        }
      : {}),
  };
}
