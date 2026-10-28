import { expect, it } from "vitest";
import { collectTestDurations, serverTestPath } from "./ci-test-timings.ts";

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
