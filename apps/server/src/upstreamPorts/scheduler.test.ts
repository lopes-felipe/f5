import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyRunResult,
  lastDueAt,
  newOccurrence,
  nextDueAt,
  occurrenceIsDue,
} from "./scheduler.ts";

const previousTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const daily = { mode: "daily", hour: 7, weekday: 1 } as const;
const weekly = { mode: "weekly", hour: 7, weekday: 1 } as const;

describe("due times", () => {
  it("never runs when off", () => {
    expect(lastDueAt({ ...daily, mode: "off" }, new Date())).toBeNull();
    expect(nextDueAt({ ...daily, mode: "off" }, new Date())).toBeNull();
  });

  it("uses local wall-clock hours across both DST changes", () => {
    // 2026-03-08 is the spring-forward day in New York; 07:00 local is 11:00Z.
    expect(lastDueAt(daily, new Date("2026-03-08T12:00:00Z"))?.toISOString()).toBe(
      "2026-03-08T11:00:00.000Z",
    );
    expect(lastDueAt(daily, new Date("2026-03-07T13:00:00Z"))?.toISOString()).toBe(
      "2026-03-07T12:00:00.000Z",
    );
    // 2026-11-01 falls back; 07:00 local is 12:00Z again.
    expect(lastDueAt(daily, new Date("2026-11-01T13:00:00Z"))?.toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    // Before today's hour, the due time is yesterday's.
    expect(lastDueAt(daily, new Date("2026-11-01T10:00:00Z"))?.toISOString()).toBe(
      "2026-10-31T11:00:00.000Z",
    );
  });

  it("picks the configured weekday for weekly schedules", () => {
    // 2026-10-22 is a Thursday; the last Monday 07:00 is 2026-10-19.
    const due = lastDueAt(weekly, new Date("2026-10-22T15:00:00Z"))!;
    expect(due.getDay()).toBe(1);
    expect(due.toISOString()).toBe("2026-10-19T11:00:00.000Z");
    expect(nextDueAt(weekly, new Date("2026-10-22T15:00:00Z"))?.toISOString()).toBe(
      "2026-10-26T11:00:00.000Z",
    );
  });
});

describe("occurrence transitions", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const base = newOccurrence("p", "2026-10-22T11:00:00.000Z");
  const result = (status: "succeeded" | "partial" | "failed" | "interrupted") => ({
    runId: "r",
    status,
    errorMessage: status === "failed" ? "boom" : null,
  });

  it("backs off failed runs 10m, 30m, 2h, then fails after four attempts", () => {
    let occurrence = base;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      occurrence = applyRunResult(occurrence, result("failed"), now);
      expect(occurrence.status).toBe("pending");
      delays.push((new Date(occurrence.nextAttemptAt!).getTime() - now.getTime()) / 60_000);
    }
    expect(delays).toEqual([10, 30, 120]);
    occurrence = applyRunResult(occurrence, result("failed"), now);
    expect(occurrence).toMatchObject({ status: "failed", attempts: 4, lastError: "boom" });
  });

  it("continues partial runs every 5 minutes up to six times", () => {
    let occurrence = base;
    for (let index = 1; index <= 6; index += 1) {
      occurrence = applyRunResult(occurrence, result("partial"), now);
      expect(occurrence).toMatchObject({ status: "pending", continuations: index });
      expect(new Date(occurrence.nextAttemptAt!).getTime() - now.getTime()).toBe(5 * 60_000);
    }
    expect(applyRunResult(occurrence, result("partial"), now).status).toBe("succeeded");
  });

  it("retries an interrupted run immediately without counting an attempt", () => {
    const occurrence = applyRunResult(
      { ...base, attempts: 2, status: "running" },
      result("interrupted"),
      now,
    );
    expect(occurrence).toMatchObject({ status: "pending", attempts: 2 });
    expect(occurrenceIsDue(occurrence, now)).toBe(true);
  });

  it("is due only when pending and past its next attempt", () => {
    expect(occurrenceIsDue(base, now)).toBe(true);
    expect(occurrenceIsDue({ ...base, nextAttemptAt: "2026-10-22T13:00:00.000Z" }, now)).toBe(
      false,
    );
    expect(occurrenceIsDue({ ...base, status: "succeeded" }, now)).toBe(false);
  });
});
