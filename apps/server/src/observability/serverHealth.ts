import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { ServerHealth, ServerHealthSlowOperation } from "@t3tools/contracts";
import type { RpcLane } from "@t3tools/shared/rpcScheduling";

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
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAtMs: number;
}

export class SlowOperationRecorder {
  private readonly totals = new Map<string, Totals>();

  /**
   * `key` decides which operations are the same one. `name` is what is shown
   * for it, for a key too long to show whole.
   */
  record(key: string, durationMs: number, atMs = Date.now(), name = key): void {
    const existing = this.totals.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalMs += durationMs;
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.lastAtMs = atMs;
      return;
    }
    if (this.totals.size >= MAX_OPERATIONS) this.evictSmallest();
    this.totals.set(key, {
      name,
      count: 1,
      totalMs: durationMs,
      maxMs: durationMs,
      lastAtMs: atMs,
    });
  }

  /** The operations that cost the most time in total, largest first. */
  top(limit = REPORTED_OPERATIONS): ReadonlyArray<ServerHealthSlowOperation> {
    return [...this.totals.values()]
      .toSorted((left, right) => right.totalMs - left.totalMs)
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
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

/**
 * Requests on the long lane are slow by design: they wait for a sign-in in the
 * browser, a provider update or a worktree. One of them left open for two
 * minutes would outrank hundreds of slow `git.status` calls, so they stay in
 * the log and out of this ranking.
 */
export const recordSlowRpcRoute = (method: string, durationMs: number, lane?: RpcLane) => {
  if (lane !== "long") slowRoutes.record(method, durationMs);
};

/**
 * One line of statement text. A placeholder list of any length reads `(?, …)`,
 * so the same query with a different number of values is the same statement.
 */
const statementShape = (sourceSql: string) =>
  sourceSql
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\((?: ?\? ?,)+ ?\? ?\)/g, "(?, …)")
    .replace(/(?:\(\?, …\) ?, ?)+\(\?, …\)/g, "(?, …), …");

/**
 * `sourceSql` is the statement text with placeholders, never the expanded
 * statement: bound values can hold private content.
 *
 * Statements are told apart by their whole text and only shown cut, so two
 * that share a long column list and differ in their `WHERE` are two rows.
 */
export const recordSlowSqlStatement = (sourceSql: string, durationMs: number) => {
  const shape = statementShape(sourceSql);
  slowStatements.record(
    shape,
    durationMs,
    Date.now(),
    shape.length > MAX_STATEMENT_LENGTH ? `${shape.slice(0, MAX_STATEMENT_LENGTH - 1)}…` : shape,
  );
};

/** Slow statements are timed by the Node SQLite driver. Under Bun nothing records them. */
const slowStatementsCollected = process.versions.bun === undefined;

/**
 * What the histogram reports when nothing blocks. Node reports the timer's own
 * interval, so that is subtracted and what is left is how late the loop ran.
 * Bun already reports only the lateness.
 */
export const eventLoopBaselineMs = (bun = process.versions.bun !== undefined) =>
  bun ? 0 : EVENT_LOOP_RESOLUTION_MS;

/**
 * Starts sampling event-loop delay; the returned function stops it. Sampling
 * starts when the server is created, so time blocked before that (opening the
 * database, migrations) is not in the numbers although uptime includes it.
 */
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
  const lateBy = (nanos: number) => Math.max(0, nanosToMs(nanos) - eventLoopBaselineMs());
  return {
    startedAt: new Date(nowMs - uptimeMs).toISOString(),
    uptimeMs,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopDelay: eventLoopDelay
      ? {
          p50Ms: lateBy(eventLoopDelay.percentile(50)),
          p99Ms: lateBy(eventLoopDelay.percentile(99)),
          maxMs: lateBy(eventLoopDelay.max),
        }
      : null,
    slowRouteThresholdMs: SLOW_RPC_ROUTE_MS,
    slowStatementThresholdMs: SLOW_SQL_STATEMENT_MS,
    slowRoutes: slowRoutes.top(),
    slowStatementsCollected,
    slowStatements: slowStatements.top(),
  };
}

/** Tests only: the recorders are process-wide. */
export function resetServerHealthForTest(): void {
  slowRoutes.clear();
  slowStatements.clear();
}
