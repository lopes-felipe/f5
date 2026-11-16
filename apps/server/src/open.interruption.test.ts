import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { launchDetached } from "./open";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("clears the handoff timer and listeners on interruption without killing the detached app", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as never);
  const abort = new AbortController();
  const pending = Effect.runPromise(launchDetached({ command: process.execPath, args: [] }), {
    signal: abort.signal,
  });
  const rejected = expect(pending).rejects.toThrow();
  child.emit("spawn");
  expect(vi.getTimerCount()).toBe(1);
  abort.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount("spawn")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.unref).toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
  expect(() => child.emit("error", new Error("late spawn error"))).not.toThrow();
  expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ stdio: "ignore", detached: true });
});
