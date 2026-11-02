import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthenticationReady, suspendedProbe } from "./preflight";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "f5-readiness-test-"));
  roots.push(root);
  return root;
}
type ExecuteFile = NonNullable<Parameters<typeof codexAuthenticationReady>[1]>;

it("checks login status in the selected home and discards account output", async () => {
  const root = await home();
  await writeFile(join(root, "auth.json"), "{}");
  const execute = vi.fn<ExecuteFile>().mockResolvedValue({
    stdout: "",
    stderr: "Logged in using ChatGPT PRIVATE_ACCOUNT_SENTINEL",
  });
  expect(await codexAuthenticationReady({ binary: "/selected/codex", home: root }, execute)).toBe(
    true,
  );
  expect(execute).toHaveBeenCalledWith(
    "/selected/codex",
    ["login", "status"],
    expect.objectContaining({
      env: expect.objectContaining({ CODEX_HOME: root }),
      timeout: 15000,
    }),
  );
});

it("fails readiness without credentials or when the CLI status probe fails", async () => {
  const root = await home();
  const execute = vi.fn<ExecuteFile>().mockRejectedValue(new Error("PRIVATE_ACCOUNT_SENTINEL"));
  expect(await codexAuthenticationReady({ binary: "/selected/codex", home: root }, execute)).toBe(
    false,
  );
  expect(execute).not.toHaveBeenCalled();
  await writeFile(join(root, "auth.json"), "{}");
  expect(await codexAuthenticationReady({ binary: "/selected/codex", home: root }, execute)).toBe(
    false,
  );
  expect(execute).toHaveBeenCalledOnce();
});

function probeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const start = vi.fn(() => child) as unknown as typeof spawn;
  const pending = suspendedProbe("/fixture/helper", start);
  const message = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, pending, message };
}

it("preserves terminal unavailability when stdin closes after a valid helper status", async () => {
  const { child, pending, message } = probeChild();
  message({ type: "hello", protocolVersion: 1, helperVersion: "test" });
  message({ type: "status", status: { available: false, reason: "other-instance" } });
  child.stdin.emit("error", new Error("PRIVATE_EPIPE_SENTINEL"));
  child.emit("close", 0);
  expect(await pending).toEqual({ available: false, reason: "other-instance" });
  const sent = child.stdin.read()?.toString();
  expect(JSON.parse(sent).request).toEqual({ op: "status", requestId: "suite-preflight" });
  expect(child.kill).toHaveBeenCalledOnce();
});

it("never upgrades a protocol failure with a later status from the same frame", async () => {
  const { child, pending } = probeChild();
  child.stdout.write(
    JSON.stringify({ type: "hello", protocolVersion: 99 }) +
      "\n" +
      JSON.stringify({
        type: "response",
        requestId: "suite-preflight",
        result: { available: true },
      }) +
      "\n",
  );
  child.emit("close", 0);
  expect(await pending).toEqual({ available: false, reason: "helper-crashed" });
});

it("does not credit availability when the helper exits unsuccessfully", async () => {
  const { child, pending, message } = probeChild();
  message({ type: "hello", protocolVersion: 1, helperVersion: "test" });
  message({ type: "response", requestId: "suite-preflight", result: { available: true } });
  child.emit("close", 1);
  expect(await pending).toEqual({ available: false, reason: "helper-crashed" });
});

it("requires a versioned handshake before accepting availability", async () => {
  const { child, pending, message } = probeChild();
  message({ type: "response", requestId: "suite-preflight", result: { available: true } });
  child.emit("close", 0);
  expect(await pending).toEqual({ available: false, reason: "helper-crashed" });
});

it.each(["SIGSEGV", "SIGKILL"])(
  "rejects availability followed by an unexpected %s exit",
  async (signal) => {
    const { child, pending, message } = probeChild();
    message({ type: "hello", protocolVersion: 1, helperVersion: "test" });
    message({ type: "response", requestId: "suite-preflight", result: { available: true } });
    child.emit("close", null, signal);
    expect(await pending).toEqual({ available: false, reason: "helper-crashed" });
  },
);

it("accepts a valid status after the probe's own normal suspension-only exit", async () => {
  const { child, pending, message } = probeChild();
  message({ type: "hello", protocolVersion: 1, helperVersion: "test" });
  message({ type: "response", requestId: "suite-preflight", result: { available: true } });
  child.emit("close", null, "SIGTERM");
  expect(await pending).toEqual({ available: true });
});

it("waits for monitor startup and accepts a healthy push without sending authority", async () => {
  const { child, pending, message } = probeChild();
  message({ type: "hello", protocolVersion: 1, helperVersion: "2.1.0" });
  message({
    type: "response",
    requestId: "suite-preflight",
    result: { available: false, reason: "monitor-unhealthy" },
  });
  message({ type: "status", status: { available: false, reason: "monitor-unhealthy" } });
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdin.read()?.toString()).toBe(
    JSON.stringify({
      type: "request",
      request: { op: "status", requestId: "suite-preflight" },
    }) + "\n",
  );
  message({ type: "status", status: { available: true } });
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit("close", null, "SIGTERM");
  expect(await pending).toEqual({ available: true });
  expect(child.stdin.read()).toBeNull();
});

it("bounds monitor startup and preserves the unhealthy status at the deadline", async () => {
  vi.useFakeTimers();
  const { child, pending, message } = probeChild();
  message({ type: "hello", protocolVersion: 1, helperVersion: "2.1.0" });
  message({ type: "status", status: { available: false, reason: "monitor-unhealthy" } });
  await vi.advanceTimersByTimeAsync(4999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledOnce();
  message({ type: "status", status: { available: true } });
  child.emit("close", null, "SIGTERM");
  expect(await pending).toEqual({ available: false, reason: "monitor-unhealthy" });
});

it("stops immediately on terminal unavailability during monitor startup", async () => {
  const { child, pending, message } = probeChild();
  message({ type: "hello", protocolVersion: 1, helperVersion: "2.1.0" });
  message({ type: "status", status: { available: false, reason: "monitor-unhealthy" } });
  message({ type: "status", status: { available: false, reason: "missing-permissions" } });
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit("close", null, "SIGTERM");
  expect(await pending).toEqual({ available: false, reason: "missing-permissions" });
});
