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
