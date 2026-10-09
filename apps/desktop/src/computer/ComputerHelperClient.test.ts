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
  it("ignores buffered messages from a retired helper", () => {
    const h = make();
    ready(h);
    const replacement = child();
    vi.mocked(spawn).mockReturnValue(replacement);
    h.client.retry();
    h.emit({ type: "status", status: { available: true } });
    expect(h.client.status()).toMatchObject({ available: false, reason: "helper-missing" });
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
