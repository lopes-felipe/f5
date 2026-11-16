import { Schema } from "effect";
import type { SessionNotification } from "effect-acp/schema";
import { expect, it } from "vitest";
import {
  CopilotAcpSessionEvent,
  isCopilotAcpCommand,
  makeCopilotAcpRouting,
} from "./CopilotAcpRouting.ts";

const chunk = (text: string, sessionId = "root"): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const tool = (agentId: string): SessionNotification => ({
  sessionId: "root",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "child-tool",
    status: "completed",
    _meta: { "github.com/copilot": { agentId } },
  },
});

it.each(["copilot", "/usr/bin/copilot", "C:\\tools\\COPILOT.EXE", "C:\\tools\\copilot.cmd"])(
  "recognizes an explicit Copilot executable %s",
  (command) => expect(isCopilotAcpCommand(command)).toBe(true),
);
it.each(["node", "copilot-helper", "/tools/other/copilot.cjs", "mise"])(
  "leaves another agent's capabilities alone: %s",
  (command) => expect(isCopilotAcpCommand(command)).toBe(false),
);

it("uses session-local attribution, including identical parent and child text", () => {
  const routing = makeCopilotAcpRouting();
  routing.onEvent({
    sessionId: "root",
    type: "subagent.started",
    agentId: "child",
    data: { toolCallId: "task" },
  });
  routing.onEvent({
    sessionId: "root",
    type: "assistant.message_delta",
    data: { parentToolCallId: "task", deltaContent: "identical" },
  });
  const another = chunk("identical", "other-root");
  expect(routing.normalize(another)).toBe(another);
  expect(routing.normalize(chunk("identical"))).toBeUndefined();
  routing.onEvent({
    sessionId: "root",
    type: "assistant.message_delta",
    data: { parentToolCallId: null, deltaContent: "identical" },
  });
  const parent = chunk("identical");
  expect(routing.normalize(parent)).toBe(parent);
});

it("does not publish unattributed chunks while native children are active", () => {
  const routing = makeCopilotAcpRouting();
  routing.onEvent({
    sessionId: "root",
    type: "subagent.started",
    agentId: "child",
    data: { toolCallId: "task" },
  });
  expect(routing.normalize(chunk("unattributed"))).toBeUndefined();
  routing.onEvent({
    sessionId: "root",
    type: "assistant.message_delta",
    data: { parentToolCallId: "task", deltaContent: "x".repeat(131073) },
  });
  expect(routing.normalize(chunk("unattributed"))).toBeUndefined();
  routing.onEvent({
    sessionId: "root",
    type: "assistant.message_delta",
    data: { parentToolCallId: 42, deltaContent: "malformed owner" },
  });
  expect(routing.normalize(chunk("malformed owner"))).toBeUndefined();
});

it("keeps late child tools private after completion and clears ownership on disposal", () => {
  const routing = makeCopilotAcpRouting();
  routing.onEvent({
    sessionId: "root",
    type: "subagent.started",
    agentId: "child",
    data: { toolCallId: "task" },
  });
  routing.onEvent({ sessionId: "root", type: "subagent.failed", agentId: "child" });
  expect(routing.normalize(tool("child"))).toBeUndefined();
  routing.clear();
  const fresh = tool("child");
  expect(routing.normalize(fresh)).toBe(fresh);
});

it("bounds retained native identities without exposing evicted child tool output", () => {
  const routing = makeCopilotAcpRouting();
  for (let n = 0; n < 300; n++) {
    routing.onEvent({
      sessionId: "root",
      type: "subagent.started",
      agentId: String(n),
      data: { toolCallId: `task-${n}` },
    });
    routing.onEvent({ sessionId: "root", type: "subagent.completed", agentId: String(n) });
  }
  expect(routing.normalize(tool("0"))).toBeUndefined();
  routing.onEvent({
    sessionId: "root",
    type: "assistant.message_delta",
    data: { deltaContent: "public" },
  });
  const parent = chunk("public");
  expect(routing.normalize(parent)).toBe(parent);
  for (let n = 0; n < 70; n++)
    routing.onEvent({
      sessionId: `other-${n}`,
      type: "subagent.started",
      agentId: "child",
      data: { toolCallId: "task" },
    });
  expect(routing.normalize(chunk("unattributed", "untracked-root"))).toBeUndefined();
});

it("rejects malformed or oversized native identity envelopes", () => {
  for (const event of [
    { sessionId: "", type: "subagent.started" },
    { sessionId: "root", type: "subagent.started", agentId: "x".repeat(1025) },
    { sessionId: "root", type: "subagent.started", data: [] },
  ]) {
    expect(() => Schema.decodeUnknownSync(CopilotAcpSessionEvent)(event)).toThrow();
  }
});
