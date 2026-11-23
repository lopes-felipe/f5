import { describe, expect, it } from "vitest";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import { CursorOpenToolCalls, cursorToolCallWithExitStatus } from "./CursorToolCalls.ts";

const tool = (toolCallId: string, status: AcpToolCallState["status"]) =>
  ({ toolCallId, status, kind: "execute", data: {} }) as unknown as AcpToolCallState;

describe("CursorOpenToolCalls", () => {
  it("keeps the originating turn for later updates, including while idle", () => {
    const open = new CursorOpenToolCalls();
    expect(open.observe(tool("bg", "inProgress"), "turn-1")).toBe("turn-1");
    expect(open.observe(tool("bg", "inProgress"), "turn-2")).toBe("turn-1");
    expect(open.observe(tool("bg", "completed"), undefined)).toBe("turn-1");
    // Forgotten once finished; a new id takes the active turn.
    expect(open.observe(tool("other", "completed"), undefined)).toBeUndefined();
  });

  it("interrupts only the stopped turn's tools, and every tool when the session ends", () => {
    const open = new CursorOpenToolCalls();
    open.observe(tool("dev-server", "inProgress"), "turn-1");
    open.observe(tool("build", "inProgress"), "turn-3");

    const stopped = open.drainInterrupted("turn-3");
    expect(stopped.map((entry) => [entry.toolCall.toolCallId, entry.turnId])).toEqual([
      ["build", "turn-3"],
    ]);
    expect(stopped[0]?.toolCall.status).toBe("failed");

    const ended = open.drainInterrupted();
    expect(ended.map((entry) => [entry.toolCall.toolCallId, entry.turnId])).toEqual([
      ["dev-server", "turn-1"],
    ]);
    expect(open.drainInterrupted()).toEqual([]);
  });

  it("keeps an idle-opened tool unowned and a drained tool's late update in its turn", () => {
    const open = new CursorOpenToolCalls();
    expect(open.observe(tool("idle", "inProgress"), undefined)).toBeUndefined();
    // Seen first while idle: a later turn does not adopt it.
    expect(open.observe(tool("idle", "inProgress"), "turn-2")).toBeUndefined();

    open.observe(tool("build", "inProgress"), "turn-3");
    open.drainInterrupted("turn-3");
    // Cursor reports after the stop: still turn 3, not the turn now active, and not reopened.
    expect(open.observe(tool("build", "inProgress"), "turn-4")).toBe("turn-3");
    expect(open.drainInterrupted("turn-4")).toEqual([]);
    expect(open.observe(tool("build", "completed"), "turn-4")).toBe("turn-3");
  });
});

describe("cursorToolCallWithExitStatus", () => {
  it("marks a completed command with a non-zero exit as failed", () => {
    const result = cursorToolCallWithExitStatus({
      ...tool("cmd", "completed"),
      data: { rawOutput: { exitCode: 2 } },
    } as unknown as AcpToolCallState);
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("Exited with code 2.");
  });
});
