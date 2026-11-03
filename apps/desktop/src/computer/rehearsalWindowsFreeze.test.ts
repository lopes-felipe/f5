import { expect, it, vi, afterEach } from "vitest";
import {
  decodeWindowsFreezeObservation,
  windowsFreezeConfirmed,
  windowsFreezeSupervisorSource,
  type WindowsFreezeObservation,
  WindowsFreezeChannel,
} from "./rehearsalWindowsFreeze";
afterEach(() => vi.useRealTimers());

it("serializes STATUS and timer-triggered RESUME replies", async () => {
  const write = vi.fn();
  const channel = new WindowsFreezeChannel(write, vi.fn());
  const ready = channel.ready();
  channel.receive("READY");
  await ready;
  const status = channel.command("STATUS");
  const resume = channel.command("RESUME");
  await Promise.resolve();
  expect(write.mock.calls).toEqual([["STATUS\n"]]);
  channel.receive(JSON.stringify(proof));
  expect(await status).toBe(JSON.stringify(proof));
  await Promise.resolve();
  expect(write.mock.calls).toEqual([["STATUS\n"], ["RESUME\n"]]);
  channel.receive("RESUMED");
  expect(await resume).toBe("RESUMED");
});

it("breaks the channel on timeout and rejects queued work and stale replies", async () => {
  vi.useFakeTimers();
  const write = vi.fn(),
    disconnect = vi.fn();
  const channel = new WindowsFreezeChannel(write, disconnect);
  const first = channel.command("STATUS");
  const next = channel.command("RESUME");
  const failed = expect(first).rejects.toThrow("timed out");
  const queuedFailed = expect(next).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  await queuedFailed;
  channel.receive(JSON.stringify(proof));
  await expect(channel.command("STATUS")).rejects.toThrow("timed out");
  expect(write.mock.calls).toEqual([["STATUS\n"]]);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

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
