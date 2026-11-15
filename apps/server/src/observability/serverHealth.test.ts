import { ServerHealth } from "@t3tools/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  eventLoopBaselineMs,
  readServerHealth,
  recordSlowRpcRoute,
  recordSlowSqlStatement,
  resetServerHealthForTest,
  SlowOperationRecorder,
  startEventLoopDelayMonitor,
} from "./serverHealth.ts";

afterEach(resetServerHealthForTest);

describe("SlowOperationRecorder", () => {
  it("totals each operation and lists the costliest first", () => {
    const recorder = new SlowOperationRecorder();
    recorder.record("git.status", 1_200, Date.parse("2026-01-01T00:00:00.000Z"));
    recorder.record("git.status", 2_500.4, Date.parse("2026-01-01T00:01:00.000Z"));
    recorder.record("orchestration.getStartupSnapshot", 9_000, Date.parse("2026-01-01T00:00:30Z"));

    expect(recorder.top()).toEqual([
      {
        name: "orchestration.getStartupSnapshot",
        count: 1,
        totalMs: 9_000,
        maxMs: 9_000,
        lastAt: "2026-01-01T00:00:30.000Z",
      },
      {
        name: "git.status",
        count: 2,
        totalMs: 3_700,
        maxMs: 2_500,
        lastAt: "2026-01-01T00:01:00.000Z",
      },
    ]);
    expect(recorder.top(1)).toHaveLength(1);
  });

  it("stays bounded: a new operation replaces the cheapest one", () => {
    const recorder = new SlowOperationRecorder();
    for (let index = 0; index < 200; index += 1) recorder.record(`route-${index}`, 1_000 + index);
    recorder.record("newcomer", 5_000);

    const names = recorder.top(500).map((operation) => operation.name);
    expect(names).toHaveLength(200);
    expect(names[0]).toBe("newcomer");
    expect(names).not.toContain("route-0");
    expect(names).toContain("route-1");
  });
});

describe("readServerHealth", () => {
  it("reports recorded routes and statements in the contract's shape", () => {
    recordSlowRpcRoute("git.status", 1_500);
    recordSlowSqlStatement("SELECT *\n        FROM projection_threads\n  WHERE thread_id = ?", 250);
    recordSlowSqlStatement("SELECT * FROM projection_threads WHERE thread_id = ?", 150);
    recordSlowSqlStatement(`SELECT ${"x, ".repeat(200)} 1`, 120);

    const health = readServerHealth(Date.parse("2026-01-02T00:00:00.000Z"));
    expect(Schema.decodeUnknownSync(ServerHealth)(health)).toEqual(health);
    expect(health.slowRoutes.map((route) => [route.name, route.count])).toEqual([
      ["git.status", 1],
    ]);
    // Whitespace does not make two statements, and long statements are shown cut.
    expect(health.slowStatements[0]).toMatchObject({
      name: "SELECT * FROM projection_threads WHERE thread_id = ?",
      count: 2,
      totalMs: 400,
      maxMs: 250,
    });
    expect(health.slowStatements[1]?.name).toHaveLength(240);
    expect(health.slowStatements[1]?.name.endsWith("…")).toBe(true);
    // Vitest runs under Node, whose SQLite driver times statements.
    expect(health.slowStatementsCollected).toBe(true);
    expect(health.slowRouteThresholdMs).toBe(1_000);
    expect(health.slowStatementThresholdMs).toBe(100);
    expect(Date.parse(health.startedAt)).toBe(
      Date.parse("2026-01-02T00:00:00.000Z") - health.uptimeMs,
    );
  });

  it("leaves requests that are long by design out of the ranking", () => {
    recordSlowRpcRoute("mcp.startOAuthLogin", 120_000, "long");
    recordSlowRpcRoute("git.status", 1_200, "ordinary");
    recordSlowRpcRoute("git.status", 1_300);
    expect(readServerHealth().slowRoutes.map((route) => [route.name, route.count])).toEqual([
      ["git.status", 2],
    ]);
  });

  it("tells statements apart by their whole text, not by the part that is shown", () => {
    const columns = "column_name, ".repeat(30);
    recordSlowSqlStatement(`SELECT ${columns}1 FROM projection_threads WHERE thread_id = ?`, 300);
    recordSlowSqlStatement(`SELECT ${columns}1 FROM projection_turns WHERE turn_id = ?`, 200);

    const statements = readServerHealth().slowStatements;
    expect(statements.map((statement) => [statement.count, statement.totalMs])).toEqual([
      [1, 300],
      [1, 200],
    ]);
    // Both are cut before the part that differs, so they read the same.
    expect(statements[0]?.name).toBe(statements[1]?.name);
  });

  it("counts a query once however many values its list holds", () => {
    recordSlowSqlStatement("SELECT 1 FROM events WHERE sequence IN (?,?)", 150);
    recordSlowSqlStatement("SELECT 1 FROM events WHERE sequence IN (?, ?, ?, ?)", 150);
    recordSlowSqlStatement("INSERT INTO t (a, b) VALUES (?,?),(?,?),(?,?)", 200);
    recordSlowSqlStatement("INSERT INTO t (a, b) VALUES (?,?),(?,?)", 200);
    // One value is not a list.
    recordSlowSqlStatement("SELECT 1 FROM events WHERE sequence = (?)", 120);

    expect(
      readServerHealth().slowStatements.map((statement) => [statement.name, statement.count]),
    ).toEqual([
      ["INSERT INTO t (a, b) VALUES (?, …), …", 2],
      ["SELECT 1 FROM events WHERE sequence IN (?, …)", 2],
      ["SELECT 1 FROM events WHERE sequence = (?)", 1],
    ]);
  });

  it("subtracts the timer interval from event loop delay on Node only", () => {
    // Idle, Node's histogram reads about its 20ms interval and Bun's about zero.
    expect(eventLoopBaselineMs(false)).toBe(20);
    expect(eventLoopBaselineMs(true)).toBe(0);
    expect(eventLoopBaselineMs()).toBe(20);
  });

  it("reports event loop delay only while it is sampled", async () => {
    expect(readServerHealth().eventLoopDelay).toBeNull();
    const stop = startEventLoopDelayMonitor();
    try {
      // Starting twice keeps the one histogram.
      startEventLoopDelayMonitor()();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const blockedUntil = Date.now() + 120;
      while (Date.now() < blockedUntil) {
        // Hold the event loop so the next sample is late.
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      const delay = readServerHealth().eventLoopDelay;
      expect(delay).not.toBeNull();
      expect(delay!.maxMs).toBeGreaterThanOrEqual(40);
      expect(delay!.maxMs).toBeGreaterThanOrEqual(delay!.p50Ms);
    } finally {
      stop();
    }
    expect(readServerHealth().eventLoopDelay).toBeNull();
  });
});
