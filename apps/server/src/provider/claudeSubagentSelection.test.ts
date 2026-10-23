import { expect, it } from "vitest";
import {
  rememberClaudeSubagentLaunch,
  resolveClaudeSubagentEffort,
  type ClaudeSubagentLaunch,
} from "./claudeSubagentSelection.ts";
const fixture = () => ({
  pending: new Map<string, ClaudeSubagentLaunch>(),
  reportedModels: new Map<string, string>(),
  tasks: [] as { toolUseId: string; model: string; effort?: string }[],
  sessionModel: "claude-opus-5-5",
  sessionEffort: "high",
});
it("retains a native explicit effort and model instead of the parent's selection", () => {
  const f = fixture();
  rememberClaudeSubagentLaunch({
    ...f,
    toolUseId: "child",
    ownerToolUseId: null,
    arguments: { model: "claude-sonnet-4-6", effort: "low" },
  });
  expect(f.pending.get("child")).toEqual({ model: "claude-sonnet-4-6", effort: "low" });
  expect(resolveClaudeSubagentEffort("claude-sonnet-4-6", "low")).toBe("low");
});
it("inherits the actual owner's model and launch effort for nested agents", () => {
  const f = fixture();
  f.pending.set("owner", { model: "claude-opus-5-5", effort: "low" });
  f.reportedModels.set("owner", "claude-sonnet-4-6");
  rememberClaudeSubagentLaunch({
    ...f,
    toolUseId: "nested",
    ownerToolUseId: "owner",
    arguments: { model: "inherit" },
  });
  expect(f.pending.get("nested")).toEqual({
    model: "claude-sonnet-4-6",
    effort: "low",
    ownerToolUseId: "owner",
  });
});
it("does not invent the parent session's model for an unknown nested owner", () => {
  const f = fixture();
  rememberClaudeSubagentLaunch({
    ...f,
    toolUseId: "nested",
    ownerToolUseId: "unknown",
    arguments: {},
  });
  expect(f.pending.get("nested")).toEqual({ ownerToolUseId: "unknown" });
});
it("retains nested effort inheritance while hiding effort unsupported by a child's model", () => {
  const f = fixture();
  rememberClaudeSubagentLaunch({
    ...f,
    toolUseId: "haiku",
    ownerToolUseId: null,
    arguments: { model: "claude-haiku-4-5" },
  });
  expect(f.pending.get("haiku")?.effort).toBe("high");
  expect(resolveClaudeSubagentEffort("claude-haiku-4-5", "high")).toBeNull();
  rememberClaudeSubagentLaunch({
    ...f,
    toolUseId: "nested",
    ownerToolUseId: "haiku",
    arguments: { model: "claude-opus-5-5" },
  });
  expect(f.pending.get("nested")?.effort).toBe("high");
});
it("keeps launch metadata bounded", () => {
  const f = fixture();
  for (let i = 0; i < 100; i++)
    rememberClaudeSubagentLaunch({
      ...f,
      toolUseId: String(i),
      ownerToolUseId: null,
      arguments: {},
    });
  expect(f.pending.size).toBe(64);
  expect(f.pending.has("0")).toBe(false);
});

it("uses a configured subagent default only when the Agent call does not explicitly inherit", () => {
  const f = fixture();
  rememberClaudeSubagentLaunch({
    ...f,
    defaultSubagentModel: "claude-sonnet-4-6",
    toolUseId: "default-child",
    ownerToolUseId: null,
    arguments: {},
  });
  rememberClaudeSubagentLaunch({
    ...f,
    defaultSubagentModel: "claude-sonnet-4-6",
    toolUseId: "inherited-child",
    ownerToolUseId: null,
    arguments: { model: "inherit" },
  });
  expect(f.pending.get("default-child")?.model).toBe("claude-sonnet-4-6");
  expect(f.pending.get("inherited-child")?.model).toBe("claude-opus-5-5");
});
