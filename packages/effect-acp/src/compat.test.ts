import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { InitializeRequest, SessionNotification } from "./compat";
import type { ClientCapabilities } from "./schema";

describe("session notice compatibility", () => {
  const decode = Schema.decodeUnknownSync(SessionNotification);
  it("preserves valid notices separately from reply text", () => {
    const update = {
      sessionUpdate: "notice",
      severity: "warning",
      title: "Skipped skill",
      description: "The skill could not be loaded.",
    };
    expect(decode({ sessionId: "session", update }).update).toEqual(update);
  });
  it.each([
    { sessionUpdate: "notice", severity: "warning" },
    { sessionUpdate: "notice", severity: 42, title: "Warning" },
    { sessionUpdate: "notice", severity: "warning", title: "" },
  ])("rejects malformed notices: %j", (update) => {
    expect(() => decode({ sessionId: "session", update })).toThrow();
  });
  it("preserves notice capabilities on the initialize wire", () => {
    const capabilities: ClientCapabilities = { session: { notices: {} } };
    const request = {
      protocolVersion: 1,
      clientCapabilities: capabilities,
    };
    expect(Schema.encodeSync(InitializeRequest)(request)).toEqual(request);
  });
});
