import { describe, expect, it } from "vitest";
import { describeMcpElicitation, mcpElicitationResponse } from "./mcpElicitation.ts";

const request = {
  mode: "form",
  serverName: "apps",
  message: "Allow ChatGPT to use Calendar?",
  requestedSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        oneOf: [
          { const: "once", title: "Once" },
          { const: "session", title: "Session" },
          { const: "always", title: "Always" },
        ],
      },
    },
    required: ["scope"],
  },
};
describe("MCP app approval", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "session"],
    ["acceptAlways", "always"],
  ] as const)("maps %s to the advertised choice", (decision, value) => {
    expect(mcpElicitationResponse(request, decision)).toEqual({
      action: "accept",
      content: { scope: value },
      ...(decision === "accept" ? {} : { _meta: { persist: value } }),
    });
  });
  it("names the app and exposes only representable choices", () => {
    expect(describeMcpElicitation(request).appName).toBe("Calendar");
    expect(
      describeMcpElicitation(request).approvalOptions.map((option) => option.decision),
    ).toEqual(["cancel", "decline", "acceptForSession", "acceptAlways", "accept"]);
    const onceOnly = { ...request, requestedSchema: { type: "object", properties: {} } };
    expect(
      describeMcpElicitation(onceOnly).approvalOptions.map((option) => option.decision),
    ).toEqual(["cancel", "decline", "accept"]);
    expect(mcpElicitationResponse(onceOnly, "acceptAlways")).toEqual({ action: "decline" });
  });
  it("never approves a URL request or invents required answers", () => {
    for (const payload of [
      { ...request, mode: "url" },
      {
        ...request,
        requestedSchema: {
          type: "object",
          required: ["password"],
          properties: { password: { type: "string" } },
        },
      },
      { ...request, requestedSchema: null },
    ]) {
      expect(mcpElicitationResponse(payload, "accept")).toEqual({ action: "decline" });
      expect(
        describeMcpElicitation(payload).approvalOptions.map((option) => option.decision),
      ).toEqual(["cancel", "decline"]);
    }
  });
  it("accept once never inherits a persistent default", () => {
    const payload = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: { persist: { type: "boolean", default: true } },
        required: ["persist"],
      },
    };
    expect(mcpElicitationResponse(payload, "accept")).toEqual({
      action: "accept",
      content: { persist: false },
    });
    expect(mcpElicitationResponse(payload, "acceptAlways")).toEqual({
      action: "accept",
      content: { persist: true },
      _meta: { persist: "always" },
    });
  });
  it.each(["cancel", "decline"] as const)("preserves %s without grants", (decision) => {
    expect(mcpElicitationResponse(request, decision)).toEqual({ action: decision });
  });
});
