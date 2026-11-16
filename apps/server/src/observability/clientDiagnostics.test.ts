import { describe, expect, it } from "vitest";
import type { ReportClientDiagnosticsInput } from "@t3tools/contracts";
import { makeClientDiagnosticsReporter } from "./clientDiagnostics.ts";
const report = (
  reportSeq: number,
  snapshotSyncs = reportSeq,
  sessionId = "page",
): ReportClientDiagnosticsInput => ({
  sessionId,
  reportSeq,
  clientKind: "web",
  counters: {
    snapshotSyncs,
    gapRecoveries: 0,
    bufferOverflows: 0,
    poisonBatches: 0,
    connectedMs: 100 * reportSeq,
  },
  applyBatchBuckets: [reportSeq, 0, 0, 0, 0, 0, 0, 0, 0],
});
describe("client diagnostics aggregation", () => {
  it("adds deltas, ignores duplicate/stale report sequences and treats counter decreases as resets", () => {
    const reporter = makeClientDiagnosticsReporter();
    expect(reporter.accept(report(1))?.counters.snapshotSyncs).toBe(1);
    expect(reporter.accept(report(1))).toBeNull();
    expect(reporter.accept(report(0))).toBeNull();
    expect(reporter.accept(report(3))?.counters.snapshotSyncs).toBe(2);
    expect(reporter.accept(report(4, 1))?.counters.snapshotSyncs).toBe(1);
  });
  it("bounds sessions to an LRU of 256 while retaining recently reported pages", () => {
    const reporter = makeClientDiagnosticsReporter();
    for (let index = 0; index < 256; index++) reporter.accept(report(1, 1, `page-${index}`));
    reporter.accept(report(2, 2, "page-0"));
    reporter.accept(report(1, 1, "page-256"));
    expect(reporter.size).toBe(256);
    expect(reporter.accept(report(2, 2, "page-0"))).toBeNull();
    expect(reporter.accept(report(1, 1, "page-1"))?.counters.snapshotSyncs).toBe(1);
    expect(reporter.size).toBe(256);
  });
});
