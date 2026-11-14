import { expect, it } from "vitest";
import { PromptInactivityDeadline } from "./PromptInactivityDeadline";
import { AntigravityTasks } from "./AntigravityTasks";

it("grants a full deadline when a pause ends near the previous deadline", () => {
  const timer = new PromptInactivityDeadline(900_000, 0);
  expect(timer.remaining(0, 0, true, null)).toBe(900_000);
  expect(timer.remaining(840_000, 0, false, null)).toBe(900_000);
  expect(timer.remaining(900_000, 0, false, null)).toBe(840_000);
  expect(timer.remaining(1_740_000, 0, false, null)).toBe(0);
});

it("eventually times out a silent parent after a successful unobservable batch", () => {
  const tasks = new AntigravityTasks();
  tasks.update(
    {
      toolCallId: "batch",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: {},
    },
    {},
  );
  const timer = new PromptInactivityDeadline(100, 0);
  expect(timer.remaining(0, 0, false, tasks.inactivityPauseGeneration)).toBe(100);
  expect(timer.remaining(100, 0, false, tasks.inactivityPauseGeneration)).toBe(100);
  expect(timer.remaining(200, 0, false, tasks.inactivityPauseGeneration)).toBe(0);
});

it("ends the batch grace period when the parent resumes", () => {
  const tasks = new AntigravityTasks();
  tasks.update(
    {
      toolCallId: "batch",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: {},
    },
    {},
  );
  const timer = new PromptInactivityDeadline(100, 0);
  timer.remaining(0, 0, false, tasks.inactivityPauseGeneration);
  tasks.noteParentProgress();
  expect(timer.remaining(10, 10, false, tasks.inactivityPauseGeneration)).toBe(100);
  expect(timer.remaining(110, 10, false, tasks.inactivityPauseGeneration)).toBe(0);
});
