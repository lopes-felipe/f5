import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isSupersedableToolUpdate, makeToolUpdateCoalescer } from "./toolUpdateCoalescing.ts";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");

describe("makeToolUpdateCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the newest update per key in the order of the latest update", () => {
    const coalescer = makeToolUpdateCoalescer<string>({ onWindowClosed: () => {} });
    coalescer.offer(threadA, "a", "a1");
    coalescer.offer(threadA, "b", "b1");
    coalescer.offer(threadA, "a", "a2");

    expect(coalescer.take(threadA)).toEqual(["b1", "a2"]);
    expect(coalescer.take(threadA)).toEqual([]);
  });

  it("keeps threads apart", () => {
    const coalescer = makeToolUpdateCoalescer<string>({ onWindowClosed: () => {} });
    coalescer.offer(threadA, "a", "a1");
    coalescer.offer(threadB, "a", "b1");

    expect(coalescer.take(threadA)).toEqual(["a1"]);
    expect(coalescer.threadIds()).toEqual([threadB]);
  });

  it("closes the window a fixed time after its first update", () => {
    const closed: ThreadId[] = [];
    const coalescer = makeToolUpdateCoalescer<string>({
      windowMs: 50,
      onWindowClosed: (threadId) => closed.push(threadId),
    });
    coalescer.offer(threadA, "a", "a1");
    vi.advanceTimersByTime(30);
    coalescer.offer(threadA, "a", "a2");
    vi.advanceTimersByTime(19);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closed).toEqual([threadA]);
  });

  it("does not report a window that was already taken or discarded", () => {
    const closed: ThreadId[] = [];
    const coalescer = makeToolUpdateCoalescer<string>({
      windowMs: 50,
      onWindowClosed: (threadId) => closed.push(threadId),
    });
    coalescer.offer(threadA, "a", "a1");
    coalescer.take(threadA);
    coalescer.offer(threadB, "a", "b1");
    coalescer.discard(threadB, "a");
    vi.advanceTimersByTime(100);

    expect(closed).toEqual([]);
    expect(coalescer.threadIds()).toEqual([]);
  });

  it("reports a full thread so the caller flushes at once", () => {
    const coalescer = makeToolUpdateCoalescer<string>({
      maxPendingPerThread: 2,
      onWindowClosed: () => {},
    });

    expect(coalescer.offer(threadA, "a", "a1")).toBe(false);
    expect(coalescer.offer(threadA, "a", "a2")).toBe(false);
    expect(coalescer.offer(threadA, "b", "b1")).toBe(true);
  });
});

describe("isSupersedableToolUpdate", () => {
  it("supersedes ordinary tool updates", () => {
    expect(isSupersedableToolUpdate({ itemType: "command_execution", title: "Run" })).toBe(true);
    expect(
      isSupersedableToolUpdate({
        itemType: "mcp_tool_call",
        mcpServerName: "github",
        mcpToolName: "list_issues",
      }),
    ).toBe(true);
  });

  it("keeps every snapshot of calls that clients fold field by field", () => {
    expect(
      isSupersedableToolUpdate({
        itemType: "collab_agent_tool_call",
        codexCollaborationTool: "spawnAgent",
      }),
    ).toBe(false);
    expect(
      isSupersedableToolUpdate({
        itemType: "mcp_tool_call",
        computerTool: true,
        mcpToolName: "computer_click",
      }),
    ).toBe(false);
    expect(
      isSupersedableToolUpdate({
        itemType: "mcp_tool_call",
        mcpServerName: "f5_preview",
        mcpToolName: "preview_navigate",
      }),
    ).toBe(false);
  });
});
