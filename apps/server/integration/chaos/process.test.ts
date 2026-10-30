import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawnJsonFixture } from "./process.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
// Exercise Windows startup budgets on every host, while response waits stay short.
vi.mock("./timeouts.ts", () => ({ chaosTimeout: (milliseconds: number) => milliseconds * 3 }));

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: 123,
    kill: vi.fn(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    }),
  });
  spawn.mockReturnValue(child);
  return {
    child,
    process: spawnJsonFixture({ script: "fixture.ts", args: [] }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("allows a cold Windows start, then bounds responses and removes timed-out waiters", async () => {
  vi.useFakeTimers();
  const { child, process } = fixture();
  try {
    const started = expect(process.next("ready")).resolves.toMatchObject({ type: "ready" });
    setTimeout(() => child.stdout.write('{"type":"ready"}\n'), 20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await started;

    const timedOut = expect(process.next("state")).rejects.toThrow("response, 15000ms");
    await vi.advanceTimersByTimeAsync(15_000);
    await timedOut;
    const recovered = process.next("state");
    child.stdout.write('{"type":"state","value":"recovered"}\n');
    await expect(recovered).resolves.toMatchObject({ value: "recovered" });
  } finally {
    await process.close();
  }
});

it("fails a missing startup handshake within its budget with fixture diagnostics", async () => {
  vi.useFakeTimers();
  const { child, process } = fixture();
  try {
    child.stderr.write("loading server modules");
    const timedOut = expect(process.next("ready")).rejects.toThrow(
      "startup, 45000ms; fixture.ts; pid 123): loading server modules",
    );
    await vi.advanceTimersByTimeAsync(45_000);
    await timedOut;
  } finally {
    await process.close();
  }
});
