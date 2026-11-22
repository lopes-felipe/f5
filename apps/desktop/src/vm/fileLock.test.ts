import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLock, LockHeld, LockWaitAborted } from "./fileLock";

const onMac = process.platform === "darwin";
let dir: string;
beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-file-lock-"));
});
afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

describe.runIf(onMac)("acquireFileLock (macOS kernel lock)", () => {
  it("admits one holder at a time, even within a process", async () => {
    const path = Path.join(dir, "a.lock");
    const release = await acquireFileLock(path, signal());
    await expect(acquireFileLock(path, signal(), { waitMs: 0 })).rejects.toBeInstanceOf(LockHeld);
    release();
    release();
    const again = await acquireFileLock(path, signal(), { waitMs: 0 });
    again();
  });

  it("is released by the kernel when its holder dies, with no stale file to judge", async () => {
    const path = Path.join(dir, "b.lock");
    // O_EXLOCK | O_NONBLOCK | O_CREAT | O_RDWR, as acquireFileLock opens it.
    const holder = ChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `require("fs").openSync(${JSON.stringify(path)}, 0x20 | 0x4 | 0x200 | 0x2, 0o600); console.log("held"); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
    await expect(acquireFileLock(path, signal(), { waitMs: 50, pollMs: 10 })).rejects.toThrow(
      LockHeld,
    );
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    const release = await acquireFileLock(path, signal(), { waitMs: 1000, pollMs: 10 });
    release();
  });

  it("stops waiting when aborted", async () => {
    const path = Path.join(dir, "c.lock");
    const release = await acquireFileLock(path, signal());
    const controller = new AbortController();
    const waiting = acquireFileLock(path, controller.signal, { pollMs: 10 });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(LockWaitAborted);
    release();
  });

  it("treats errors other than a held lock as final", async () => {
    await expect(acquireFileLock(Path.join(dir, "missing", "d.lock"), signal())).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe.runIf(!onMac)("acquireFileLock off macOS", () => {
  it("refuses: Linux VM profiles run only on macOS", async () => {
    await expect(acquireFileLock(Path.join(dir, "x.lock"), signal())).rejects.toThrow(/macOS/);
  });
});
