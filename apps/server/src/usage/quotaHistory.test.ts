import { assert, describe, it } from "vitest";

import type { QuotaSampleRow } from "../persistence/Services/UsageAccountHistory.ts";
import { buildQuotaHistory, QUOTA_SERIES_MAX_POINTS } from "./quotaHistory.ts";

const now = new Date("2026-10-15T12:00:00.000Z");
const minutes = (value: number) => new Date(now.getTime() + value * 60_000).toISOString();

function sample(
  at: number,
  usedPercent: number,
  resetsAt: string | null = minutes(300),
  overrides: Partial<QuotaSampleRow> = {},
): QuotaSampleRow {
  return {
    accountKey: "codex:default",
    windowKey: "codex:primary",
    identity: "identity-a",
    sampledAt: minutes(at),
    usedPercent,
    resetsAt,
    ...overrides,
  };
}

describe("buildQuotaHistory", () => {
  it("keeps rolling reset drift within one series", () => {
    const history = buildQuotaHistory(
      [sample(-30, 10, minutes(295)), sample(-20, 12, minutes(300)), sample(-10, 14, minutes(304))],
      now,
    );
    assert.equal(history.series.length, 1);
    assert.deepStrictEqual(
      history.series[0]!.samples.map((entry) => entry.usedPercent),
      [10, 12, 14],
    );
    assert.equal(history.series[0]!.resetsAt, minutes(304));
  });

  it("splits on a reset jump over ten minutes and on usage drops", () => {
    const jump = buildQuotaHistory(
      [sample(-30, 10, minutes(100)), sample(-20, 12, minutes(300)), sample(-10, 14)],
      now,
    );
    assert.deepStrictEqual(
      jump.series[0]!.samples.map((entry) => entry.usedPercent),
      [12, 14],
    );
    const drop = buildQuotaHistory([sample(-30, 50), sample(-20, 3), sample(-10, 4)], now);
    assert.deepStrictEqual(
      drop.series[0]!.samples.map((entry) => entry.usedPercent),
      [3, 4],
    );
    // A drop of at most one point is jitter, not a reset.
    const jitter = buildQuotaHistory([sample(-20, 5), sample(-10, 4.2)], now);
    assert.equal(jitter.series[0]!.samples.length, 2);
  });

  it("cuts at a null reset and skips series with null or past resets", () => {
    const cut = buildQuotaHistory([sample(-20, 1, null), sample(-10, 2)], now);
    assert.equal(cut.series[0]!.samples.length, 1);
    assert.equal(buildQuotaHistory([sample(-10, 2, null)], now).series.length, 0);
    assert.equal(buildQuotaHistory([sample(-10, 2, minutes(-1))], now).series.length, 0);
  });

  it("uses only the latest identity", () => {
    const history = buildQuotaHistory(
      [sample(-30, 40, minutes(300), { identity: "old" }), sample(-20, 5), sample(-10, 6)],
      now,
    );
    assert.deepStrictEqual(
      history.series[0]!.samples.map((entry) => entry.usedPercent),
      [5, 6],
    );
  });

  it("downsamples long series and always keeps the last point", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      sample(-1_000 + index, index / 20, minutes(300)),
    );
    const samples = buildQuotaHistory(rows, now).series[0]!.samples;
    assert.isAtMost(samples.length, QUOTA_SERIES_MAX_POINTS);
    assert.equal(samples.at(-1)!.at, rows.at(-1)!.sampledAt);
    assert.equal(samples[0]!.at, rows[0]!.sampledAt);
  });
});
