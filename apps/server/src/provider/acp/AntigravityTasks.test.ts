import { describe, expect, it } from "vitest";
import { AntigravityTasks } from "./AntigravityTasks.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const launch: AcpToolCallState = {
  toolCallId: "batch-1",
  kind: "other",
  title: "Running start_subagent",
  status: "completed",
  data: { rawOutput: "Launched two agents" },
};

describe("Antigravity subagent tasks", () => {
  it("does not settle children launched while a native status read is in flight", () => {
    const tasks = new AntigravityTasks();
    tasks.update(launch, {});
    const observed = tasks.taskIds;
    tasks.update({ ...launch, toolCallId: "batch-2" }, {});
    expect(tasks.settleDetached([], observed)).toMatchObject([
      { type: "task.completed", payload: { taskId: "batch-1" } },
    ]);
    expect(tasks.taskIds).toEqual(["batch-2"]);
  });
  it("keeps detached children visible until their native record settles", () => {
    const tasks = new AntigravityTasks();
    const native = {
      ...launch,
      title: "Running invoke_subagent",
      data: { rawInput: { Role: "Research", Prompt: "Read the code" } },
    };
    expect(tasks.update(native, {})[0]).toMatchObject({
      payload: { description: "Research", prompt: "Read the code" },
    });
    expect(tasks.settleDetached(["batch-1"])).toEqual([]);
    expect(tasks.taskIds).toEqual(["batch-1"]);
    expect(tasks.settleDetached([])).toMatchObject([
      { type: "task.completed", payload: { status: "completed" } },
    ]);
    expect(tasks.taskIds).toEqual([]);
  });
  it("keeps a launched batch active until the turn ends", () => {
    const tasks = new AntigravityTasks();
    expect(tasks.update(launch, {}).map((event) => event.type)).toEqual([
      "task.started",
      "task.progress",
    ]);
    expect(tasks.update(launch, {}).map((event) => event.type)).toEqual(["task.progress"]);
    expect(tasks.finish()).toMatchObject([
      { type: "task.completed", payload: { taskId: "batch-1", status: "stopped" } },
    ]);
    expect(tasks.finish()).toEqual([]);
  });
  it("reports launch failure once and bounds output", () => {
    const tasks = new AntigravityTasks();
    const events = tasks.update(
      { ...launch, status: "failed", data: { rawOutput: "x".repeat(10_000) } },
      {},
    );
    expect(events[1]).toMatchObject({
      type: "task.completed",
      payload: { status: "failed", summary: "x".repeat(8_000) },
    });
    expect(tasks.finish()).toEqual([]);
  });
  it("does not mistake MCP or unrelated tools for native subagents", () => {
    const tasks = new AntigravityTasks();
    expect(tasks.update(launch, { update: { _meta: { is_mcp_tool_call: true } } })).toEqual([]);
    expect(tasks.update({ ...launch, title: "Other tool" }, {})).toEqual([]);
    expect(tasks.finish()).toEqual([]);
  });
});
