import { describe, expect, it } from "vitest";
import { redactElicitationAnswers } from "./AcpNativeLogging.ts";

describe("ACP native log redaction", () => {
  it("removes accepted elicitation content but keeps the rest of the message", () => {
    const message = {
      jsonrpc: "2.0",
      id: 7,
      result: { action: { action: "accept", content: { token: "sentinel-0c9e" } } },
    };
    const redacted = redactElicitationAnswers(message);
    expect(JSON.stringify(redacted)).not.toContain("sentinel-0c9e");
    expect(redacted).toMatchObject({
      id: 7,
      result: { action: { action: "accept", content: "[redacted elicitation answer]" } },
    });
  });

  it("leaves unrelated content fields untouched", () => {
    const message = { params: { content: [{ type: "text", text: "hello" }] } };
    expect(redactElicitationAnswers(message)).toEqual(message);
  });

  it("redacts anything nested too deep to inspect", () => {
    let message: unknown = { action: "accept", content: { token: "sentinel-deep" } };
    for (let depth = 0; depth < 12; depth += 1) message = { wrapped: message };
    expect(JSON.stringify(redactElicitationAnswers(message))).not.toContain("sentinel-deep");
  });
});

import {
  AcpCredentialScrubber,
  redactAcpLogPayload,
  makeAcpNativeLoggers,
} from "./AcpNativeLogging";
import { ThreadId } from "@t3tools/contracts";
import { Cause, Effect } from "effect";
import { vi } from "vitest";

it("enables verbose protocol diagnostics through the server environment", () => {
  vi.stubEnv("F5_ACP_PROTOCOL_LOGGING", "1");
  try {
    const input = {
      nativeEventLogger: { write: () => Effect.void } as never,
      provider: "cursor" as const,
      threadId: ThreadId.makeUnsafe("log-test"),
    };
    expect(makeAcpNativeLoggers(input).protocolLogging?.logIncoming).toBe(true);
    expect(
      makeAcpNativeLoggers({ ...input, verboseProtocolLogging: false }).protocolLogging,
    ).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("redacts MCP array and object configuration, raw frames, echoed failures and late diagnostics", async () => {
  const marker = "credential-sentinel-48be";
  const scrubber = new AcpCredentialScrubber();
  scrubber.register(marker);
  const redact = (value: unknown) => redactAcpLogPayload(value, scrubber);
  const array = {
    params: {
      mcpServers: [
        {
          type: "http",
          name: "f5",
          headers: [{ name: "Authorization", value: marker }],
          env: [{ name: "TOKEN", value: marker }],
        },
      ],
    },
  };
  const mapped = {
    mcpServers: { f5: { headers: { Authorization: marker }, env: { TOKEN: marker } } },
  };
  expect(redact(array)).toMatchObject({
    params: { mcpServers: [{ headers: [{ name: "Authorization", value: "[redacted]" }] }] },
  });
  expect(redact(mapped)).toMatchObject({ mcpServers: { f5: { env: { TOKEN: "[redacted]" } } } });
  const write = vi.fn(() => Effect.void);
  const loggers = makeAcpNativeLoggers({
    verboseProtocolLogging: true,
    nativeEventLogger: { write } as never,
    provider: "cursor",
    threadId: ThreadId.makeUnsafe("log-test"),
    redactForLog: redact,
  });
  for (const direction of ["incoming", "outgoing"] as const) {
    for (const stage of ["raw", "decoded", "decode_failed"] as const) {
      for (const payload of [
        array,
        mapped,
        JSON.stringify(array),
        `malformed ${marker}`,
        { echoed: `Bearer ${marker}` },
        { params: { toolCall: { rawInput: { env: marker } } } },
      ]) {
        await Effect.runPromise(loggers.protocolLogging!.logger!({ direction, stage, payload }));
      }
    }
  }
  await Effect.runPromise(
    loggers.requestLogger!({
      method: "session/new",
      payload: array,
      result: { echoed: marker },
      status: "failed",
      cause: Cause.die(new Error(marker)),
    }),
  );
  expect(JSON.stringify(write.mock.calls)).not.toContain(marker);
  expect(redact(`malformed ${marker}`)).toBe("[unparsed ACP frame redacted]");
  expect(scrubber.scrub(`late producer: ${marker}`)).toBe("late producer: [redacted]");
});

it("retains protocol error codes and human diagnostics beginning with brackets", () => {
  const scrubber = new AcpCredentialScrubber();
  scrubber.register("secret");
  expect(
    redactAcpLogPayload(
      { message: "[auth] sign in: secret", error: { code: -32000, message: "secret" } },
      scrubber,
      0,
      false,
      true,
    ),
  ).toEqual({
    message: "[auth] sign in: [redacted]",
    error: { code: -32000, message: "ACP_REQUEST_FAILED" },
  });
});

it("redacts once per native log sink and retains failures as failures", async () => {
  const write = vi.fn((_value: unknown) => Effect.void);
  const redact = vi.fn(redactAcpLogPayload);
  const loggers = makeAcpNativeLoggers({
    verboseProtocolLogging: true,
    nativeEventLogger: { write } as never,
    provider: "cursor",
    threadId: ThreadId.makeUnsafe("single-log"),
    redactForLog: redact,
  });
  await Effect.runPromise(
    loggers.protocolLogging!.logger!({
      direction: "incoming",
      stage: "raw",
      payload: JSON.stringify({ error: { code: -32000, message: "private" } }),
    }),
  );
  expect(redact).toHaveBeenCalledOnce();
  await Effect.runPromise(
    loggers.requestLogger!({
      method: "session/prompt",
      status: "failed",
      payload: {},
      failure: { code: -32000, message: "Usage limit" },
    }),
  );
  expect(redact).toHaveBeenCalledTimes(2);
  const logged = write.mock.calls[1]![0] as unknown as {
    event: { payload: Record<string, unknown> };
  };
  expect(logged.event.payload).toMatchObject({
    status: "failed",
    failure: { code: -32000, message: "Usage limit" },
  });
  expect(logged.event.payload).not.toHaveProperty("result");
});

it("keeps request diagnostics while leaving verbose protocol logging off by default", () => {
  const loggers = makeAcpNativeLoggers({
    nativeEventLogger: { write: () => Effect.void } as never,
    provider: "cursor",
    threadId: ThreadId.makeUnsafe("quiet-protocol"),
  });
  expect(loggers.requestLogger).toBeDefined();
  expect(loggers.protocolLogging).toBeUndefined();
});

it("preserves non-computer error details while always scrubbing credentials and MCP config", () => {
  const scrubber = new AcpCredentialScrubber();
  scrubber.register("issued-credential");
  const payload = {
    error: {
      code: -32000,
      message: "Authentication required: issued-credential",
      data: { mcpServers: { f5: { headers: { Authorization: "issued-credential" } } } },
    },
    cause: "Sign in again",
  };
  const safe = redactAcpLogPayload(payload, scrubber);
  expect(safe).toMatchObject({
    error: { code: -32000, message: "Authentication required: [redacted]" },
    cause: "Sign in again",
  });
  expect(JSON.stringify(safe)).not.toContain("issued-credential");
  expect(redactAcpLogPayload(payload, scrubber, 0, false, true)).toMatchObject({
    error: { code: -32000, message: "ACP_REQUEST_FAILED" },
    cause: { message: "ACP_REQUEST_FAILED" },
  });
});
