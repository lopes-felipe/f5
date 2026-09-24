import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, messageFixture, repositoryFile, terminalChunks } from "./fixtures.ts";
import {
  comparisonGate,
  compareReports,
  maximumObservation,
  measure,
  percentile95,
  retainedMemoryObservations,
  type PerformanceReport,
} from "./report.ts";

describe("performance fixtures", () => {
  it("stops the separate SQLite writer when its owner disconnects", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "f5-perf-writer-test-"));
    const child = fork(
      fileURLToPath(
        new URL("../../../apps/server/scripts/performance/sqlite-writer.mjs", import.meta.url),
      ),
      [path.join(directory, "writer.sqlite")],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exit = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    try {
      await once(child, "message", { signal: AbortSignal.timeout(5000) });
      child.disconnect();
      expect((await exit)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exit;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("materializes exact sizes and stable content for the planned fixtures", () => {
    expect(fixture.chat.messages).toBe(10_000);
    expect(fixture.streaming).toEqual({ threads: 10, updatesPerSecondPerThread: 20 });
    const messages = Array.from({ length: fixture.chat.messages }, (_, i) => messageFixture(i));
    expect(messages.filter((m) => m.attachment)).toHaveLength(50);
    expect(messages.filter((m) => m.toolOutput)).toHaveLength(10);
    expect(Buffer.byteLength(messages[0]!.toolOutput!)).toBe(1024 * 1024);
    expect(messageFixture(42)).toEqual(messages[42]);
    expect(terminalChunks()).toHaveLength(40);
    expect(terminalChunks().every((chunk) => Buffer.byteLength(chunk) === 4096)).toBe(true);
    expect(repositoryFile(9999).path).toBe("src/group-99/file-9999.ts");
    const digest = createHash("sha256")
      .update(JSON.stringify({ messages, chunks: terminalChunks(), file: repositoryFile(9999) }))
      .digest("hex");
    expect(digest).toBe("8bd66e03d98d9dfe315cc6740c01f0473bd43114c40580e01ff7d56545ced54e");
  });
});

describe("performance gates", () => {
  it("uses the nearest-rank p95 without mutating samples", () => {
    const samples = Array.from({ length: 30 }, (_, i) => 30 - i);
    expect(percentile95(samples)).toBe(29);
    expect(samples[0]).toBe(30);
    expect(() => percentile95([])).toThrow();
    expect(() => percentile95([NaN])).toThrow();
  });
  it("excludes five warmups and keeps all thirty wall/CPU samples", async () => {
    let calls = 0;
    const result = await measure(async () => {
      calls++;
    });
    expect(calls).toBe(35);
    expect(result.wallMs).toHaveLength(30);
    expect(result.cpuMs).toHaveLength(30);
  });
  it("requires both regression thresholds and the full targeted improvement", () => {
    expect(comparisonGate(100, 120)).toBe(true);
    expect(comparisonGate(100, 121)).toBe(false);
    expect(comparisonGate(1000, 1099)).toBe(true);
    expect(comparisonGate(100, 80, true)).toBe(true);
    expect(comparisonGate(100, 81, true)).toBe(false);
    expect(maximumObservation("buffer", 4097, 4096).passed).toBe(false);
  });
  function report(): PerformanceReport {
    return {
      schemaVersion: 1,
      scope: "server-component",
      mode: "measurement",
      metadata: {
        fixtureDigest: "fixture",
        hardware: {},
        os: {},
        runtime: { versions: { node: "24.13.1" } },
      } as PerformanceReport["metadata"],
      method: { warmups: 5, repetitions: 30 },
      measurements: { replay: { wallMs: Array(30).fill(100), cpuMs: Array(30).fill(50) } },
      observations: [maximumObservation("buffer", 4000, 4096)],
      notMeasured: ["browser"],
    };
  }
  it("rejects smoke, incompatible environments, missing samples and unknown target names", () => {
    const base = report();
    expect(compareReports(base, report())).toEqual([]);
    expect(compareReports(base, { ...report(), mode: "smoke" })).not.toEqual([]);
    expect(compareReports(base, { ...report(), measurements: {} })).not.toEqual([]);
    const changed = report();
    changed.metadata.fixtureDigest = "changed";
    expect(compareReports(base, changed)).toContain("Incompatible fixtureDigest");
    const short = report();
    short.measurements.replay!.wallMs.pop();
    expect(compareReports(base, short)).toContain("Incomplete samples: replay");
    const invalidCpu = report();
    invalidCpu.measurements.replay!.cpuMs[0] = NaN;
    expect(compareReports(base, invalidCpu)).toContain("Incomplete samples: replay");
    expect(compareReports(base, report(), ["typo"])).toContain("Unknown CPU target: typo");
  });
  it("rejects resource-bound failures even when timings improved", () => {
    const next = report();
    next.observations = [maximumObservation("buffer", 4097, 4096)];
    expect(compareReports(report(), next)).toContain("Exceeded bound: buffer");
    expect(compareReports(report(), { ...report(), observations: [] })).toContain(
      "Resource bounds changed or disappeared",
    );
  });
});

describe("retained memory gates", () => {
  const samples = () =>
    Array.from({ length: 11 }, (_, i) => ({
      elapsedMs: i * 60000,
      heapBytes: 100 * 1024 * 1024,
      server: { heapBytes: 100 * 1024 * 1024 },
    }));
  it("requires the complete 10-minute run", () => {
    expect(() => retainedMemoryObservations(samples().slice(0, 10))).toThrow();
    const short = samples();
    short[10]!.elapsedMs = 599999;
    expect(() => retainedMemoryObservations(short)).toThrow();
    expect(retainedMemoryObservations(samples()).every((x) => x.passed)).toBe(true);
  });
  it("checks both bounds and each process over the final five minutes", () => {
    const growing = samples();
    growing[10]!.heapBytes *= 1.06;
    const result = retainedMemoryObservations(growing);
    expect(result.find((x) => x.name === "memory.browser.growthBytes")!.passed).toBe(true);
    expect(result.find((x) => x.name === "memory.browser.growthRatio")!.passed).toBe(false);
    expect(result.find((x) => x.name === "memory.combined.growthRatio")!.passed).toBe(true);
  });
});
