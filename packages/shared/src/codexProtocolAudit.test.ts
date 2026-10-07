import { describe, expect, it } from "vitest";

import { parseCodexCliVersion } from "./codexCliVersion";
import {
  auditCodexResponseFields,
  checkCodexClientRequests,
  codexJsonSchemaHasField,
  diffCodexProtocolSurface,
  isExpectedCodexProtocolVersion,
} from "./codexProtocolAudit";
import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_TYPES,
} from "./codexProtocolManifest";

describe("Codex client request audit", () => {
  const allPreferred = CODEX_CLIENT_REQUEST_METHODS.map((group) => group[0]);

  it("accepts a CLI that only offers the fallback, and reports it", () => {
    const legacy = allPreferred.filter((method) => method !== "thread/revert");
    expect(checkCodexClientRequests([...legacy, "thread/rollback"])).toEqual({
      unsupported: [],
      usingFallback: ["thread/revert -> thread/rollback"],
    });
  });

  it("flags a request group the CLI no longer supports at all", () => {
    const report = diffCodexProtocolSurface({
      notifications: CODEX_NOTIFICATION_METHODS,
      requests: CODEX_SERVER_REQUEST_METHODS,
      items: CODEX_THREAD_ITEM_TYPES,
      clientRequests: allPreferred.filter((method) => method !== "thread/revert"),
    });
    expect(report.clientRequests.unsupported).toEqual([
      "thread/revert | thread/rollback | thread/fork",
    ]);
    expect(report.hasDrift).toBe(true);
  });

  it("skips the client check when the surface omits it", () => {
    const report = diffCodexProtocolSurface({
      notifications: CODEX_NOTIFICATION_METHODS,
      requests: CODEX_SERVER_REQUEST_METHODS,
      items: CODEX_THREAD_ITEM_TYPES,
    });
    expect(report.hasDrift).toBe(false);
  });
});

describe("Codex protocol audit versions", () => {
  it("parses release and prerelease Codex CLI output", () => {
    expect(parseCodexCliVersion("codex-cli 0.144.3")).toBe("0.144.3");
    expect(parseCodexCliVersion("codex-cli 0.145.0-alpha.2")).toBe("0.145.0-alpha.2");
    expect(parseCodexCliVersion("not a version")).toBeNull();
  });

  it("requires the exact audited Codex version", () => {
    expect(isExpectedCodexProtocolVersion("codex-cli 0.144.3", "0.144.3")).toBe(true);
    expect(isExpectedCodexProtocolVersion("codex-cli 0.144.1", "0.144.3")).toBe(false);
    expect(isExpectedCodexProtocolVersion("codex-cli 0.145.0", "0.144.3")).toBe(false);
  });
});

describe("Codex decoded response field audit", () => {
  const turnsList = {
    definitions: {
      Turn: {
        properties: { id: { type: "string" }, items: { type: "array", items: {} } },
        type: "object",
      },
      Account: {
        oneOf: [
          { properties: { type: { enum: ["apiKey"] } } },
          { properties: { type: { enum: ["chatgpt"] }, planType: { type: "string" } } },
        ],
      },
    },
    properties: {
      data: { items: { $ref: "#/definitions/Turn" }, type: "array" },
      nextCursor: { type: ["string", "null"] },
      account: { anyOf: [{ $ref: "#/definitions/Account" }, { type: "null" }] },
      thread: { allOf: [{ $ref: "#/definitions/Turn" }] },
    },
  };

  it("resolves refs, combinators and array items", () => {
    expect(codexJsonSchemaHasField(turnsList, "data[].id")).toBe(true);
    expect(codexJsonSchemaHasField(turnsList, "data[].items")).toBe(true);
    expect(codexJsonSchemaHasField(turnsList, "nextCursor")).toBe(true);
    expect(codexJsonSchemaHasField(turnsList, "account.planType")).toBe(true);
    expect(codexJsonSchemaHasField(turnsList, "thread.id")).toBe(true);
  });

  it("rejects renamed fields and non-array steps", () => {
    expect(codexJsonSchemaHasField(turnsList, "data[].itemsView")).toBe(false);
    expect(codexJsonSchemaHasField(turnsList, "nextCursor[]")).toBe(false);
    expect(codexJsonSchemaHasField(turnsList, "missing")).toBe(false);
  });

  it("reports missing fields and skips methods the CLI does not offer", () => {
    const report = auditCodexResponseFields(
      (schema) => (schema === "list.json" ? turnsList : undefined),
      new Set(["thread/turns/list", "turn/start"]),
      {
        "thread/turns/list": { schema: "list.json", fields: ["data[].id", "data[].renamed"] },
        "turn/start": { schema: "turn.json", fields: ["turn.id"] },
        "thread/revert": { schema: "revert.json", fields: ["thread.id"] },
      },
    );
    expect(report).toEqual({
      missingFields: ["thread/turns/list list.json: data[].renamed"],
      missingSchemas: ["turn/start turn.json"],
      skippedMethods: ["thread/revert"],
    });
  });
});
