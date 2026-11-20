import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { launchDetached, resolveFileManagerRevealLaunch } from "./open";
import * as commandResolution from "./spawn/resolveCommand.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([
  [
    "native",
    "C:/workspace with spaces/file.ts",
    true,
    '/select,"C:\\workspace with spaces\\file.ts"',
  ],
  [
    "npmShim",
    "C:/workspace with spaces/file.ts",
    false,
    '/select,"C:\\workspace with spaces\\file.ts"',
  ],
  ["native", 'C:/workspace/file"name.ts', false, '/select,C:\\workspace\\file"name.ts'],
] as const)(
  "passes the Explorer argument to a %s launcher for %s",
  async (kind, target, verbatim, arg) => {
    vi.spyOn(commandResolution, "isCommandAvailable").mockReturnValue(true);
    vi.spyOn(commandResolution, "resolveInvocation").mockImplementation((_command, args) => ({
      file: "resolved-launcher",
      args: [...args],
      kind,
    }));
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = Effect.runPromise(
      launchDetached(resolveFileManagerRevealLaunch(target, "win32"), false),
    );
    child.emit("spawn");
    await pending;
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "resolved-launcher",
      [arg],
      expect.objectContaining({ windowsVerbatimArguments: verbatim }),
    );
  },
);

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
