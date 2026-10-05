import { afterEach, beforeEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { acquireLauncherLease } from "./launcher";
import { atomicJson } from "./files";
let root: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-launcher-test-"));
});
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
  await fs.rm(root, { recursive: true, force: true });
});
it("rejects a second live supervisor and releases only its own lease", async () => {
  const lease = await acquireLauncherLease(root);
  await expect(acquireLauncherLease(root)).rejects.toThrow("already running");
  await lease.release();
  const replacement = await acquireLauncherLease(root);
  await replacement.release();
});
it("recovers a dead launcher lease only after its child has exited", async () => {
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"]);
  children.push(exited);
  await new Promise<void>((resolve) => exited.once("exit", () => resolve()));
  await atomicJson(path.join(root, "launcher.json"), {
    pid: exited.pid,
    token: "interrupted",
    child: null,
  });
  const lease = await acquireLauncherLease(root);
  await lease.release();
});
it("blocks recovery while the orphaned child is still alive", async () => {
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"]);
  children.push(exited);
  await new Promise<void>((resolve) => exited.once("exit", () => resolve()));
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  children.push(child);
  await atomicJson(path.join(root, "launcher.json"), {
    pid: exited.pid,
    token: "interrupted",
    child: child.pid,
  });
  await expect(acquireLauncherLease(root)).rejects.toThrow("still alive");
  await expect(fs.access(path.join(root, "launcher.json"))).resolves.toBeUndefined();
});

it("does not mistake a reused launcher PID with a different birth identity for the old supervisor", async () => {
  await atomicJson(path.join(root, "launcher.json"), {
    pid: process.pid,
    birth: "different-process-birth",
    token: "old",
    child: null,
  });
  const lease = await acquireLauncherLease(root);
  await lease.release();
});
