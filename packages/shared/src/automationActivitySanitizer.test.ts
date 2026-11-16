import { describe, expect, it } from "vitest";
import {
  AutomationEventSanitizer,
  sanitizeAutomationToolPayload,
} from "./automationActivitySanitizer";
const provenance = { serverName: "f5_computer", verified: true, kind: "f5-computer" } as const;
describe("computer persistence sanitization", () => {
  it("reconstructs Codex identities only from the registered server and strips raw arguments", () => {
    const sanitizer = new AutomationEventSanitizer();
    sanitizer.register("a", { ...provenance, serverName: "__f5_computer" });
    const safe = sanitizer.sanitize("a", {
      type: "item.completed",
      itemId: "call",
      threadId: "a",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            id: "call",
            server: "__f5_computer",
            tool: "computer_type",
            arguments: { text: "SENTINEL" },
            result: { text: "SENTINEL" },
          },
        },
      },
    });
    expect(safe).toMatchObject({
      payload: {
        data: {
          item: {
            toolName: "mcp____f5_computer__computer_type",
            server: "__f5_computer",
          },
        },
      },
    });
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
  });
  it("keeps verified tool identities through lifecycle data envelopes and repeated sanitization", () => {
    const sanitizer = new AutomationEventSanitizer();
    sanitizer.register("a", provenance);
    const event = {
      type: "item.updated",
      threadId: "a",
      itemId: "computer-status",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "SENTINEL",
        data: {
          toolName: "mcp__f5_computer__computer_status",
          input: { text: "SENTINEL", x: 4 },
          result: {
            error: { _tag: "Unavailable", detail: "SENTINEL" },
            nodes: [{ name: "SENTINEL" }],
          },
        },
      },
    };
    const once = sanitizer.sanitize("a", event);
    const twice = sanitizer.sanitize("a", once);
    expect(twice).toMatchObject({
      payload: {
        data: {
          toolName: "mcp__f5_computer__computer_status",
          input: { x: 4, sanitized: true },
          result: { error: { _tag: "Unavailable" }, sanitized: true },
        },
      },
    });
    expect(JSON.stringify(twice)).not.toContain("SENTINEL");
    const lookalike = {
      payload: {
        data: { toolName: "mcp__f5_computer_other__computer_type", input: { text: "ordinary" } },
      },
    };
    expect(sanitizer.sanitize("a", lookalike)).toEqual(lookalike);
  });
  it("bounds identity memory and keeps late results redacted after saturation", () => {
    const sanitizer = new AutomationEventSanitizer(2);
    sanitizer.register("a", provenance);
    for (const id of ["1", "2", "3"])
      sanitizer.sanitize("a", {
        itemId: id,
        payload: { toolName: "mcp__f5_computer__computer_type", text: "SENTINEL" },
      });
    for (const id of ["1", "2", "3", "unknown"])
      expect(
        JSON.stringify(sanitizer.sanitize("a", { itemId: id, payload: { output: "SENTINEL" } })),
      ).not.toContain("SENTINEL");
    expect(sanitizer.isComputerItem("a", "unknown")).toBe(true);
    sanitizer.clear("a");
    expect(sanitizer.sanitize("a", { output: "ordinary" })).toEqual({ output: "ordinary" });
    expect(sanitizer.isComputerItem("a", "unknown")).toBe(false);
  });
  it("preserves correlated approval choices without provider text or tool contents", () => {
    const sanitizer = new AutomationEventSanitizer();
    sanitizer.register("a", provenance);
    sanitizer.sanitize("a", {
      itemId: "call",
      payload: { toolName: "mcp__f5_computer__computer_type" },
    });
    const safe = sanitizer.sanitize("a", {
      type: "request.opened",
      threadId: "a",
      itemId: "call",
      requestId: "approval",
      payload: {
        requestType: "mcp_elicitation_approval",
        detail: "SENTINEL",
        args: { text: "SENTINEL" },
        raw: {
          type: "request.opened",
          requestId: "SENTINEL",
          payload: {
            requestType: "mcp_elicitation_approval",
            approvalOptions: [{ decision: "accept", label: "SENTINEL" }],
          },
        },
        approvalOptions: [
          { decision: "accept", label: "SENTINEL", warning: "SENTINEL" },
          { decision: "decline", label: "SENTINEL" },
          { decision: "SENTINEL", label: "SENTINEL" },
        ],
        presentation: { title: "SENTINEL", defaultToNo: true, suppressAlwaysAllowRule: true },
      },
    });
    expect(safe).toMatchObject({
      requestId: "approval",
      payload: {
        requestType: "mcp_elicitation_approval",
        approvalOptions: [
          { decision: "accept", label: "Approve once" },
          { decision: "decline", label: "Decline" },
        ],
        presentation: { defaultToNo: true, suppressAlwaysAllowRule: true },
      },
    });
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    expect(
      sanitizer.sanitize("a", {
        type: "request.resolved",
        itemId: "call",
        requestId: "approval",
        payload: {
          requestType: "mcp_elicitation_approval",
          decision: "accept",
          resolution: { text: "SENTINEL" },
        },
      }),
    ).toMatchObject({
      requestId: "approval",
      payload: { requestType: "mcp_elicitation_approval", decision: "accept" },
    });
  });
  it("drops typed text, semantic values, AX names and nested error detail", () => {
    const payload = {
      op: "type",
      text: "SENTINEL",
      input: { value: "SENTINEL", name: "SENTINEL" },
      error: { _tag: "Execution", message: "SENTINEL", detail: { password: "SENTINEL" } },
      nodes: [{ name: "SENTINEL", value: "SENTINEL" }],
      rect: { x: 4, y: 6, width: 10, height: 10 },
    };
    const safe = sanitizeAutomationToolPayload(
      "mcp__f5_computer__computer_type",
      payload,
      provenance,
    );
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    expect(safe).toMatchObject({ op: "type", rect: { x: 4, y: 6 } });
    expect(payload.text).toBe("SENTINEL");
  });
  it("does not trust look-alike server prefixes", () => {
    const value = { text: "SENTINEL" };
    expect(
      sanitizeAutomationToolPayload("mcp__f5_computer_evil__computer_type", value, provenance),
    ).toBe(value);
    expect(
      sanitizeAutomationToolPayload("mcp__f5_computer__computer_type", value, {
        ...provenance,
        verified: false,
      }),
    ).toBe(value);
  });
  it("removes cua_repl JavaScript and raw text entirely", () => {
    expect(
      JSON.stringify(
        sanitizeAutomationToolPayload(
          "mcp__cua_repl__js",
          { code: "SENTINEL", result: "SENTINEL" },
          { serverName: "cua_repl", verified: true, kind: "codex-builtin" },
        ),
      ),
    ).not.toContain("SENTINEL");
  });
  it("registers normal assistant-message call IDs before redacting the message envelope", () => {
    const sanitizer = new AutomationEventSanitizer();
    sanitizer.register("a", provenance);
    const assistant = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "native-call",
            name: "mcp__f5_computer__computer_type",
            input: { text: "SENTINEL" },
          },
          { type: "tool_use", id: "other-call", name: "mcp__untrusted__computer_type", input: {} },
        ],
      },
    };
    expect(JSON.stringify(sanitizer.sanitize("a", assistant))).not.toContain("SENTINEL");
    expect(sanitizer.isComputerItem("a", "native-call")).toBe(true);
    expect(sanitizer.isComputerItem("a", "other-call")).toBe(false);
    const safe = sanitizer.sanitize("a", {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "native-call", content: "SENTINEL" }],
      },
    });
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    sanitizer.clear("a");
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    expect(assistant.message.content[0]?.input).toEqual({ text: "SENTINEL" });
  });
  it("tracks SDK tool results and streamed input deltas by provenance", () => {
    const sanitizer = new AutomationEventSanitizer();
    sanitizer.register("a", provenance);
    sanitizer.sanitize("a", {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "call",
        name: "mcp__f5_computer__computer_type",
        input: {},
      },
    });
    expect(
      JSON.stringify(
        sanitizer.sanitize("a", {
          type: "content_block_delta",
          index: 2,
          delta: { partial_json: '{"text":"SENTINEL"}' },
        }),
      ),
    ).not.toContain("SENTINEL");
    expect(
      JSON.stringify(
        sanitizer.sanitize("a", {
          type: "tool_result",
          tool_use_id: "call",
          content: [{ type: "text", text: "SENTINEL" }],
        }),
      ),
    ).not.toContain("SENTINEL");
    expect(
      JSON.stringify(
        sanitizer.sanitize("b", { type: "tool_result", tool_use_id: "call", content: "SENTINEL" }),
      ),
    ).toContain("SENTINEL");
  });
  it("does not interpret accessibility names as tool identities or retain arbitrary nested values", () => {
    const sanitizer = new AutomationEventSanitizer();
    sanitizer.register("a", provenance);
    sanitizer.sanitize("a", {
      itemId: "inspect",
      payload: { toolName: "mcp__f5_computer__computer_inspect" },
    });
    const safe = sanitizer.sanitize("a", {
      type: "item.completed",
      itemId: "inspect",
      threadId: "a",
      payload: {
        itemType: "mcpToolCall",
        data: {
          nodes: [
            { name: "SENTINEL", value: "SENTINEL", bounds: { x: 5, y: 8 } },
            { value: "SENTINEL" },
          ],
          nested: { unknown: "SENTINEL" },
          error: { detail: "SENTINEL" },
        },
      },
    });
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    expect(safe).toMatchObject({
      type: "item.completed",
      itemId: "inspect",
      payload: { itemType: "mcpToolCall" },
    });
  });
});

it("preserves projected assistant text while redacting nested tool blocks", () => {
  const sanitizer = new AutomationEventSanitizer();
  sanitizer.register("mixed", provenance);
  const raw = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll take a screenshot." },
        {
          type: "tool_use",
          id: "computer-tool",
          name: "mcp__f5_computer__computer_type",
          input: { text: "SECRET_SENTINEL" },
        },
      ],
    },
  };
  const safe = sanitizer.sanitize("mixed", {
    type: "content.delta",
    itemId: "assistant-text",
    payload: { streamKind: "assistant_text", delta: "I'll take a screenshot." },
    raw,
  }) as any;
  expect(safe.payload.delta).toBe("I'll take a screenshot.");
  expect(JSON.stringify(sanitizer.sanitize("mixed", raw))).toContain("I'll take a screenshot.");
  expect(JSON.stringify(safe)).not.toContain("SECRET_SENTINEL");
  expect(sanitizer.isComputerItem("mixed", "assistant-text")).toBe(false);
  const completed = sanitizer.sanitize("mixed", {
    type: "item.completed",
    itemId: "assistant-text",
    payload: {
      itemType: "assistant_message",
      detail: "I'll take a screenshot.",
      title: "Assistant message",
    },
    raw,
  }) as any;
  expect(completed.payload.detail).toBe("I'll take a screenshot.");
  expect(JSON.stringify(completed)).not.toContain("SECRET_SENTINEL");
});
it("retains old tool identities until the adapter has stopped its event stream", () => {
  const sanitizer = new AutomationEventSanitizer();
  const release = sanitizer.retain("restart");
  sanitizer.register("restart", provenance);
  sanitizer.sanitize("restart", {
    type: "tool_use",
    id: "old-call",
    name: "mcp__f5_computer__computer_inspect",
    input: {},
  });
  sanitizer.clear("restart");
  sanitizer.register("restart", provenance);
  expect(
    JSON.stringify(
      sanitizer.sanitize("restart", {
        type: "tool_result",
        tool_use_id: "old-call",
        content: [{ type: "text", text: "SECRET_SENTINEL" }],
      }),
    ),
  ).not.toContain("SECRET_SENTINEL");
  release();
  expect(sanitizer.isComputerItem("restart", "old-call")).toBe(false);
});
