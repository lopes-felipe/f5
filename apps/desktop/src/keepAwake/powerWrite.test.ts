import { expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTrackedPowerWrite } from "./powerWrite";

it.skipIf(process.platform === "win32")(
  "does not report completion while a terminated writer can still change the flag",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "f5-power-write-"));
    const script = join(dir, "writer");
    const entered = join(dir, "entered"),
      release = join(dir, "release"),
      flag = join(dir, "flag");
    await writeFile(
      script,
      "#!/bin/sh\ntrap '' TERM\ntouch '" +
        entered +
        "'\nwhile [ ! -f '" +
        release +
        "' ]; do sleep 0.02; done\nprintf 1 > '" +
        flag +
        "'\n",
      { mode: 0o700 },
    );
    let pid = 0,
      done = false;
    const operation = runTrackedPowerWrite(
      script,
      [],
      async (value) => {
        pid = value;
      },
      30_000,
    ).then((result) => {
      done = true;
      return result;
    });
    try {
      for (let i = 0; i < 1500; i++) {
        if (done) throw new Error(JSON.stringify(await operation));
        try {
          await access(entered);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await access(entered);
      process.kill(-pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(done).toBe(false);
      await writeFile(release, "");
      expect((await operation).ok).toBe(false);
      expect(await readFile(flag, "utf8")).toBe("1");
    } finally {
      await writeFile(release, "");
      await operation;
      await rm(dir, { recursive: true, force: true });
    }
  },
  45_000,
);
