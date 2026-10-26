import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerAutomationRequest } from "@t3tools/contracts";
import { ComputerHelperClient } from "./ComputerHelperClient";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const roots: string[] = [];
const clients: ComputerHelperClient[] = [];
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  return process as unknown as ChildProcessWithoutNullStreams;
}
function make() {
  const root = mkdtempSync(join(tmpdir(), "f5-helper-test-"));
  roots.push(root);
  const executable = join(root, "helper");
  writeFileSync(executable, "test");
  const process = child();
  vi.mocked(spawn).mockReturnValue(process);
  const client = new ComputerHelperClient(root, executable);
  clients.push(client);
  client.start();
  const emit = (message: unknown) => process.stdout.emit("data", `${JSON.stringify(message)}\n`);
  return { client, process, emit };
}
function ready(h: ReturnType<typeof make>) {
  h.emit({ type: "hello", protocolVersion: 1, helperVersion: "test" });
  h.emit({ type: "status", status: { available: true, displays: [] } });
}
const extra = { f5Pids: [1], f5BundlePath: "F5", overlayWindowIds: [] };
const request = (requestId: string, op = "type") =>
  ({ requestId, op }) as ComputerAutomationRequest;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});
describe("computer helper supervision", () => {
  it("uses the same exponential backoff for pipe failures as ordinary crashes", async () => {
    const h = make();
    ready(h);
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    h.process.stdin.emit("error", new Error("EPIPE"));
    h.process.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(499);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    replacement.stdin.emit("error", new Error("EPIPE"));
    replacement.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("does not count a timed-out observation twice when its suspend pipe also fails", async () => {
    const h = make();
    ready(h);
    const heartbeat = setInterval(
      () => h.emit({ type: "heartbeat", monitorHealthy: true, suspended: true }),
      250,
    );
    vi.spyOn(h.process.stdin, "write").mockImplementation((chunk) => {
      if (String(chunk).includes('"type":"suspend"')) throw new Error("EPIPE");
      return true;
    });
    const failed = expect(
      h.client.request(request("timeout-pipe", "screenshot"), extra),
    ).rejects.toMatchObject({ error: { _tag: "Execution" } });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    clearInterval(heartbeat);
    vi.mocked(spawn).mockReturnValue(child());
    h.process.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("emits one failure when a terminal helper loses its pipe during nested suspend", async () => {
    const h = make();
    ready(h);
    const failed = expect(h.client.request(request("terminal-pipe"), extra)).rejects.toMatchObject({
      error: { _tag: "OutcomeUnknown" },
    });
    const listener = vi.fn();
    h.client.onEvent(listener);
    vi.spyOn(h.process.stdin, "write").mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    h.emit({ type: "hello", protocolVersion: 999 });
    await failed;
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it.each(["stdin", "stdout", "stderr"] as const)(
    "retires a failed %s pipe and rejects pending work without crashing",
    async (stream) => {
      const h = make();
      ready(h);
      const mutation = h.client.request(request("pipe-mutation"), extra);
      const observation = h.client.request(request("pipe-observation", "screenshot"), extra);
      const mutationFailed = expect(mutation).rejects.toMatchObject({
        error: { _tag: "OutcomeUnknown" },
      });
      const observationFailed = expect(observation).rejects.toMatchObject({
        error: { _tag: "Unavailable", reason: "helper-crashed" },
      });
      expect(() =>
        h.process[stream].emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
      ).not.toThrow();
      await mutationFailed;
      await observationFailed;
      expect(h.client.status()).toMatchObject({ available: false, reason: "helper-crashed" });
      expect(h.process.kill).toHaveBeenCalledWith("SIGKILL");
      const replacement = child();
      vi.mocked(spawn).mockReturnValue(replacement);
      await vi.advanceTimersByTimeAsync(100);
      expect(spawn).toHaveBeenCalledTimes(1);
      h.process.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(499);
      expect(spawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(2);
      replacement.stdout.emit("data", JSON.stringify({ type: "hello", protocolVersion: 1 }) + "\n");
      replacement.stdout.emit(
        "data",
        JSON.stringify({ type: "status", status: { available: true } }) + "\n",
      );
      h.process[stream].emit("error", new Error("late error"));
      expect(h.client.status().available).toBe(true);
      expect(replacement.kill).not.toHaveBeenCalled();
    },
  );
  it("contains a synchronous write failure while acknowledging the helper hello", () => {
    const h = make();
    vi.spyOn(h.process.stdin, "write").mockImplementationOnce(() => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    });
    expect(() =>
      h.process.stdout.emit(
        "data",
        [
          JSON.stringify({ type: "hello", protocolVersion: 1 }),
          JSON.stringify({ type: "status", status: { available: true } }),
          "",
        ].join("\n"),
      ),
    ).not.toThrow();
    expect(h.client.status()).toMatchObject({ available: false, reason: "helper-crashed" });
    expect(h.process.kill).toHaveBeenCalledTimes(1);
  });
  it("handles an asynchronous write callback failure and its stream error only once", async () => {
    const h = make();
    ready(h);
    vi.spyOn(h.process.stdin as PassThrough, "_write").mockImplementationOnce(
      (_chunk, _encoding, done) => {
        done(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      },
    );
    await expect(h.client.request(request("callback-pipe"), extra)).rejects.toMatchObject({
      error: { _tag: "OutcomeUnknown" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.status()).toMatchObject({ available: false, reason: "helper-crashed" });
    expect(h.process.kill).toHaveBeenCalledTimes(1);
  });
  it("rejects work immediately when the writable pipe has already closed", async () => {
    const h = make();
    ready(h);
    h.process.stdin.end();
    await expect(h.client.request(request("closed-pipe"), extra)).rejects.toMatchObject({
      error: { _tag: "OutcomeUnknown" },
    });
    expect(h.client.status().available).toBe(false);
  });
  it("requires the helper exit receipt before confirming rehearsal cleanup", async () => {
    const h = make();
    ready(h);
    const cleanup = h.client.closeAndWait(2000);
    expect(h.process.kill).toHaveBeenCalledWith("SIGKILL");
    h.process.emit("exit", null, "SIGKILL");
    await expect(cleanup).resolves.toBe(true);
  });
  it("reports unconfirmed cleanup when a killed helper has no exit receipt", async () => {
    const h = make();
    ready(h);
    const cleanup = h.client.closeAndWait(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(cleanup).resolves.toBe(false);
  });
  it("preserves bounded capture failure metadata while discarding native messages", async () => {
    const h = make();
    ready(h);
    const pending = h.client.request(request("capture-failure", "screenshot"), extra);
    const failure = expect(pending).rejects.toMatchObject({
      error: {
        _tag: "Unavailable",
        reason: "missing-permissions",
        captureFailure: { stage: "image-capture", domain: "screen-capture-kit", code: -3801 },
      },
    });
    h.emit({
      type: "response",
      requestId: "capture-failure",
      error: {
        _tag: "Unavailable",
        reason: "missing-permissions",
        message: "PRIVATE_SENTINEL",
        captureFailure: {
          stage: "image-capture",
          domain: "screen-capture-kit",
          code: -3801,
          localizedDescription: "PRIVATE_SENTINEL",
        },
      },
    });
    await failure;
    await pending.catch((error) =>
      expect(JSON.stringify(error.error)).not.toContain("PRIVATE_SENTINEL"),
    );
    expect(h.process.kill).not.toHaveBeenCalled();
  });
  it("bounds repeated blocked-worker recovery to three failures and requires Retry", async () => {
    const h = make();
    ready(h);
    let current = h.process;
    const heartbeat = setInterval(
      () =>
        current.stdout.emit(
          "data",
          JSON.stringify({ type: "heartbeat", monitorHealthy: true }) + "\n",
        ),
      250,
    );
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const pending = h.client.request(request(`blocked-${attempt}`, "screenshot"), extra);
        const failed = expect(pending).rejects.toMatchObject({ error: { _tag: "Execution" } });
        await vi.advanceTimersByTimeAsync(10050);
        await failed;
        expect(current.kill).toHaveBeenCalledWith("SIGKILL");
        if (attempt < 2) {
          current = child();
          vi.mocked(spawn).mockReturnValue(current);
          await vi.advanceTimersByTimeAsync(250);
          current.stdout.emit("data", JSON.stringify({ type: "hello", protocolVersion: 1 }) + "\n");
          current.stdout.emit(
            "data",
            JSON.stringify({ type: "status", status: { available: true } }) + "\n",
          );
        }
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(h.client.status()).toMatchObject({ available: false, reason: "helper-crashed" });
      vi.mocked(spawn).mockReturnValue(child());
      h.client.retry();
      current.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(4);
    } finally {
      clearInterval(heartbeat);
    }
  });
  it("replaces blocked observation workers even while hooks keep sending healthy heartbeats", async () => {
    const h = make();
    ready(h);
    const heartbeat = setInterval(
      () => h.emit({ type: "heartbeat", monitorHealthy: true, suspended: true }),
      250,
    );
    const observed = h.client.request(request("blocked", "screenshot"), extra);
    const second = h.client.request(request("blocked-two", "inspect"), extra);
    const failed = expect(observed).rejects.toMatchObject({ error: { _tag: "Execution" } });
    const other = expect(second).rejects.toMatchObject({ error: { _tag: "Unavailable" } });
    await vi.advanceTimersByTimeAsync(10050);
    await failed;
    await other;
    clearInterval(heartbeat);
    expect(h.process.kill).toHaveBeenCalledWith("SIGKILL");
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    await vi.advanceTimersByTimeAsync(250);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(h.client.status().available).toBe(false);
    replacement.stdout.emit("data", JSON.stringify({ type: "hello", protocolVersion: 1 }) + "\n");
    replacement.stdout.emit(
      "data",
      JSON.stringify({ type: "status", status: { available: true } }) + "\n",
    );
    expect(h.client.status().available).toBe(true);
    const writes = (replacement.stdin as PassThrough).read()?.toString() ?? "";
    expect(writes).not.toContain("blocked");
    expect(writes).not.toContain('"type":"resume"');
  });
  it("keeps missing permission detail despite unhealthy heartbeats and deduplicates failure pushes", () => {
    const h = make();
    ready(h);
    const event = vi.fn();
    h.client.onEvent(event);
    h.emit({
      type: "status",
      status: { available: false, reason: "missing-permissions", missing: ["accessibility"] },
    });
    for (let i = 0; i < 4; i++)
      h.emit({ type: "heartbeat", monitorHealthy: false, suspended: true });
    expect(h.client.status()).toMatchObject({
      reason: "missing-permissions",
      missing: ["accessibility"],
    });
    expect(event.mock.calls.filter(([message]) => message.type === "status")).toHaveLength(1);
  });
  it("ignores buffered messages from a retired helper", async () => {
    const h = make();
    ready(h);
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    h.client.retry();
    h.emit({ type: "status", status: { available: true } });
    h.process.emit("exit", null, "SIGKILL");
    expect(h.client.status()).toMatchObject({ available: false, reason: "helper-missing" });
    await vi.advanceTimersByTimeAsync(0);
    replacement.stdout.emit("data", JSON.stringify({ type: "hello", protocolVersion: 1 }) + "\n");
    replacement.stdout.emit(
      "data",
      JSON.stringify({ type: "status", status: { available: true } }) + "\n",
    );
    expect(h.client.status().available).toBe(true);
  });
  it("does not kill a replacement when an old suspend is rejected by retry", async () => {
    const h = make();
    ready(h);
    const suspended = h.client.suspend();
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    h.client.retry();
    h.process.emit("exit", null, "SIGKILL");
    await suspended;
    await vi.advanceTimersByTimeAsync(300);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    replacement.stdout.emit("data", JSON.stringify({ type: "hello", protocolVersion: 1 }) + "\n");
    replacement.stdout.emit(
      "data",
      JSON.stringify({ type: "status", status: { available: true } }) + "\n",
    );
    expect(h.client.status().available).toBe(true);
  });
  it("correlates concurrent responses without retrying mutations", async () => {
    const h = make();
    ready(h);
    const a = h.client.request(request("a"), extra);
    const b = h.client.request(request("b", "screenshot"), extra);
    h.emit({ type: "response", requestId: "b", result: { value: 2 } });
    h.emit({ type: "response", requestId: "a", result: { value: 1 } });
    await expect(a).resolves.toEqual({ value: 1 });
    await expect(b).resolves.toEqual({ value: 2 });
  });
  it("fails pending mutations as ambiguous on heartbeat loss", async () => {
    const h = make();
    ready(h);
    const pending = h.client.request(request("a"), extra);
    const rejected = expect(pending).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(h.client.status()).toMatchObject({ available: false, reason: "monitor-unhealthy" });
  });
  it("recovers from a heartbeat gap once healthy heartbeats resume", async () => {
    const h = make();
    ready(h);
    const event = vi.fn();
    h.client.onEvent(event);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.client.status()).toMatchObject({ available: false, reason: "monitor-unhealthy" });
    // The helper never saw a failure, so it has no new status to push.
    h.emit({ type: "heartbeat", monitorHealthy: true, suspended: true });
    expect(h.client.status()).toEqual({ available: true, displays: [] });
    expect(event).toHaveBeenCalledWith({ type: "status", status: h.client.status() });
  });
  it("waits for the helper's own status after it reports an unhealthy monitor", () => {
    const h = make();
    ready(h);
    h.emit({ type: "heartbeat", monitorHealthy: false, suspended: true });
    h.emit({ type: "status", status: { available: false, reason: "monitor-unhealthy" } });
    h.emit({ type: "heartbeat", monitorHealthy: true, suspended: true });
    expect(h.client.status()).toMatchObject({ available: false, reason: "monitor-unhealthy" });
    h.emit({ type: "status", status: { available: true, displays: [] } });
    expect(h.client.status().available).toBe(true);
  });
  it("does not blame the helper for a stall in its own event loop", async () => {
    const h = make();
    ready(h);
    vi.setSystemTime(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.client.status().available).toBe(true);
    h.emit({ type: "heartbeat", monitorHealthy: true, suspended: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.client.status().available).toBe(true);
  });
  it("preserves protocol mismatch and another-instance failures after exit", () => {
    const h = make();
    h.emit({ type: "hello", protocolVersion: 2 });
    h.process.emit("exit", 1);
    expect(h.client.status()).toMatchObject({ reason: "helper-missing" });
    const second = make();
    ready(second);
    second.emit({ type: "status", status: { available: false, reason: "other-instance" } });
    second.process.emit("exit", 1);
    expect(second.client.status()).toMatchObject({ reason: "other-instance" });
  });
  it("restarts a crash before the hello instead of treating it as a mismatch", async () => {
    const h = make();
    h.process.emit("exit", 1);
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("kills after 50ms without a suspend acknowledgement and starts suspended", async () => {
    const h = make();
    ready(h);
    const suspended = h.client.suspend();
    await vi.advanceTimersByTimeAsync(50);
    await suspended;
    expect(h.process.kill).toHaveBeenCalledWith("SIGKILL");
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    await vi.advanceTimersByTimeAsync(250);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(h.client.status().available).toBe(false);
  });
});

it("rejects malformed helper errors without losing the in-flight mutation", async () => {
  const h = make();
  ready(h);
  const pending = h.client.request(request("malformed"), extra);
  const rejected = expect(pending).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
  h.emit({ type: "response", requestId: "malformed", error: { _tag: "UnknownError" } });
  await rejected;
  expect(h.process.kill).toHaveBeenCalledWith("SIGKILL");
});
it("retry waits for the old worker exit before reacquiring its device lock", async () => {
  const h = make();
  ready(h);
  vi.mocked(spawn).mockReturnValue(child());
  h.client.retry();
  await vi.advanceTimersByTimeAsync(100);
  expect(spawn).toHaveBeenCalledTimes(1);
  h.process.emit("exit", null, "SIGKILL");
  await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledTimes(2);
});
