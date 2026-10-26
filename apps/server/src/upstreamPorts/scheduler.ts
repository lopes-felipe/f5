/**
 * Schedule math and occurrence transitions (plan §4.8). Pure; the service
 * ticks every 10 minutes and at startup.
 *
 * @module upstreamPorts/scheduler
 */
import type { UpstreamRunStatus, UpstreamSchedule } from "@t3tools/contracts";

import type { OccurrenceRecord } from "./store.ts";

export const SCHEDULER_TICK_MS = 10 * 60_000;
export const CONTINUATION_DELAY_MS = 5 * 60_000;
export const MAX_CONTINUATIONS = 6;
export const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
export const MAX_ATTEMPTS = 4;

/** Local wall-clock instant; `new Date(y, m, d, h)` moves a skipped DST hour forward. */
const localInstant = (year: number, month: number, day: number, hour: number) =>
  new Date(year, month, day, hour, 0, 0, 0);

/** The latest scheduled local instant at or before `now`, or null when the mode is off. */
export function lastDueAt(schedule: UpstreamSchedule, now: Date): Date | null {
  if (schedule.mode === "off") return null;
  for (let back = 0; back <= 7; back += 1) {
    const candidate = localInstant(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - back,
      schedule.hour,
    );
    if (candidate.getTime() > now.getTime()) continue;
    if (schedule.mode === "weekly" && candidate.getDay() !== schedule.weekday) continue;
    return candidate;
  }
  return null;
}

/** The next scheduled local instant strictly after `now`. */
export function nextDueAt(schedule: UpstreamSchedule, now: Date): Date | null {
  if (schedule.mode === "off") return null;
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const candidate = localInstant(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + ahead,
      schedule.hour,
    );
    if (candidate.getTime() <= now.getTime()) continue;
    if (schedule.mode === "weekly" && candidate.getDay() !== schedule.weekday) continue;
    return candidate;
  }
  return null;
}

export const newOccurrence = (projectId: string, dueAt: string): OccurrenceRecord => ({
  projectId,
  dueAt,
  status: "pending",
  attempts: 0,
  continuations: 0,
  nextAttemptAt: dueAt,
  lastRunId: null,
  lastError: null,
});

/** Applies a finished scheduled run to its occurrence. */
export function applyRunResult(
  occurrence: OccurrenceRecord,
  run: {
    readonly runId: string;
    readonly status: UpstreamRunStatus;
    readonly errorMessage: string | null;
  },
  now: Date,
): OccurrenceRecord {
  const at = (delayMs: number) => new Date(now.getTime() + delayMs).toISOString();
  const base = { ...occurrence, lastRunId: run.runId };
  switch (run.status) {
    case "succeeded":
      return { ...base, status: "succeeded", nextAttemptAt: null, lastError: null };
    case "partial": {
      const continuations = occurrence.continuations + 1;
      return continuations > MAX_CONTINUATIONS
        ? { ...base, status: "succeeded", continuations: MAX_CONTINUATIONS, nextAttemptAt: null }
        : { ...base, status: "pending", continuations, nextAttemptAt: at(CONTINUATION_DELAY_MS) };
    }
    case "failed": {
      const attempts = occurrence.attempts + 1;
      return attempts >= MAX_ATTEMPTS
        ? { ...base, status: "failed", attempts, nextAttemptAt: null, lastError: run.errorMessage }
        : {
            ...base,
            status: "pending",
            attempts,
            nextAttemptAt: at(FAILURE_BACKOFF_MS[attempts - 1]!),
            lastError: run.errorMessage,
          };
    }
    case "interrupted":
      return { ...base, status: "pending", nextAttemptAt: now.toISOString() };
    case "running":
      return { ...base, status: "running" };
  }
}

/** Whether a tick should start a scheduled run for this occurrence. */
export function occurrenceIsDue(occurrence: OccurrenceRecord, now: Date): boolean {
  return (
    occurrence.status === "pending" &&
    (occurrence.nextAttemptAt === null ||
      new Date(occurrence.nextAttemptAt).getTime() <= now.getTime())
  );
}
