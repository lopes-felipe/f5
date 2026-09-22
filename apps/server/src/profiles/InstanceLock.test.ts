import { spawn } from "node:child_process";
import { once } from "node:events";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock, ProfileBusyError } from "./InstanceLock";

describe("OS-held profile locks", () => {
  it("never displaces an idle child and releases exclusion after process death", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-lock-"));
    const path = Path.join(root, "profile.lock.sqlite");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE owner(pid); INSERT INTO owner VALUES (' + process.pid + ')');
      fs.writeFileSync(process.argv[1]+'.owner', String(process.pid));
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `,
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout!, "data");
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(acquireInstanceLock(path)).rejects.toMatchObject({
          _tag: "ProfileBusyError",
          pid: child.pid,
        });
      }
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const lock = await acquireInstanceLock(path);
      await expect(acquireInstanceLock(path)).rejects.toBeInstanceOf(ProfileBusyError);
      lock.release();
      (await acquireInstanceLock(path)).release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await FS.rm(root, { recursive: true, force: true });
    }
  });
  it("fails closed when the lock cannot be opened", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-lock-error-"));
    try {
      await expect(acquireInstanceLock(root)).rejects.toMatchObject({ _tag: "ProfileLockError" });
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
});
