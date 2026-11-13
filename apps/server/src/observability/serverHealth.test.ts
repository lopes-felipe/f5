import { ServerHealth } from "@t3tools/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
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
    // Whitespace does not make two statements, and long statements are cut.
    expect(health.slowStatements[0]).toMatchObject({
      name: "SELECT * FROM projection_threads WHERE thread_id = ?",
      count: 2,
      totalMs: 400,
      maxMs: 250,
    });
    expect(health.slowStatements[1]?.name).toHaveLength(240);
    expect(health.slowRouteThresholdMs).toBe(1_000);
    expect(health.slowStatementThresholdMs).toBe(100);
    expect(Date.parse(health.startedAt)).toBe(
      Date.parse("2026-01-02T00:00:00.000Z") - health.uptimeMs,
    );
  });

  it("reports event loop delay only while it is sampled", async () => {
    expect(readServerHealth().eventLoopDelay).toBeNull();
    const stop = startEventLoopDelayMonitor();
    try {
      // Starting twice keeps the one histogram.
      startEventLoopDelayMonitor()();
      const blockedUntil = Date.now() + 120;
      await new Promise((resolve) => setTimeout(resolve, 30));
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
