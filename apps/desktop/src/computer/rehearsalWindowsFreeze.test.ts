import { expect, it } from "vitest";
import {
  decodeWindowsFreezeObservation,
  windowsFreezeConfirmed,
  windowsFreezeSupervisorSource,
  type WindowsFreezeObservation,
} from "./rehearsalWindowsFreeze";

const proof: WindowsFreezeObservation = {
  suspended: true,
  threadCount: 5,
  queriedThreads: 5,
  suspendedThreads: 5,
  queryFailures: 0,
  minimumSuspendCount: 1,
  threadSetStable: true,
  timedOut: false,
  elapsedMs: 6,
};
it("requires native suspension of every thread, independently of wait labels", () => {
  expect(windowsFreezeConfirmed(decodeWindowsFreezeObservation(proof))).toBe(true);
  for (const change of [
    { suspended: false },
    { threadCount: 0, queriedThreads: 0, suspendedThreads: 0 },
    { queriedThreads: 4, suspendedThreads: 4 },
    { suspendedThreads: 4, minimumSuspendCount: 0 },
    { queryFailures: 1 },
    { threadSetStable: false },
    { timedOut: true },
    { minimumSuspendCount: 0 },
  ])
    expect(windowsFreezeConfirmed(decodeWindowsFreezeObservation({ ...proof, ...change }))).toBe(
      false,
    );
});
it("rejects malformed counts and drops non-observation data", () => {
  for (const change of [
    { threadCount: 4097 },
    { queriedThreads: 6 },
    { suspendedThreads: 6 },
    { queryFailures: 4098 },
    { minimumSuspendCount: 128 },
    { elapsedMs: -1 },
    { threadCount: 1.5 },
    { timedOut: "false" },
  ])
    expect(() => decodeWindowsFreezeObservation({ ...proof, ...change })).toThrow(
      "Invalid freeze observation",
    );
  expect(
    decodeWindowsFreezeObservation({ ...proof, title: "PRIVATE_SENTINEL", threads: [] }),
  ).toEqual(proof);
  expect(
    windowsFreezeConfirmed(
      decodeWindowsFreezeObservation({
        ...proof,
        threadCount: 0,
        queriedThreads: 0,
        suspendedThreads: 0,
        minimumSuspendCount: 0,
        queryFailures: 1,
        threadSetStable: false,
      }),
    ),
  ).toBe(false);
});
it("cannot interpolate an invalid PID into the supervisor program", () => {
  for (const pid of [0, -1, NaN, Infinity, 1.5])
    expect(() => windowsFreezeSupervisorSource(pid)).toThrow("owned process id");
  expect(windowsFreezeSupervisorSource(123)).toContain("[F5ProcessFreeze]::Run(123)");
});
