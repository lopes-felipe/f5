import { expect, it } from "vitest";
import { PiPromptQueue } from "./PiPromptQueue.ts";

it("retries raced prompts ahead of held steers, exactly once and in order", () => {
  const queue = new PiPromptQueue();
  const first = { type: "prompt", id: "first", message: "Start" };
  const steer = { type: "prompt", id: "steer", message: "Steer" };
  expect(queue.submit(first)).toEqual([first]);
  queue.observe({ type: "compaction_start" });
  expect(queue.submit(steer)).toEqual([]);
  expect(
    queue.observe({
      type: "response",
      command: "prompt",
      id: "first",
      success: false,
      error: "Cannot submit a prompt while compaction is in progress.",
    }).consumed,
  ).toBe(true);
  expect(queue.observe({ type: "compaction_end", aborted: true }).send).toEqual([first, steer]);
  expect(queue.observe({ type: "compaction_end" }).send).toEqual([]);
});

it("does not swallow unrelated failures or deliver held prompts after cancellation", () => {
  const queue = new PiPromptQueue();
  queue.submit({ type: "prompt", id: "first" });
  queue.observe({ type: "compaction_start" });
  expect(
    queue.observe({
      type: "response",
      command: "prompt",
      id: "first",
      success: false,
      error: "Model unavailable",
    }).consumed,
  ).toBe(false);
  queue.submit({ type: "prompt", id: "held" });
  queue.clear();
  expect(queue.observe({ type: "compaction_end" }).send).toEqual([]);
});
