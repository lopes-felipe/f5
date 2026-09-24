import { expect, it } from "vitest";
import { validateCoverage } from "./coverage.ts";
import type { PerformanceReport } from "./report.ts";

it("does not confuse a single report or a short soak with complete coverage", () => {
  expect(validateCoverage([])).toContain("Complete coverage requires exactly two reports");
  const report = {
    scope: "interactive",
    mode: "measurement",
    method: { warmups: 5, repetitions: 30 },
    measurements: {},
    metadata: {},
    observations: [],
  } as unknown as PerformanceReport;
  const errors = validateCoverage([report]);
  expect(errors).toContain("Expected exactly one server-component report");
  expect(errors).toContain("Incomplete measurement: browser.composer-input");
  expect(errors).toContain("Incomplete 10-minute memory measurement");
  expect(validateCoverage([report, report])).toContain("Expected exactly one interactive report");
});
