import { RuntimeTaskId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
type TaskEvent = Pick<
  Extract<ProviderRuntimeEvent, { type: "task.started" | "task.progress" | "task.completed" }>,
  "type" | "payload"
>;

/** start_subagent completes when the batch launches, not when its agents finish. */
export class AntigravityTasks {
  private readonly active = new Set<string>();
  update(tool: AcpToolCallState, raw: unknown): TaskEvent[] {
    const update = raw && typeof raw === "object" && "update" in raw ? raw.update : undefined;
    const meta =
      update && typeof update === "object" && "_meta" in update ? update._meta : undefined;
    if (
      meta &&
      typeof meta === "object" &&
      "is_mcp_tool_call" in meta &&
      meta.is_mcp_tool_call === true
    )
      return [];
    if (tool.kind && tool.kind !== "other") return [];
    if (
      !this.active.has(tool.toolCallId) &&
      tool.title !== "Running start_subagent" &&
      tool.title !== "Run start_subagent?"
    )
      return [];
    const taskId = RuntimeTaskId.make(tool.toolCallId);
    const events: TaskEvent[] = [];
    if (!this.active.has(tool.toolCallId)) {
      this.active.add(tool.toolCallId);
      events.push({
        type: "task.started",
        payload: { taskId, taskType: "subagent", description: "Antigravity subagent batch" },
      });
    }
    const output =
      typeof tool.data.rawOutput === "string" ? tool.data.rawOutput.trim().slice(-8000) : "";
    if (tool.status === "failed") {
      this.active.delete(tool.toolCallId);
      events.push({
        type: "task.completed",
        payload: { taskId, status: "failed", ...(output ? { summary: output } : {}) },
      });
    } else
      events.push({
        type: "task.progress",
        payload: {
          taskId,
          description: output || "Subagent batch running; individual agent status is unavailable.",
        },
      });
    return events;
  }
  finish(): TaskEvent[] {
    const events = [...this.active].map((id) => ({
      type: "task.completed" as const,
      payload: {
        taskId: RuntimeTaskId.make(id),
        status: "stopped" as const,
        summary: "Turn ended. Individual agent status is unavailable.",
      },
    }));
    this.active.clear();
    return events;
  }
}
