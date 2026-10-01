import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { createClaudeTurnLifecycle, reduceClaudeTurnLifecycle } from "./claudeTurnLifecycle.ts";

function result(uuid: string): SDKResultMessage {
  return { type: "result", subtype: "success", uuid } as SDKResultMessage;
}

describe("Claude logical turn lifecycle", () => {
  it("waits through several result segments and task completion until parent synthesis", () => {
    const state = createClaudeTurnLifecycle();
    const reduce = (event: Parameters<typeof reduceClaudeTurnLifecycle>[1]) =>
      reduceClaudeTurnLifecycle(state, event);
    reduce({ type: "background", tasks: ["a", "b", "c"].map((task_id) => ({ task_id })) });
    expect(reduce({ type: "result", result: result("waiting") })).toBeUndefined();
    reduce({ type: "parent-activity" });
    expect(reduce({ type: "result", result: result("still-waiting") })).toBeUndefined();
    // Edge notifications cannot override the authoritative activity snapshot.
    for (const taskId of ["a", "b", "c"]) reduce({ type: "task-completed", taskId });
    expect(reduce({ type: "result", result: result("third-segment") })).toBeUndefined();
    expect(reduce({ type: "background", tasks: [] })).toBeUndefined();
    reduce({ type: "parent-activity" });
    const final = result("synthesis");
    expect(reduce({ type: "result", result: final })).toBe(final);
    expect(reduce({ type: "result", result: final })).toBeUndefined();
  });

  it("waits for authoritative idle after the last result when session signals are available", () => {
    const state = createClaudeTurnLifecycle();
    reduceClaudeTurnLifecycle(state, { type: "session", state: "running" });
    const final = result("final");
    expect(reduceClaudeTurnLifecycle(state, { type: "result", result: final })).toBeUndefined();
    expect(
      reduceClaudeTurnLifecycle(state, { type: "session", state: "requires_action" }),
    ).toBeUndefined();
    expect(reduceClaudeTurnLifecycle(state, { type: "session", state: "idle" })).toBe(final);
    expect(reduceClaudeTurnLifecycle(state, { type: "session", state: "idle" })).toBeUndefined();
  });

  it("does not reuse a waiting result after the parent resumes or a turn is replaced", () => {
    for (const type of ["parent-activity", "turn-boundary"] as const) {
      const state = createClaudeTurnLifecycle();
      reduceClaudeTurnLifecycle(state, { type: "session", state: "running" });
      reduceClaudeTurnLifecycle(state, { type: "result", result: result("waiting") });
      reduceClaudeTurnLifecycle(state, { type });
      expect(reduceClaudeTurnLifecycle(state, { type: "session", state: "idle" })).toBeUndefined();
    }
  });

  it("uses bookends only before the first snapshot and ignores duplicate late starts", () => {
    const state = createClaudeTurnLifecycle();
    reduceClaudeTurnLifecycle(state, { type: "task-started", taskId: "a" });
    expect(
      reduceClaudeTurnLifecycle(state, { type: "result", result: result("waiting") }),
    ).toBeUndefined();
    reduceClaudeTurnLifecycle(state, { type: "task-completed", taskId: "a" });
    reduceClaudeTurnLifecycle(state, { type: "task-started", taskId: "a" });
    expect(state.backgroundTasks.size).toBe(0);
    reduceClaudeTurnLifecycle(state, { type: "background", tasks: [] });
    reduceClaudeTurnLifecycle(state, { type: "task-started", taskId: "b" });
    const final = result("final");
    expect(reduceClaudeTurnLifecycle(state, { type: "result", result: final })).toBe(final);
  });

  it("excludes ambient watchers and resets activity on process replacement", () => {
    const state = createClaudeTurnLifecycle();
    reduceClaudeTurnLifecycle(state, {
      type: "background",
      tasks: [{ task_id: "watcher", ambient: true }],
    });
    const final = result("final");
    expect(reduceClaudeTurnLifecycle(state, { type: "result", result: final })).toBe(final);
    reduceClaudeTurnLifecycle(state, { type: "background", tasks: [{ task_id: "agent" }] });
    const restarted = createClaudeTurnLifecycle();
    expect(reduceClaudeTurnLifecycle(restarted, { type: "result", result: final })).toBe(final);
  });
});
