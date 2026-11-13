import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { ServerHealth, ServerHealthSlowOperation } from "@t3tools/contracts";

/**
 * In-memory record of what was slow since this server process started: RPC
 * routes, SQL statements and event-loop delay. The same events go to the
 * server log; this keeps the totals so Settings can show them without anyone
 * aggregating a log file. Nothing here is persisted.
 */

/** Routes at least this slow are logged and recorded. */
export const SLOW_RPC_ROUTE_MS = 1_000;
/** Statements slower than this are logged and recorded. */
export const SLOW_SQL_STATEMENT_MS = 100;

/** Distinct routes or statement shapes kept per kind. A new one replaces the cheapest when full. */
const MAX_OPERATIONS = 200;
const REPORTED_OPERATIONS = 20;
const MAX_STATEMENT_LENGTH = 240;
const EVENT_LOOP_RESOLUTION_MS = 20;

interface Totals {
  count: number;
  totalMs: number;
  maxMs: number;
  lastAtMs: number;
}

export class SlowOperationRecorder {
  private readonly totals = new Map<string, Totals>();

  record(name: string, durationMs: number, atMs = Date.now()): void {
    const existing = this.totals.get(name);
    if (existing) {
      existing.count += 1;
      existing.totalMs += durationMs;
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.lastAtMs = atMs;
      return;
    }
    if (this.totals.size >= MAX_OPERATIONS) this.evictSmallest();
    this.totals.set(name, { count: 1, totalMs: durationMs, maxMs: durationMs, lastAtMs: atMs });
  }

  /** The operations that cost the most time in total, largest first. */
  top(limit = REPORTED_OPERATIONS): ReadonlyArray<ServerHealthSlowOperation> {
    return [...this.totals.entries()]
      .toSorted(([, left], [, right]) => right.totalMs - left.totalMs)
      .slice(0, limit)
      .map(([name, entry]) => ({
        name,
        count: entry.count,
        totalMs: Math.round(entry.totalMs),
        maxMs: Math.round(entry.maxMs),
        lastAt: new Date(entry.lastAtMs).toISOString(),
      }));
  }

  clear(): void {
    this.totals.clear();
  }

  private evictSmallest(): void {
    let smallest: string | undefined;
    let smallestMs = Infinity;
    for (const [name, entry] of this.totals)
      if (entry.totalMs < smallestMs) {
        smallest = name;
        smallestMs = entry.totalMs;
      }
    if (smallest !== undefined) this.totals.delete(smallest);
  }
}

const slowRoutes = new SlowOperationRecorder();
const slowStatements = new SlowOperationRecorder();
let eventLoopDelay: IntervalHistogram | undefined;

export const recordSlowRpcRoute = (method: string, durationMs: number) =>
  slowRoutes.record(method, durationMs);

/**
 * `sourceSql` is the statement text with placeholders, never the expanded
 * statement: bound values can hold private content.
 */
export const recordSlowSqlStatement = (sourceSql: string, durationMs: number) =>
  slowStatements.record(
    sourceSql.replace(/\s+/g, " ").trim().slice(0, MAX_STATEMENT_LENGTH),
    durationMs,
  );

/** Starts sampling event-loop delay; the returned function stops it. */
export function startEventLoopDelayMonitor(): () => void {
  if (eventLoopDelay) return () => undefined;
  const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  histogram.enable();
  eventLoopDelay = histogram;
  return () => {
    histogram.disable();
    if (eventLoopDelay === histogram) eventLoopDelay = undefined;
  };
}

const nanosToMs = (nanos: number) => (Number.isFinite(nanos) ? Math.round(nanos / 1e6) : 0);

export function readServerHealth(nowMs = Date.now()): ServerHealth {
  const memory = process.memoryUsage();
  const uptimeMs = Math.round(process.uptime() * 1_000);
  return {
    startedAt: new Date(nowMs - uptimeMs).toISOString(),
    uptimeMs,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    // The histogram reports the timer's own interval when nothing blocks, so the
    // resolution is subtracted: what is left is how late the loop ran.
    eventLoopDelay: eventLoopDelay
      ? {
          p50Ms: Math.max(0, nanosToMs(eventLoopDelay.percentile(50)) - EVENT_LOOP_RESOLUTION_MS),
          p99Ms: Math.max(0, nanosToMs(eventLoopDelay.percentile(99)) - EVENT_LOOP_RESOLUTION_MS),
          maxMs: Math.max(0, nanosToMs(eventLoopDelay.max) - EVENT_LOOP_RESOLUTION_MS),
        }
      : null,
    slowRouteThresholdMs: SLOW_RPC_ROUTE_MS,
    slowStatementThresholdMs: SLOW_SQL_STATEMENT_MS,
    slowRoutes: slowRoutes.top(),
    slowStatements: slowStatements.top(),
  };
}

/** Tests only: the recorders are process-wide. */
export function resetServerHealthForTest(): void {
  slowRoutes.clear();
  slowStatements.clear();
}
