import { expect, it } from "vitest";
import {
  activityForTarget,
  parseLsofProcesses,
  readStorageProcesses,
  inspectStorageActivity,
} from "./storageActivity.ts";
import { spawn } from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

it("detects cwd, open files and browser processes without matching sibling path prefixes", () => {
  const processes = parseLsofProcesses("p123\ncnode\nfcwd\nn/work/repo\nf3\nn/cache/npm/item\n");
  expect(activityForTarget("/work/repo", processes).state).toBe("busy");
  expect(activityForTarget("/cache/npm", processes).state).toBe("busy");
  expect(activityForTarget("/work/rep", processes).state).toBe("idle");
  expect(
    activityForTarget("/cache/chrome", [{ pid: 4, name: "chrome.exe", paths: [] }], "chrome").state,
  ).toBe("busy");
  expect(() => parseLsofProcesses("")).toThrow();
});
it("does not misclassify Electron's cached sample-archive handles as live checkout sessions", () => {
  expect(
    activityForTarget("/old", [
      {
        pid: 1,
        name: "Electron",
        cwd: "/main",
        paths: ["/old/Electron.app/Contents/Resources/default_app.asar"],
      },
    ]).state,
  ).toBe("idle");
  expect(
    activityForTarget("/old", [{ pid: 1, name: "Electron", cwd: "/old", paths: [] }]).state,
  ).toBe("busy");
});
it("detects a real child process holding a checkout as cwd on the host platform", async () => {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-process-"));
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready'); setInterval(()=>{},1000)"],
    { cwd: directory, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", () => resolve());
    });
    const processes = await readStorageProcesses();
    expect(activityForTarget(await FS.realpath(directory), processes).state).toBe("busy");
  } finally {
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill();
    await exited;
    await FS.rm(directory, { recursive: true, force: true });
  }
}, 25_000);

it("detects a real application holding a cache file open while its cwd is elsewhere", async () => {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-open-file-"));
  const target = Path.join(directory, "cache");
  await FS.mkdir(target);
  const file = Path.join(target, "download");
  await FS.writeFile(file, "installer data");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:fs').openSync(process.argv[1],'r+');process.stdout.write('ready');setInterval(()=>{},1000)",
      file,
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", () => resolve());
    });
    expect((await inspectStorageActivity(target)).state).toBe("busy");
  } finally {
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill();
    await exited;
    await FS.rm(directory, { recursive: true, force: true });
  }
}, 25_000);
