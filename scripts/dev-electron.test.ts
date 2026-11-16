import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures: Array<{ root: string; child: ChildProcess; exited: Promise<number | null> }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.child.stdin?.end();
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill("SIGTERM");
    }
    await fixture.exited;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "f5-dev-electron-"));
  const desktop = join(root, "apps/desktop");
  const log = join(root, "launches.jsonl");
  const app = join(root, "fake-electron");
  const bundle = join(desktop, "dist-electron/main.js");
  const write = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  write(bundle, "main");
  write(join(desktop, "dist-electron/preload.js"), "preload");
  write(join(root, "apps/server/dist/index.mjs"), "server");
  write(
    join(root, "node_modules/wait-on/package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  write(join(root, "node_modules/wait-on/index.mjs"), "export default async () => {};");
  write(join(root, "bin/pkill"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin/pkill"), 0o755);
  write(
    app,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", command => process.exit(command.trim() === "crash" ? 1 : 0));
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`,
  );
  chmodSync(app, 0o755);
  write(
    join(desktop, "scripts/electron-launcher.mjs"),
    `export const desktopDir = ${JSON.stringify(desktop)};
export const resolveElectronPath = () => ${JSON.stringify(app)};
`,
  );
  const launcher = join(desktop, "scripts/dev-electron.mjs");
  copyFileSync(resolve(import.meta.dirname, "../apps/desktop/scripts/dev-electron.mjs"), launcher);
  const child = spawn(process.execPath, [launcher], {
    cwd: desktop,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((done, fail) => {
    child.once("exit", (code) => done(code));
    child.once("error", fail);
  });
  fixtures.push({ root, child, exited });
  const launches = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  const waitForLaunches = (count: number) =>
    vi.waitFor(
      () => {
        expect(child.exitCode, stderr).toBeNull();
        expect(launches(), stderr).toBe(count);
      },
      { timeout: 5000 },
    );
  const quit = async () => {
    child.stdin?.write("quit\n");
    await vi.waitFor(() => expect(child.exitCode, stderr).toBe(0), { timeout: 5000 });
  };
  return { child, bundle, launches, waitForLaunches, quit };
}

describe.skipIf(process.platform === "win32")("desktop dev launcher lifecycle", () => {
  it("stops watching after a normal quit so later builds cannot reopen Dev", async () => {
    const h = fixture();
    await h.waitForLaunches(1);
    await h.quit();
    appendFileSync(h.bundle, "\nrebuilt");
    expect(h.launches()).toBe(1);
  }, 15000);

  it("keeps watching after a reload it initiated", async () => {
    const h = fixture();
    await h.waitForLaunches(1);
    appendFileSync(h.bundle, "\nreloaded");
    await h.waitForLaunches(2);
    await h.quit();
  }, 15000);

  it("still recovers an unexpected crash", async () => {
    const h = fixture();
    await h.waitForLaunches(1);
    h.child.stdin?.write("crash\n");
    await h.waitForLaunches(2);
    await h.quit();
  }, 15000);
});
