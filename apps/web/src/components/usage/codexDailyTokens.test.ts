import { describe, expect, it } from "vitest";

import {
  codexAccountRangeTokens,
  codexDailyTokenSeries,
  codexTokensByDate,
} from "./codexDailyTokens";

const fetchedAt = "2026-08-15T12:00:00.000Z";
const buckets = [
  { startDate: "2026-08-15", tokens: "40000" },
  { startDate: "2026-08-14", tokens: "30000" },
  { startDate: "2026-08-10", tokens: "5000" },
  { startDate: "2026-07-01", tokens: "999" },
  { startDate: "2026-02-30", tokens: "1" },
  { startDate: "2026-8-12", tokens: "1" },
  { startDate: "2026-08-16", tokens: "7" },
];

describe("codexTokensByDate", () => {
  it("drops malformed and impossible dates", () => {
    const byDate = codexTokensByDate(buckets);
    expect(byDate.has("2026-02-30")).toBe(false);
    expect(byDate.has("2026-8-12")).toBe(false);
    expect(byDate.get("2026-08-15")).toBe(40_000n);
  });
});

describe("codexDailyTokenSeries", () => {
  it("shows at least 14 days, fills gaps with zero, and highlights the range", () => {
    const series = codexDailyTokenSeries({ fetchedAt, dailyUsageBuckets: buckets, range: "7d" })!;
    expect(series.days).toHaveLength(14);
    expect(series.days[0]!.date).toBe("2026-08-02");
    expect(series.days.at(-1)!.date).toBe("2026-08-15");
    expect(series.days.filter((day) => day.inRange).map((day) => day.date)).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
    expect(series.days.find((day) => day.date === "2026-08-12")).toMatchObject({
      tokens: "0",
      reported: false,
    });
    expect(series.peakDate).toBe("2026-08-15");
  });

  it("sizes the window to each range", () => {
    const length = (range: "24h" | "7d" | "30d" | "90d") =>
      codexDailyTokenSeries({ fetchedAt, dailyUsageBuckets: buckets, range })!.days.length;
    expect(length("24h")).toBe(14);
    expect(length("30d")).toBe(30);
    expect(length("90d")).toBe(90);
    const today = codexDailyTokenSeries({ fetchedAt, dailyUsageBuckets: buckets, range: "24h" })!;
    expect(today.days.filter((day) => day.inRange).map((day) => day.date)).toEqual(["2026-08-15"]);
  });

  it("is null when no shown day has a bucket", () => {
    expect(
      codexDailyTokenSeries({
        fetchedAt,
        dailyUsageBuckets: [{ startDate: "2026-01-01", tokens: "5" }],
        range: "7d",
      }),
    ).toBeNull();
  });

  it("agrees with the range token total", () => {
    for (const range of ["24h", "7d", "30d", "90d"] as const) {
      const series = codexDailyTokenSeries({ fetchedAt, dailyUsageBuckets: buckets, range })!;
      const inRange = series.days
        .filter((day) => day.inRange)
        .reduce((sum, day) => sum + BigInt(day.tokens), 0n);
      expect(codexAccountRangeTokens({ fetchedAt, dailyUsageBuckets: buckets, range })).toBe(
        inRange.toString(),
      );
    }
    expect(codexAccountRangeTokens({ fetchedAt, dailyUsageBuckets: buckets, range: "7d" })).toBe(
      "75000",
    );
  });
});
