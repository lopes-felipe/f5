import { expect, it } from "vitest";
import { latestJobExecutions } from "./ci-job-attempts.ts";

const job = {
  name: "server-unit (1)",
  run_attempt: 1,
  started_at: "2026-10-28T16:00:00Z",
  completed_at: "2026-10-28T16:05:00Z",
  conclusion: "success",
};

it("finds the original execution behind jobs cloned into partial reruns", () => {
  const clone = { ...job, run_attempt: 2 };
  expect(latestJobExecutions([clone, job])).toEqual([job]);
  expect(latestJobExecutions([job, clone, { ...clone, run_attempt: 3 }])).toEqual([job]);
});

it("never borrows an earlier success when the latest execution failed", () => {
  const failed = {
    ...job,
    run_attempt: 2,
    started_at: "2026-10-28T17:00:00Z",
    completed_at: "2026-10-28T17:05:00Z",
    conclusion: "failure",
  };
  expect(latestJobExecutions([job, failed, { ...failed, run_attempt: 3 }])).toEqual([failed]);
});

it("retains independent matrix jobs and actually rerun successful executions", () => {
  const rerun = {
    ...job,
    run_attempt: 2,
    started_at: "2026-10-28T17:00:00Z",
    completed_at: "2026-10-28T17:05:00Z",
  };
  const other = { ...job, name: "server-unit (2)" };
  expect(latestJobExecutions([job, other, rerun, { ...other, run_attempt: 2 }])).toEqual([
    rerun,
    other,
  ]);
});
