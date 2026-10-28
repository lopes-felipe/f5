import { expect, it } from "vitest";
import { outcomeCheckPending, type OutcomeCheck } from "./queueStore.ts";

it("caps same-turn outcome retries, honors backoff and resets the budget for a new turn", () => {
  const check: OutcomeCheck = {
    projectId: "p",
    threadId: "t",
    turnId: "turn",
    result: "failed",
    detail: "busy",
    checkedAt: "2026-10-22T12:00:00.000Z",
    attempts: 4,
    retryAt: "2026-10-22T12:01:00.000Z",
  };
  expect(outcomeCheckPending(check, "turn", Date.parse(check.checkedAt))).toBe(false);
  expect(outcomeCheckPending(check, "turn", Date.parse(check.retryAt!))).toBe(true);
  expect(outcomeCheckPending({ ...check, attempts: 5 }, "turn", Date.parse(check.retryAt!))).toBe(
    false,
  );
  expect(
    outcomeCheckPending({ ...check, attempts: 5 }, "new-turn", Date.parse(check.checkedAt)),
  ).toBe(true);
  expect(
    outcomeCheckPending({ ...check, result: "recorded" }, "turn", Date.parse(check.retryAt!)),
  ).toBe(false);
  expect(
    outcomeCheckPending(
      { ...check, result: "preexisting" },
      "new-turn",
      Date.parse(check.retryAt!),
    ),
  ).toBe(false);
});
