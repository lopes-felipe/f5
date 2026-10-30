import { expect, it } from "vitest";
import {
  activityForTarget,
  parseLsofProcesses,
  readStorageProcesses,
  inspectStorageActivity,
  linuxMappedPaths,
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
it("matches Chrome executable names without blocking unrelated Chrome-named applications", () => {
  expect(
    activityForTarget("/cache", [{ pid: 1, name: "ChatGPT for Chrome", paths: [] }], "chrome")
      .state,
  ).toBe("idle");
  expect(
    activityForTarget(
      "/cache",
      [{ pid: 1, name: "Google Chrome Helper (Renderer)", paths: [] }],
      "chrome",
    ).state,
  ).toBe("busy");
});
it("parses Linux file-backed mappings, escaped filenames and deleted mappings", () => {
  expect(
    linuxMappedPaths(
      "7f00-7f01 r--p 0000 08:01 123 /work/lib\\040copy.so (deleted)\n7f01-7f02 rw-p 0000 00:00 0 [heap]\n",
    ),
  ).toEqual(["/work/lib copy.so"]);
});
it.runIf(process.platform === "linux")(
  "detects a real running executable outside its working directory",
  async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-executable-"));
    const binary = Path.join(directory, "running-node");
    await FS.copyFile(process.execPath, binary);
    await FS.chmod(binary, 0o755);
    const child = spawn(binary, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      cwd: OS.tmpdir(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
      });
      expect((await inspectStorageActivity(directory)).state).toBe("busy");
    } finally {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      await closed;
      await FS.rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);
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
  // Exercise multi-file JSON input to Windows PowerShell as well as an open handle.
  await FS.writeFile(Path.join(target, "another-download"), "other cached bytes");
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

it.runIf(process.platform === "linux")(
  "detects a file-backed mapping after its descriptor is closed",
  async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-mapping-"));
    const file = Path.join(directory, "mapped-library");
    await FS.writeFile(file, Buffer.alloc(4096));
    const child = spawn(
      "python3",
      [
        "-c",
        "import ctypes,os,sys,time; lib=ctypes.CDLL(None); lib.mmap.restype=ctypes.c_void_p; fd=os.open(sys.argv[1],os.O_RDONLY); lib.mmap(None,4096,1,2,fd,0); os.close(fd); print('ready',flush=True); time.sleep(60)",
        file,
      ],
      { cwd: OS.tmpdir(), stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
      });
      const fds = await FS.readdir("/proc/" + child.pid + "/fd");
      const openPaths = await Promise.all(
        fds.map((fd) => FS.readlink("/proc/" + child.pid + "/fd/" + fd).catch(() => "")),
      );
      expect(openPaths).not.toContain(file);
      expect((await inspectStorageActivity(directory)).state).toBe("busy");
    } finally {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      await closed;
      await FS.rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);
