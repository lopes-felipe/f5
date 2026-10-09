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
  it("treats a Codex 0.160.1 MCP tool-call consent prompt as an approval", () => {
    // Captured live from codex-cli 0.160.1 in approval-required mode.
    const toolCall = {
      serverName: "f5probe",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_description: "Asks the user for a token.",
        tool_params: {},
        tool_params_display: [],
      },
      message: 'Allow the f5probe MCP server to run tool "ask_token"?',
      requestedSchema: { type: "object", properties: {} },
    };
    expect(describeMcpElicitation(toolCall)).toMatchObject({
      appName: "f5probe",
      approvalOptions: [
        { decision: "cancel" },
        { decision: "decline" },
        { decision: "acceptForSession" },
        { decision: "acceptAlways" },
        { decision: "accept" },
      ],
    });
    expect(mcpElicitationResponse(toolCall, "accept")).toEqual({ action: "accept", content: {} });
    expect(mcpElicitationResponse(toolCall, "acceptForSession")).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "session" },
    });
    // Without the consent marker an empty form is still not an approval.
    const { _meta: _ignored, ...unmarked } = toolCall;
    expect(mcpElicitationResponse(unmarked, "accept")).toEqual({ action: "decline" });
  });

  it("accept once never inherits a persistent default", () => {
    const payload = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: { persist: { type: "boolean", title: "always", default: true } },
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

it.each([
  { optional_text: { type: "string" } },
  { remember: { type: "boolean", default: true } },
  { consent: { type: "string", enum: ["disallow", "allow_all_tools"] } },
])("rejects hidden or unrecognised form fields: %j", (properties) => {
  const payload = { ...request, requestedSchema: { type: "object", properties } };
  for (const decision of ["accept", "acceptForSession", "acceptAlways"] as const)
    expect(mcpElicitationResponse(payload, decision)).toEqual({ action: "decline" });
});
it("never selects allow_all_tools for approve once", () => {
  const payload = {
    ...request,
    requestedSchema: {
      type: "object",
      properties: {
        consent: { type: "string", enum: ["allow_all_tools", "allow_once"] },
      },
    },
  };
  expect(mcpElicitationResponse(payload, "accept")).toEqual({
    action: "accept",
    content: { consent: "allow_once" },
  });
});
it("offers session consent only for a session-scoped boolean", () => {
  const payload = {
    ...request,
    requestedSchema: {
      type: "object",
      properties: {
        persist: { type: "boolean", title: "this session", default: true },
      },
    },
  };
  expect(mcpElicitationResponse(payload, "accept")).toEqual({
    action: "accept",
    content: { persist: false },
  });
  expect(mcpElicitationResponse(payload, "acceptForSession")).toEqual({
    action: "accept",
    content: { persist: true },
    _meta: { persist: "session" },
  });
  expect(mcpElicitationResponse(payload, "acceptAlways")).toEqual({ action: "decline" });
});
it("does not turn an arbitrary empty data form into app approval", () => {
  expect(
    mcpElicitationResponse(
      { ...request, message: "Collect optional data", requestedSchema: { type: "object" } },
      "accept",
    ),
  ).toEqual({ action: "decline" });
});
