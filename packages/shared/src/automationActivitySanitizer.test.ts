import { describe, expect, it } from "vitest";
import {
  AutomationEventSanitizer,
  sanitizeAutomationToolPayload,
} from "./automationActivitySanitizer";
const provenance = { serverName: "f5_computer", verified: true, kind: "f5-computer" } as const;
describe("computer persistence sanitization", () => {
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
