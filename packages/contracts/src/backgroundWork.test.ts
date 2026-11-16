import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AgentsReadTranscriptInput, AgentTranscriptItem } from "./backgroundWork";
describe("agent transcript contracts", () => {
  it("bounds requested ownership sets, cursors and page sizes", () => {
    const base = { threadId: "thread", workItemIds: ["agent"] };
    expect(Schema.is(AgentsReadTranscriptInput)(base)).toBe(true);
    for (const extra of [
      { workItemIds: [] },
      { workItemIds: Array(17).fill("agent") },
      { workItemIds: [" "] },
      { limit: 0 },
      { limit: 501 },
      { cursor: "x".repeat(2049) },
    ])
      expect(Schema.is(AgentsReadTranscriptInput)({ ...base, ...extra })).toBe(false);
  });
  it("rejects non-canonical tool types", () => {
    expect(
      Schema.is(AgentTranscriptItem)({
        id: "tool",
        createdAt: null,
        kind: "tool-call",
        toolCallId: "tool",
        toolName: "test",
        itemType: "arbitrary",
        title: "Test",
        detail: "",
        status: "running",
        output: "",
        outputTruncated: false,
      }),
    ).toBe(false);
  });
});
