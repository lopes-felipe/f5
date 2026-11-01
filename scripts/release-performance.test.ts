import { expect, it } from "vitest";
import { performanceResult, type ReleaseSample } from "./release-performance.ts";
const sample = (index: number, seconds: number): ReleaseSample => ({
  version: "0.1.2-beta." + index,
  sourceSha: "a".repeat(40),
  summaryRun: index,
  publishedAt: new Date(index * 1000).toISOString(),
  seconds,
});
it("requires three routine samples and keeps the earliest consecutive releases", () => {
  expect(performanceResult([sample(1, 1200)]).status).toBe("waiting-for-samples");
  const result = performanceResult([
    sample(4, 900),
    sample(2, 1800),
    sample(1, 1200),
    sample(3, 1500),
    sample(2, 1800),
  ]);
  expect(result.samples.map((s) => s.version)).toEqual([
    "0.1.2-beta.1",
    "0.1.2-beta.2",
    "0.1.2-beta.3",
  ]);
  expect(result.medianSeconds).toBe(1500);
  expect(result.status).toBe("met");
});
it("leaves missed performance targets explicit with a capacity follow-up", () => {
  const result = performanceResult([sample(1, 1800), sample(2, 1900), sample(3, 1200)]);
  expect(result.status).toBe("unmet");
  expect(result.medianSeconds).toBe(1800);
  expect(result.nextAction).toContain("Do not purchase runners or relax gates");
});
