import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createLidOwnership, processStart, type LidMarker } from "./lidOwnership";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const canInspectProcesses =
  process.platform === "darwin" &&
  spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)]).status === 0;
if (process.env.F5_REQUIRE_NATIVE_WATCHDOG_TESTS === "1" && !canInspectProcesses)
  throw new Error("Native watchdog tests require macOS process inspection; refusing to skip in CI");
describe.skipIf(!canInspectProcesses)("detached lid watchdog (requires process inspection)", () => {
  it.each(["dead", "replaced", "different-start", "alive"] as const)(
    "handles %s owner generation",
    async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), "f5-watchdog-"));
      directories.push(dir);
      const markerPath = join(dir, "marker.json");
      const log = join(dir, "reset");
      const sudo = join(dir, "sudo");
      const pmset = join(dir, "pmset");
      await writeFile(sudo, "#!/bin/sh\n/usr/bin/touch '" + log + "'\n", { mode: 0o700 });
      await writeFile(
        pmset,
        "#!/bin/sh\nprintf 'System-wide power settings:\\n SleepDisabled 0\\n'\n",
        { mode: 0o700 },
      );
      const ownership = createLidOwnership(markerPath, { sudo, pmset });
      const owner = spawn("/bin/sleep", ["30"]);
      try {
        const start = await processStart(owner.pid!);
        let marker = { ...(await ownership.newMarker()), ownerPid: owner.pid!, ownerStart: start };
        if (scenario === "different-start") marker.ownerStart = "different identity";
        await ownership.write(marker);
        marker = await ownership.armWatchdog(marker);
        if (scenario === "alive") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(await ownership.watchdogAlive(marker)).toBe(true);
          await expect(access(log)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (scenario === "replaced") {
          await ownership.write({ ...marker, gen: "11111111-1111-4111-8111-111111111111" });
        }
        owner.kill();
        const deadline = Date.now() + 7000;
        while (Date.now() < deadline && (await ownership.watchdogAlive(marker)))
          await new Promise((resolve) => setTimeout(resolve, 100));
        await ownership.killWatchdog(marker);
        if (scenario === "replaced") {
          await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
          expect(JSON.parse(await readFile(markerPath, "utf8")).gen).not.toBe(marker.gen);
        } else {
          await expect(readFile(log)).resolves.toBeDefined();
          await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        owner.kill();
      }
    },
    10_000,
  );
  it("keeps real process identity stable across timezone changes", async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const first = await processStart(process.pid);
      process.env.TZ = "Europe/Berlin";
      expect(first).not.toBe("");
      expect(await processStart(process.pid)).toBe(first);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it("waits for a journaled enable writer after its owner dies before resetting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "f5-watchdog-writer-"));
    directories.push(dir);
    const path = join(dir, "marker"),
      flag = join(dir, "flag"),
      log = join(dir, "reset");
    const release = join(dir, "release"),
      sudo = join(dir, "sudo"),
      pmset = join(dir, "pmset");
    await writeFile(sudo, "#!/bin/sh\nprintf 0 > '" + flag + "'\ntouch '" + log + "'\n", {
      mode: 0o700,
    });
    await writeFile(
      pmset,
      "#!/bin/sh\nprintf 'System-wide power settings:\\n SleepDisabled 0\\n'\n",
      { mode: 0o700 },
    );
    const owner = spawn("/bin/sleep", ["30"]);
    const writer = spawn(
      "/bin/sh",
      ["-c", "while [ ! -f '" + release + "' ]; do sleep 0.02; done\nprintf 1 > '" + flag + "'\n"],
      { detached: true, stdio: "ignore" },
    );
    const ownership = createLidOwnership(path, { sudo, pmset });
    let marker: LidMarker = {
      ...(await ownership.newMarker()),
      ownerPid: owner.pid!,
      ownerStart: await processStart(owner.pid!),
      writerPid: writer.pid!,
      writerStart: await processStart(writer.pid!),
    };
    try {
      await ownership.write(marker);
      marker = await ownership.armWatchdog(marker);
      owner.kill();
      await new Promise((resolve) => setTimeout(resolve, 5500));
      await expect(access(log)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(release, "");
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        try {
          await access(log);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(await readFile(flag, "utf8")).toBe("0");
    } finally {
      owner.kill();
      await writeFile(release, "");
      await ownership.killWatchdog(marker);
    }
  }, 20_000);
});
