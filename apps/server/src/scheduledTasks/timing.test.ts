import { expect, it } from "vitest";
import { detectScheduledClockJump, scheduledDeadlineDelay } from "./timing";
it("detects wake and both directions of wall-clock change against monotonic time", () => {
  const previous = { wall: 100000, monotonic: 50000 };
  expect(detectScheduledClockJump(previous, { wall: 160000, monotonic: 110000 })).toBe(false);
  expect(detectScheduledClockJump(previous, { wall: 3700000, monotonic: 110000 })).toBe(true);
  expect(detectScheduledClockJump(previous, { wall: 40000, monotonic: 110000 })).toBe(true);
});
it("clamps long sleeps and strictly positive deadlines", () => {
  expect(scheduledDeadlineDelay([], 0)).toBe(2147483647);
  expect(scheduledDeadlineDelay([9000000000], 0)).toBe(2147483647);
  expect(scheduledDeadlineDelay([1], 2)).toBe(1);
  expect(scheduledDeadlineDelay([500, 100], 0)).toBe(100);
});
