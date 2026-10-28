import { expect, it } from "vitest";
import {
  collectSchedulingDurations,
  collectTestDurations,
  medianDurations,
  reportArtifact,
  serverTestPath,
} from "./ci-test-timings.ts";

function report(name = "/a/f5/apps/server/src/example.test.ts") {
  return {
    success: true,
    startTime: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTests: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      {
        name,
        status: "passed",
        startTime: 10,
        endTime: 20,
        assertionResults: [{ status: "passed" }],
      },
    ],
  };
}

it("normalizes hosted Windows and Unix paths", () => {
  expect(serverTestPath("D:\\a\\f5\\f5\\apps\\server\\src\\example.test.ts")).toBe(
    "src/example.test.ts",
  );
  expect(serverTestPath("/a/f5/apps/server/src/example.test.ts")).toBe("src/example.test.ts");
  expect(() => serverTestPath("src/../example.test.ts")).toThrow();
});

it("requires a complete, unique, successful inventory before updating timings", () => {
  const expected = ["src/example.test.ts"];
  expect(collectTestDurations([report()], expected)).toEqual({ "src/example.test.ts": 10 });
  expect(() => collectTestDurations([], expected)).toThrow("Missing");
  expect(() => collectTestDurations([report(), report()], expected)).toThrow("Duplicate");
  expect(() => collectTestDurations([report()], [...expected, "src/new.test.ts"])).toThrow(
    "inventory",
  );
  expect(() => collectTestDurations([report()], [])).toThrow("inventory");
  expect(() => collectTestDurations([{ ...report(), success: false }], expected)).toThrow(
    "unsuccessful",
  );
  expect(() => collectTestDurations([{ ...report(), numTotalTests: 2 }], expected)).toThrow(
    "incomplete",
  );
});

it("uses per-file medians across at least three complete samples", () => {
  const samples = [
    { a: 1, b: 90 },
    { a: 100, b: 10 },
    { a: 5, b: 20 },
  ];
  expect(medianDurations(samples)).toEqual({ a: 5, b: 20 });
  expect(() => medianDurations(samples.slice(1))).toThrow("three");
  expect(() => medianDurations([...samples, { a: 1 }])).toThrow("inventories");
  expect(() => medianDurations([...samples, { a: NaN, b: 1 }])).toThrow("Invalid");
});

it("requires complete import-aware metrics alongside successful test reports", () => {
  const expected = ["src/example.test.ts"];
  const metrics = { version: 1, durationsMs: { "/a/f5/apps/server/src/example.test.ts": 1000 } };
  expect(collectSchedulingDurations([report()], [metrics], expected)).toEqual({
    "src/example.test.ts": 1000,
  });
  expect(() => collectSchedulingDurations([report()], [], expected)).toThrow("Missing scheduling");
  expect(() => collectSchedulingDurations([report()], [metrics, metrics], expected)).toThrow(
    "Duplicate",
  );
  expect(() =>
    collectSchedulingDurations([{ ...report(), success: false }], [metrics], expected),
  ).toThrow("unsuccessful");
});

it("maps exact artifact names to their job and individual run attempt", () => {
  expect(reportArtifact("reports-windows-server-unit-Windows-2-3")).toEqual({
    platform: "win32",
    job: "windows-server-unit (3)",
    attempt: 3,
  });
  expect(reportArtifact("reports-server-unit-Linux-0-1")).toEqual({
    platform: "linux",
    job: "server-unit (1)",
    attempt: 1,
  });
  expect(() => reportArtifact("reports-server-unit-FreeBSD-0-1")).toThrow("Unknown");
});
