import type { ProviderKind, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
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
  if (value === null || typeof value !== "object") return value;
  // Too deep to inspect means it cannot be shown to be answer-free.
  if (depth > 8) return REDACTED;
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

/** Session-owned; revoking execution credentials must not stop scrubbing late diagnostics. */
export class AcpCredentialScrubber {
  private readonly credentials = new Set<string>();
  register(credential: string): void {
    if (credential) this.credentials.add(credential);
  }
  scrub(text: string): string {
    for (const credential of this.credentials) text = text.replaceAll(credential, "[redacted]");
    return text;
  }
}

/** Redact configuration structurally, including raw NDJSON, before any log writer. */
export function redactAcpLogPayload(
  value: unknown,
  scrubber?: AcpCredentialScrubber,
  depth = 0,
  configuration = false,
  maskErrors = false,
): unknown {
  if (depth > 32) return "[redacted]";
  if (typeof value === "string") {
    const safe = scrubber?.scrub(value) ?? value;
    if (depth === 0) {
      try {
        return safe
          .trim()
          .split(/\r?\n/)
          .map((frame) =>
            JSON.stringify(
              redactAcpLogPayload(
                JSON.parse(frame),
                scrubber,
                depth + 1,
                configuration,
                maskErrors,
              ),
            ),
          )
          .join("\n");
      } catch {
        return "[unparsed ACP frame redacted]";
      }
    }
    return safe;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((entry) =>
      redactAcpLogPayload(entry, scrubber, depth + 1, configuration, maskErrors),
    );
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (configuration && (key === "headers" || key === "env")) {
        return [
          key,
          Array.isArray(entry)
            ? entry.map((item) => ({
                name: typeof item?.name === "string" ? item.name : "",
                value: "[redacted]",
              }))
            : entry && typeof entry === "object"
              ? Object.fromEntries(Object.keys(entry).map((name) => [name, "[redacted]"]))
              : "[redacted]",
        ];
      }
      if (key === "content" && record.action === "accept") return [key, REDACTED];
      if (maskErrors && ["cause", "error", "failure"].includes(key)) {
        const error =
          entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
        return [
          key,
          {
            ...(typeof error?.code === "number" ? { code: error.code } : {}),
            message: "ACP_REQUEST_FAILED",
          },
        ];
      }
      return [
        key,
        redactAcpLogPayload(
          entry,
          scrubber,
          depth + 1,
          configuration || key === "mcpServers",
          maskErrors,
        ),
      ];
    }),
  );
}

function formatRequestLogPayload(event: AcpSessionRequestLogEvent) {
  return {
    method: event.method,
    status: event.status,
    request: event.payload,
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.failure !== undefined ? { failure: event.failure } : {}),
    ...(event.cause !== undefined ? { failure: { message: "ACP_REQUEST_FAILED" } } : {}),
  };
}

export function makeAcpNativeLoggers(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly redactForLog?: (payload: unknown) => unknown;
  readonly verboseProtocolLogging?: boolean;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging" | "logWritersRedact"> {
  return {
    logWritersRedact: true,
    requestLogger: (event) =>
      writeNativeAcpLog({
        nativeEventLogger: input.nativeEventLogger,
        provider: input.provider,
        threadId: input.threadId,
        kind: "request",
        payload: (input.redactForLog ?? redactAcpLogPayload)(formatRequestLogPayload(event)),
      }),
    ...(input.nativeEventLogger &&
    (input.verboseProtocolLogging ?? process.env.F5_ACP_PROTOCOL_LOGGING === "1")
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
                payload: {
                  ...event,
                  payload: (input.redactForLog ?? redactAcpLogPayload)(event.payload),
                },
              }),
          } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
        }
      : {}),
  };
}
