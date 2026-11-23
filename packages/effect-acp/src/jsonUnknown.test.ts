import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { assert, describe, it } from "@effect/vitest";

import * as AcpSchema from "./_generated/schema.gen";
import * as Compat from "./compat";

// The RPC layer encodes and decodes every payload through `Schema.toCodecJson`.
const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) => {
  const codec = Schema.toCodecJson(schema as never) as Schema.Codec<unknown, unknown>;
  const decoded = Schema.decodeUnknownSync(codec)(value);
  return { decoded, encoded: Schema.encodeUnknownSync(codec)(decoded) };
};

describe("arbitrary JSON fields through toCodecJson", () => {
  it("keeps a permission request's rawInput and rawOutput", () => {
    const request = {
      sessionId: "session-1",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      toolCall: {
        toolCallId: "call-1",
        kind: "execute",
        status: "pending",
        title: "find .",
        rawInput: { CommandLine: "find .", WaitMsBeforeAsync: 5000, nested: [1, null, "x"] },
        rawOutput: "partial output",
      },
    };
    const { decoded, encoded } = roundTrip(AcpSchema.RequestPermissionRequest, request);
    assert.deepEqual(decoded, request);
    assert.deepEqual(encoded, request);
  });

  it("leaves absent rawInput and rawOutput absent", () => {
    const request = {
      sessionId: "session-1",
      options: [],
      toolCall: { toolCallId: "call-1" },
    };
    const { decoded, encoded } = roundTrip(AcpSchema.RequestPermissionRequest, request);
    assert.deepEqual(decoded, request);
    assert.deepEqual(encoded, request);
    assert.notProperty((decoded as typeof request).toolCall, "rawInput");
  });

  it("keeps tool call updates' raw fields", () => {
    const update = {
      toolCallId: "call-1",
      rawInput: { path: "/tmp/a" },
      rawOutput: { exitCode: 0, output: "ok" },
    };
    const { decoded, encoded } = roundTrip(AcpSchema.ToolCallUpdate, update);
    assert.deepEqual(decoded, update);
    assert.deepEqual(encoded, update);
  });

  it("keeps _meta values on compat session notifications", () => {
    const notification = {
      sessionId: "session-1",
      update: { sessionUpdate: "notice", severity: "info", title: "Heads up", _meta: { a: 1 } },
      _meta: { source: { kind: "test" } },
    };
    const { decoded, encoded } = roundTrip(Compat.SessionNotification, notification);
    assert.deepEqual(decoded, notification);
    assert.deepEqual(encoded, notification);
  });

  it("generates no bare Schema.Unknown", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "_generated/schema.gen.ts"),
      "utf8",
    );
    assert.notMatch(source, /\bSchema\.Unknown\b/);
  });
});
